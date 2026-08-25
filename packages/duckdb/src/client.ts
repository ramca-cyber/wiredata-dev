/**
 * DuckDB-WASM Client
 *
 * There is exactly one SQL engine here — real DuckDB-WASM, self-hosted (see
 * apps/extension/vite.config.ts's duckdbAssetsPlugin and resolveAssetUrl
 * below). There used to be a second, hand-rolled regex-based SQL engine that
 * silently took over whenever DuckDB failed to initialize or a query threw.
 * It's gone: once DuckDB-WASM was actually fixed (self-hosted MVP bundle
 * with fully-qualified asset URLs, rather than the CDN load that never
 * completed), that fallback stopped being a safety net and started being a
 * liability — it could silently return a *different, wrong* answer for a
 * query DuckDB would have rejected or answered correctly (no JOINs, one
 * WHERE clause, three aggregate functions, no HAVING). Now a real DuckDB
 * error propagates as a real error, and the engine being unavailable is a
 * visible state (isEngineReady/engineError) rather than something papered
 * over.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { applyParseRule, ColumnDefinition, ColumnParseRule, ExtractedRow, LogicalType } from '@wiredata/core';

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  durationMs: number;
}

export interface ParseRuleSuggestion {
  column: string;
  rule: ColumnParseRule;
  label: string;
  /** Share of non-empty sampled values the rule successfully parsed, 0..1. */
  confidence: number;
  sampleBefore: string[];
  sampleAfter: unknown[];
  /**
   * Populated only for genuinely ambiguous date columns — e.g. every row's
   * day value is ≤12, so MM/DD/YYYY and DD/MM/YYYY both parse successfully
   * but disagree on the actual date. Rather than guess, both are listed
   * here and neither is treated as "the" suggestion; the caller must ask.
   */
  alternatives?: ParseRuleSuggestion[];
}

interface ParseHypothesis {
  rule: ColumnParseRule;
  label: string;
  /** A boolean-ish SQL expression (NULL on failure) referencing "col". */
  predicate: (col: string) => string;
  isDate?: boolean;
}

// Every hypothesis is a real DuckDB expression — TRY_CAST / TRY_STRPTIME do
// the actual parsing-validity check, not a hand-rolled regex. Unicode minus
// (CHR(8722), used by e.g. Wikipedia) is normalized to ASCII '-' up front.
const UNICODE_MINUS_SQL = (col: string) => `REPLACE("${col}", CHR(8722), '-')`;

const NUMBER_HYPOTHESES: ParseHypothesis[] = [
  {
    rule: { kind: 'number' },
    label: 'Number',
    predicate: col => `TRY_CAST(REPLACE(${UNICODE_MINUS_SQL(col)}, ',', '') AS DOUBLE)`,
  },
  {
    rule: { kind: 'number', thousands_separator: '.', decimal_separator: ',' },
    label: 'Number (European format, e.g. 1.234,56)',
    predicate: col => `TRY_CAST(REPLACE(REPLACE(${UNICODE_MINUS_SQL(col)}, '.', ''), ',', '.') AS DOUBLE)`,
  },
  ...(['$', '€', '£'] as const).map(sym => ({
    rule: { kind: 'number' as const, currency_symbol: sym },
    label: `Currency (${sym})`,
    predicate: (col: string) => `TRY_CAST(REPLACE(REPLACE(${UNICODE_MINUS_SQL(col)}, '${sym}', ''), ',', '') AS DOUBLE)`,
  })),
];

const PERCENT_HYPOTHESIS: ParseHypothesis = {
  rule: { kind: 'percent' },
  label: 'Percent',
  // Require a literal '%' in the value — otherwise this is indistinguishable
  // from a plain number and shouldn't be labeled "percent".
  predicate: col => `(CASE WHEN POSITION('%' IN "${col}") > 0 THEN TRY_CAST(REPLACE(${UNICODE_MINUS_SQL(col)}, '%', '') AS DOUBLE) ELSE NULL END)`,
};

