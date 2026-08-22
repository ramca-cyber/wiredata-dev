import { describe, it, expect } from 'vitest';
import { deduplicateRows } from '../src/datasets/dedup.js';
import { ExtractedRow } from '../src/types/index.js';

describe('Deduplication Engine with Lineage Retention', () => {
  const sampleRows: ExtractedRow[] = [
    {
      row_id: '01AN4Z07BY79KA1307SR9X4001',
      values: { id: 101, status: 'pending', total: 50 },
      lineage: {
        row_id: '01AN4Z07BY79KA1307SR9X4001',
        session_id: 'sess_1',
        capture_id: 'cap_1',
        response_hash: 'hash_1',
        record_pointer: '/data/orders/0',
        request_url: 'https://api.com/orders?page=1',
        captured_at: '2026-08-21T10:00:00Z',
      },
      field_lineage: {},
    },
    {
      row_id: '01AN4Z07BY79KA1307SR9X4002',
      values: { id: 101, status: 'shipped', total: 50 }, // duplicate of id 101 captured later
      lineage: {
        row_id: '01AN4Z07BY79KA1307SR9X4002',
        session_id: 'sess_1',
        capture_id: 'cap_2',
        response_hash: 'hash_2',
        record_pointer: '/data/orders/0',
        request_url: 'https://api.com/orders?page=2',
        captured_at: '2026-08-21T10:05:00Z',
      },
      field_lineage: {},
    },
    {
      row_id: '01AN4Z07BY79KA1307SR9X4003',
      values: { id: 102, status: 'delivered', total: 75 },
      lineage: {
        row_id: '01AN4Z07BY79KA1307SR9X4003',
        session_id: 'sess_1',
        capture_id: 'cap_1',
        response_hash: 'hash_1',
        record_pointer: '/data/orders/1',
        request_url: 'https://api.com/orders?page=1',
        captured_at: '2026-08-21T10:00:00Z',
      },
      field_lineage: {},
    },
  ];

  it('keeps all rows when policy is keep_all', () => {
    const { rows, duplicate_count } = deduplicateRows(sampleRows, ['id'], 'keep_all');
    expect(rows).toHaveLength(3);
    expect(duplicate_count).toBe(0);
  });

  it('keeps latest row and attaches suppressed source rows lineage', () => {
    const { rows, duplicate_count } = deduplicateRows(sampleRows, ['id'], 'keep_latest');
    expect(rows).toHaveLength(2);
    expect(duplicate_count).toBe(1);

    const dedupOrder = rows.find(r => r.values.id === 101);
    expect(dedupOrder).toBeDefined();
    expect(dedupOrder?.values.status).toBe('shipped'); // latest
    expect(dedupOrder?.lineage.suppressed_source_rows).toBeDefined();
    expect(dedupOrder?.lineage.suppressed_source_rows).toHaveLength(1);
    expect(dedupOrder?.lineage.suppressed_source_rows?.[0].capture_id).toBe('cap_1');
  });

  it('keeps earliest row when policy is keep_first', () => {
    const { rows, duplicate_count } = deduplicateRows(sampleRows, ['id'], 'keep_first');
    expect(rows).toHaveLength(2);
    expect(duplicate_count).toBe(1);

    const dedupOrder = rows.find(r => r.values.id === 101);
    expect(dedupOrder?.values.status).toBe('pending'); // earliest
    expect(dedupOrder?.lineage.suppressed_source_rows?.[0].capture_id).toBe('cap_2');
  });
});
