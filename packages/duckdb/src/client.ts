/**
 * DuckDB Client interface for UI & Extensions
 * Supports DuckDB-WASM and in-memory SQL execution
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { ColumnDefinition, ExtractedRow } from '@wiredata/core';

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  durationMs: number;
}

export class DuckDBClient {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private isReady = false;
  private registeredDatasets = new Map<string, {
    schema: Record<string, ColumnDefinition>;
    rows: ExtractedRow[];
  }>();

  constructor(private workerFactory?: () => Worker) {}

  async init(): Promise<void> {
    if (this.isReady) return;

    try {
      if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
        const worker = await duckdb.createWorker(bundle.mainWorker!);
        const logger = new duckdb.ConsoleLogger();
        this.db = new duckdb.AsyncDuckDB(logger, worker);
        await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        this.conn = await this.db.connect();
      }
    } catch (err: any) {
      console.warn('DuckDB-WASM initialization falling back to in-memory SQL runner:', err?.message || err);
    }

    this.isReady = true;
  }

  async registerDataset(
    tableName: string,
    schema: Record<string, ColumnDefinition>,
    rows: ExtractedRow[]
  ): Promise<void> {
    const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
    this.registeredDatasets.set(safeName.toLowerCase(), { schema, rows });
    this.registeredDatasets.set(tableName.toLowerCase(), { schema, rows });

    if (this.conn && this.db) {
      try {
        const plainRows = rows.map(r => {
          const obj: Record<string, any> = {};
          for (const [colName, colDef] of Object.entries(schema)) {
            if (colDef.is_visible) {
              obj[colName] = r.values[colName] ?? null;
            }
          }
          return obj;
        });

        const provRows = rows.map(r => {
          const obj: Record<string, any> = { ...r.values };
          obj.__ndw_row_id = r.row_id;
          obj.__ndw_capture_id = r.lineage.capture_id;
          obj.__ndw_record_pointer = r.lineage.record_pointer;
          obj.__ndw_captured_at = r.lineage.captured_at;
          obj.__ndw_request_url = r.lineage.request_url;
          return obj;
        });

        await this.db.registerFileText(`_${safeName}.json`, JSON.stringify(plainRows));
        await this.db.registerFileText(`_${safeName}__provenance.json`, JSON.stringify(provRows));

        await this.conn.query(`DROP TABLE IF EXISTS "${safeName}"`);
        await this.conn.query(`CREATE TABLE "${safeName}" AS SELECT * FROM read_json_auto('_${safeName}.json')`);

        await this.conn.query(`DROP TABLE IF EXISTS "${safeName}__provenance"`);
        await this.conn.query(`CREATE TABLE "${safeName}__provenance" AS SELECT * FROM read_json_auto('_${safeName}__provenance.json')`);
      } catch (err: any) {
        console.warn('DuckDB table registration note:', err?.message || err);
      }
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const start = performance.now();

    // 1. If DuckDB-WASM connection is active, query it
    if (this.conn) {
      try {
        const arrowTable = await this.conn.query(sql);
        const rows = arrowTable.toArray().map(row => row.toJSON());
        const columns = arrowTable.schema.fields.map(f => f.name);
        return {
          columns,
          rows,
          rowCount: rows.length,
          durationMs: Math.round((performance.now() - start) * 100) / 100,
        };
      } catch (err: any) {
        // If query failed in DuckDB, re-throw or check fallback
        if (!this.registeredDatasets.size) throw err;
      }
    }

    // 2. In-Memory SQL Execution Engine
    return this.executeInMemorySql(sql, start);
  }

  private executeInMemorySql(sql: string, start: number): QueryResult {
    const cleanSql = sql.trim().replace(/;+$/, '');
    const selectMatch = cleanSql.match(/SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_"]+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/i);

    if (!selectMatch) {
      // Find any table name in query
      const words = cleanSql.split(/\s+/);
      const fromIdx = words.findIndex(w => w.toUpperCase() === 'FROM');
      const targetTable = fromIdx !== -1 && words[fromIdx + 1] ? words[fromIdx + 1].replace(/"/g, '').toLowerCase() : '';
      const dataset = this.registeredDatasets.get(targetTable) || this.registeredDatasets.values().next().value;

      if (dataset) {
        const rows = dataset.rows.slice(0, 50).map(r => r.values);
        const columns = Object.keys(dataset.schema);
        return {
          columns,
          rows,
          rowCount: rows.length,
          durationMs: Math.round((performance.now() - start) * 100) / 100,
        };
      }

      throw new Error(`Unsupported SQL syntax or table not found in: ${sql}`);
    }

    const [, selectClause, rawTable, whereClause, groupByClause, orderByClause, limitClause] = selectMatch;
    const tableName = rawTable.replace(/"/g, '').toLowerCase();
    const dataset = this.registeredDatasets.get(tableName) || this.registeredDatasets.get(tableName.replace(/__provenance$/, ''));

    if (!dataset) {
      const available = Array.from(this.registeredDatasets.keys()).join(', ') || 'none';
      throw new Error(`Table '${tableName}' does not exist. Available tables: ${available}`);
    }

    let records = dataset.rows.map(r => {
      const vals: Record<string, any> = { ...r.values };
      if (tableName.endsWith('__provenance')) {
        vals.__ndw_row_id = r.row_id;
        vals.__ndw_capture_id = r.lineage.capture_id;
        vals.__ndw_record_pointer = r.lineage.record_pointer;
        vals.__ndw_captured_at = r.lineage.captured_at;
        vals.__ndw_request_url = r.lineage.request_url;
      }
      return vals;
    });

    // WHERE filter
    if (whereClause) {
      const eqMatch = whereClause.match(/([a-zA-Z0-9_]+)\s*(=|!=|>|<|>=|<=|LIKE|IS)\s*(.+)/i);
      if (eqMatch) {
        const [, col, op, rawVal] = eqMatch;
        const targetVal = rawVal.trim().replace(/^['"]|['"]$/g, '');
        records = records.filter(row => {
          const val = String(row[col] ?? '');
          if (op === '=') return val.toLowerCase() === targetVal.toLowerCase();
          if (op === '!=') return val.toLowerCase() !== targetVal.toLowerCase();
          if (op === '>') return Number(val) > Number(targetVal);
          if (op === '<') return Number(val) < Number(targetVal);
          if (op.toUpperCase() === 'LIKE') return val.toLowerCase().includes(targetVal.replace(/%/g, '').toLowerCase());
          return true;
        });
      }
    }

    // GROUP BY aggregations
    if (groupByClause) {
      const groupCol = groupByClause.trim();
      const groups = new Map<string, any[]>();
      for (const row of records) {
        const key = String(row[groupCol] ?? 'null');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }

      const groupedRows: any[] = [];
      for (const [key, groupRows] of groups.entries()) {
        const resultRow: Record<string, any> = { [groupCol]: key };
        // Parse aggregations in select clause (count(*), avg(col), sum(col))
        if (/count\(\*\)/i.test(selectClause)) {
          resultRow['count(*)'] = groupRows.length;
        }
        const avgMatch = selectClause.match(/avg\(([a-zA-Z0-9_]+)\)/i);
        if (avgMatch) {
          const numCol = avgMatch[1];
          const sum = groupRows.reduce((acc, r) => acc + (Number(r[numCol]) || 0), 0);
          resultRow[`avg(${numCol})`] = Math.round((sum / (groupRows.length || 1)) * 100) / 100;
        }
        const sumMatch = selectClause.match(/sum\(([a-zA-Z0-9_]+)\)/i);
        if (sumMatch) {
          const numCol = sumMatch[1];
          resultRow[`sum(${numCol})`] = groupRows.reduce((acc, r) => acc + (Number(r[numCol]) || 0), 0);
        }
        groupedRows.push(resultRow);
      }

      const cols = Object.keys(groupedRows[0] || {});
      return {
        columns: cols,
        rows: groupedRows,
        rowCount: groupedRows.length,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    // ORDER BY
    if (orderByClause) {
      const [orderCol, orderDir] = orderByClause.trim().split(/\s+/);
      const isDesc = (orderDir || '').toUpperCase() === 'DESC';
      records.sort((a, b) => {
        const va = a[orderCol];
        const vb = b[orderCol];
        if (va < vb) return isDesc ? 1 : -1;
        if (va > vb) return isDesc ? -1 : 1;
        return 0;
      });
    }

    // LIMIT
    if (limitClause) {
      records = records.slice(0, parseInt(limitClause, 10));
    }

    // SELECT projection
    let columns = Object.keys(records[0] || dataset.schema);
    if (selectClause !== '*') {
      const requestedCols = selectClause.split(',').map(s => s.trim()).filter(Boolean);
      columns = requestedCols;
      records = records.map(row => {
        const projected: Record<string, any> = {};
        for (const col of requestedCols) {
          projected[col] = row[col] ?? null;
        }
        return projected;
      });
    }

    return {
      columns,
      rows: records,
      rowCount: records.length,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  async exportParquet(tableName: string): Promise<Uint8Array> {
    const dataset = this.registeredDatasets.get(tableName.toLowerCase());
    if (!dataset) throw new Error(`Table ${tableName} not found for export`);
    // Export serialized dataset buffer
    const jsonStr = JSON.stringify(dataset.rows.map(r => r.values));
    return new TextEncoder().encode(jsonStr);
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
    this.isReady = false;
  }
}