const DATE_HYPOTHESES: ParseHypothesis[] = [
  { rule: { kind: 'date', date_format: 'YYYY-MM-DD' }, label: 'Date (YYYY-MM-DD)', predicate: col => `TRY_CAST("${col}" AS DATE)`, isDate: true },
  { rule: { kind: 'date', date_format: 'MM/DD/YYYY' }, label: 'Date (MM/DD/YYYY)', predicate: col => `TRY_STRPTIME("${col}", '%m/%d/%Y')`, isDate: true },
  { rule: { kind: 'date', date_format: 'DD/MM/YYYY' }, label: 'Date (DD/MM/YYYY)', predicate: col => `TRY_STRPTIME("${col}", '%d/%m/%Y')`, isDate: true },
  { rule: { kind: 'date', date_format: 'MM-DD-YYYY' }, label: 'Date (MM-DD-YYYY)', predicate: col => `TRY_STRPTIME("${col}", '%m-%d-%Y')`, isDate: true },
  { rule: { kind: 'date', date_format: 'DD-MM-YYYY' }, label: 'Date (DD-MM-YYYY)', predicate: col => `TRY_STRPTIME("${col}", '%d-%m-%Y')`, isDate: true },
];

const ALL_HYPOTHESES = [...NUMBER_HYPOTHESES, PERCENT_HYPOTHESIS, ...DATE_HYPOTHESES];
const CONFIDENCE_THRESHOLD = 0.9;

function mapLogicalTypeToDuckDB(type: LogicalType): string {
  switch (type) {
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'BIGINT':
      return 'BIGINT';
    case 'DOUBLE':
      return 'DOUBLE';
    case 'DECIMAL':
      return 'DECIMAL(18, 4)';
    case 'DATE':
      return 'DATE';
    case 'TIMESTAMP':
      return 'TIMESTAMP';
    case 'JSON':
      return 'VARCHAR';
    case 'VARCHAR':
    default:
      return 'VARCHAR';
  }
}

export class DuckDBClient {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private initError: string | null = null;

  /** True once DuckDB-WASM has actually initialized and can run real SQL. */
  get isEngineReady(): boolean {
    return this.conn !== null;
  }

  /** Why the engine isn't available, if init() failed. Null once ready. */
  get engineError(): string | null {
    return this.initError;
  }

