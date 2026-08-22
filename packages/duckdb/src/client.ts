/**
 * DuckDB Client interface for UI Thread (RPC wrapper)
 */

import { ColumnDefinition, ExtractedRow } from '@wiredata/core';

export interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  durationMs: number;
}

export class DuckDBClient {
  private worker: Worker | null = null;
  private reqId = 0;
  private pending = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private isReady = false;

  constructor(private workerFactory?: () => Worker) {}

  async init(): Promise<void> {
    if (this.isReady) return;

    if (this.workerFactory) {
      this.worker = this.workerFactory();
      this.worker.onmessage = (evt: MessageEvent) => {
        const { id, success, data, error } = evt.data;
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (success) p.resolve(data);
          else p.reject(new Error(error || 'DuckDB Worker Error'));
        }
      };
    }
    this.isReady = true;
  }

  private send<T>(type: string, payload?: any): Promise<T> {
    const id = String(++this.reqId);
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        // Mock fallback if running in non-worker environment (e.g. unit tests)
        if (type === 'EXECUTE_QUERY') {
          return resolve({
            columns: ['result'],
            rows: [{ result: 'DuckDB Client Mock' }],
            rowCount: 1,
            durationMs: 1,
          } as unknown as T);
        }
        return resolve(undefined as unknown as T);
      }
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async registerDataset(
    tableName: string,
    schema: Record<string, ColumnDefinition>,
    rows: ExtractedRow[]
  ): Promise<void> {
    await this.send('REGISTER_DATASET', { tableName, schema, rows });
  }

  async query(sql: string): Promise<QueryResult> {
    return await this.send<QueryResult>('EXECUTE_QUERY', { sql });
  }

  async exportParquet(tableName: string): Promise<Uint8Array> {
    return await this.send<Uint8Array>('EXPORT_PARQUET', { tableName });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
    }
  }
}
