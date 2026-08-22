/**
 * DuckDB-WASM Dedicated Worker Script
 * Handles table registration, SQL queries, profiling, and Parquet export
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { ColumnDefinition, ExtractedRow, LogicalType } from '@wiredata/core';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

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

export interface WorkerRequest {
  id: string;
  type: 'INIT' | 'REGISTER_DATASET' | 'EXECUTE_QUERY' | 'EXPORT_PARQUET';
  payload?: any;
}

export interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

export async function initDuckDB(bundles: duckdb.DuckDBBundles): Promise<void> {
  const bundle = await duckdb.selectBundle(bundles);
  const worker = await duckdb.createWorker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
}

/**
 * Registers a dataset snapshot and its provenance relation in DuckDB
 */
export async function registerDataset(
  tableName: string,
  schema: Record<string, ColumnDefinition>,
  rows: ExtractedRow[]
): Promise<void> {
  if (!conn || !db) throw new Error('DuckDB not initialized');

  const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
  const provTableName = `${safeTableName}__provenance`;

  // Drop existing if present
  await conn.query(`DROP TABLE IF EXISTS "${safeTableName}"`);
  await conn.query(`DROP TABLE IF EXISTS "${provTableName}"`);

  // Build JSON arrays
  const regularRows = rows.map(r => {
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

  // Register in DuckDB
  const regJsonStr = JSON.stringify(regularRows);
  const provJsonStr = JSON.stringify(provRows);

  await db.registerFileText(`_${safeTableName}.json`, regJsonStr);
  await db.registerFileText(`_${provTableName}.json`, provJsonStr);

  await conn.query(
    `CREATE TABLE "${safeTableName}" AS SELECT * FROM read_json_auto('_${safeTableName}.json')`
  );
  await conn.query(
    `CREATE TABLE "${provTableName}" AS SELECT * FROM read_json_auto('_${provTableName}.json')`
  );
}

/**
 * Executes a user SQL query
 */
export async function executeSql(sql: string): Promise<{
  columns: string[];
  rows: any[];
  rowCount: number;
  durationMs: number;
}> {
  if (!conn) throw new Error('DuckDB connection not available');

  const start = performance.now();
  const table = await conn.query(sql);
  const durationMs = Math.round(performance.now() - start);

  const columns = table.schema.fields.map(f => f.name);
  const rows = table.toArray().map(row => {
    const obj: Record<string, any> = {};
    for (const col of columns) {
      const val = row[col];
      // Convert BigInt to number/string for JSON serialization
      obj[col] = typeof val === 'bigint' ? Number(val) : val;
    }
    return obj;
  });

  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs,
  };
}

/**
 * Generates a Parquet export buffer
 */
export async function exportParquet(tableName: string): Promise<Uint8Array> {
  if (!conn || !db) throw new Error('DuckDB not initialized');
  const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
  const fileName = `export_${safeTableName}.parquet`;

  await conn.query(`COPY "${safeTableName}" TO '${fileName}' (FORMAT PARQUET)`);
  const buffer = await db.copyFileToBuffer(fileName);
  return buffer;
}