  /**
   * Resolves one of the two self-hosted DuckDB-WASM MVP assets. Never a CDN:
   * cdn.jsdelivr.net never actually initializes here (confirmed — it throws
   * "duckdb is not initialized" even outside any CSP-restricted context) and
   * would violate this project's zero-cloud-backend invariant and the
   * packaged extension's script-src 'self' CSP regardless.
   *
   * chrome.runtime.getURL is required inside the packaged extension — its
   * pages are served from chrome-extension://<id>/, not http(s)://. And the
   * URL must be fully qualified even in dev: DuckDB's createWorker() blob-
   * wraps the worker script (URL.createObjectURL), so the worker's own
   * global scope has a blob: URL as its base — a root-relative path fails
   * to resolve against that base ("Failed to construct 'Request'"), while a
   * fully-qualified absolute URL needs no relative resolution at all.
   */
  private resolveAssetUrl(path: string): string {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(path);
    }
    return new URL(`/${path}`, window.location.origin).href;
  }

  async init(): Promise<void> {
    if (this.conn || this.initError) return;

    try {
      if (typeof window === 'undefined' || typeof Worker === 'undefined') {
        throw new Error('WebAssembly Worker support is not available in this context.');
      }
      const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
        mvp: {
          mainModule: this.resolveAssetUrl('duckdb/duckdb-mvp.wasm'),
          mainWorker: this.resolveAssetUrl('duckdb/duckdb-browser-mvp.worker.js'),
        },
      };
      const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
      const worker = await duckdb.createWorker(bundle.mainWorker!);
      const logger = new duckdb.ConsoleLogger();
      this.db = new duckdb.AsyncDuckDB(logger, worker);
      await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      this.conn = await this.db.connect();
    } catch (err: any) {
      this.initError = err?.message || String(err);
      console.error('DuckDB-WASM failed to initialize — SQL querying is unavailable:', this.initError);
    }
  }

  /**
   * Registers a dataset snapshot and its provenance relation as real DuckDB
   * tables. Columns are TRY_CAST to the schema's declared logical_type
   * (computed once, with full lineage/type_override context, in
   * buildDatasetSnapshot) rather than left to read_json_auto's independent
   * guess — otherwise a user's type_override could be silently ignored
   * whenever the underlying JSON value's native type suggested something
   * else. TRY_CAST (not CAST) so a column's tracked type_anomalies become
   * NULL in this SQL view instead of failing the whole registration.
   */
  async registerDataset(
    tableName: string,
    schema: Record<string, ColumnDefinition>,
    rows: ExtractedRow[]
  ): Promise<void> {
    if (!this.conn || !this.db) {
      throw new Error('DuckDB engine is not available — cannot register dataset.');
    }

    const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
    const visibleCols = Object.entries(schema).filter(([, def]) => def.is_visible);

    const plainRows = rows.map(r => {
      const obj: Record<string, any> = {};
      for (const [colName] of visibleCols) {
        const val = r.values[colName] ?? null;
        // Nested object/array values (nested_array_policy: 'json') must be
        // stringified before serialization, so the JSON file always carries
        // a plain string for these columns and TRY_CAST(... AS VARCHAR)
        // never has to convert a DuckDB STRUCT/LIST itself.
        obj[colName] = typeof val === 'object' && val !== null ? JSON.stringify(val) : val;
      }
      return obj;
    });

    const provRows = rows.map(r => ({
      ...r.values,
      __ndw_row_id: r.row_id,
      __ndw_capture_id: r.lineage.capture_id,
      __ndw_record_pointer: r.lineage.record_pointer,
      __ndw_captured_at: r.lineage.captured_at,
      __ndw_request_url: r.lineage.request_url,
    }));

    await this.db.registerFileText(`_${safeName}.json`, JSON.stringify(plainRows));
    await this.db.registerFileText(`_${safeName}__provenance.json`, JSON.stringify(provRows));

    const castColumns = visibleCols
      .map(([colName, def]) => `TRY_CAST("${colName}" AS ${mapLogicalTypeToDuckDB(def.logical_type)}) AS "${colName}"`)
      .join(', ');

    await this.conn.query(`DROP TABLE IF EXISTS "${safeName}"`);
    await this.conn.query(
      castColumns
        ? `CREATE TABLE "${safeName}" AS SELECT ${castColumns} FROM read_json_auto('_${safeName}.json')`
        : `CREATE TABLE "${safeName}" AS SELECT * FROM read_json_auto('_${safeName}.json')`
    );

    await this.conn.query(`DROP TABLE IF EXISTS "${safeName}__provenance"`);
    await this.conn.query(
      `CREATE TABLE "${safeName}__provenance" AS SELECT * FROM read_json_auto('_${safeName}__provenance.json')`
    );
  }

  /**
   * Tests candidate parse rules against real raw text values — e.g. a DOM
   * capture's scraped cells, which are always strings regardless of what
   * they represent — using DuckDB's own TRY_CAST/TRY_STRPTIME rather than
   * hand-rolled regex, and returns a suggestion per column that's confident
   * enough to propose (≥90% of non-empty values parse successfully). This
   * never applies anything: it's read-only against a throwaway temp table,
   * and the caller decides whether to confirm a suggestion (which persists
   * it as a ColumnParseRule on the dataset definition — see
   * packages/core/src/inference/parse-rules.ts's applyParseRule, the
   * deterministic function that actually runs once confirmed).
   */
  async suggestParseRules(columnValues: Record<string, string[]>): Promise<ParseRuleSuggestion[]> {
    if (!this.conn || !this.db) {
      throw new Error('DuckDB engine is not available — cannot suggest parse rules.');
    }

    const columns = Object.keys(columnValues);
    if (columns.length === 0) return [];

    const rowCount = Math.max(...columns.map(c => columnValues[c].length));
    const rows: Record<string, string>[] = [];
    for (let i = 0; i < rowCount; i++) {
      const row: Record<string, string> = {};
      for (const col of columns) row[col] = columnValues[col][i] ?? '';
      rows.push(row);
    }

    const sniffId = `_sniff_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    await this.db.registerFileText(`${sniffId}.json`, JSON.stringify(rows));
    await this.conn.query(`CREATE TEMP TABLE "${sniffId}" AS SELECT * FROM read_json_auto('${sniffId}.json')`);

    try {
      const selectParts: string[] = [];
      for (const col of columns) {
        selectParts.push(`count(*) FILTER (WHERE "${col}" IS NOT NULL AND "${col}" != '') AS "${col}____non_empty"`);
        ALL_HYPOTHESES.forEach((hyp, i) => {
          selectParts.push(`count(*) FILTER (WHERE ${hyp.predicate(col)} IS NOT NULL) AS "${col}____h${i}"`);
        });
      }

      const result = await this.conn.query(`SELECT ${selectParts.join(', ')} FROM "${sniffId}"`);
      const counts = result.toArray()[0].toJSON();

      const suggestions: ParseRuleSuggestion[] = [];
      for (const col of columns) {
        const nonEmpty = Number(counts[`${col}____non_empty`]);
        if (nonEmpty === 0) continue;

        const qualifying = ALL_HYPOTHESES.map((hyp, i) => ({
          hyp,
          confidence: Number(counts[`${col}____h${i}`]) / nonEmpty,
        })).filter(h => h.confidence >= CONFIDENCE_THRESHOLD);

        if (qualifying.length === 0) continue;

        const sampleValues = columnValues[col].filter(v => v.trim() !== '').slice(0, 5);
        const toSuggestion = (hyp: ParseHypothesis, confidence: number): ParseRuleSuggestion => ({
          column: col,
          rule: hyp.rule,
          label: hyp.label,
          confidence,
          sampleBefore: sampleValues,
          sampleAfter: sampleValues.map(v => applyParseRule(v, hyp.rule)),
        });

        const qualifyingDates = qualifying.filter(q => q.hyp.isDate);
        if (qualifyingDates.length > 1) {
          // Genuinely ambiguous (e.g. every day value happens to be ≤12) —
          // list every candidate, pick none.
          const alts = qualifyingDates.map(q => toSuggestion(q.hyp, q.confidence));
          suggestions.push({ ...alts[0], alternatives: alts });
          continue;
        }

        const best = qualifying.reduce((a, b) => (b.confidence > a.confidence ? b : a));
        suggestions.push(toSuggestion(best.hyp, best.confidence));
      }

      return suggestions;
    } finally {
      await this.conn.query(`DROP TABLE IF EXISTS "${sniffId}"`).catch(() => {});
    }
  }

  async query(sql: string): Promise<QueryResult> {
    if (!this.conn) {
      throw new Error(
        this.initError ? `SQL engine unavailable: ${this.initError}` : 'SQL engine is not ready yet.'
      );
    }

    const start = performance.now();
    const arrowTable = await this.conn.query(sql);
    const rows = arrowTable.toArray().map(row => row.toJSON());
    const columns = arrowTable.schema.fields.map(f => f.name);

    return {
      columns,
      rows,
      rowCount: rows.length,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  /** Real Parquet, via DuckDB's own COPY — not a JSON blob wearing a .parquet name. */
  async exportParquet(tableName: string): Promise<Uint8Array> {
    if (!this.conn || !this.db) {
      throw new Error('DuckDB engine is not available — cannot export Parquet.');
    }

    const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
    const fileName = `export_${safeName}.parquet`;

    await this.conn.query(`COPY "${safeName}" TO '${fileName}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    return await this.db.copyFileToBuffer(fileName);
  }

  terminate(): void {
    if (this.conn) {
      this.conn.close().catch(() => {});
      this.conn = null;
    }
    if (this.db) {
      this.db.terminate().catch(() => {});
      this.db = null;
    }
  }
}
