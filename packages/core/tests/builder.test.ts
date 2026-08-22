import { describe, it, expect } from 'vitest';
import { buildDatasetSnapshot } from '../src/datasets/builder.js';
import { CapturedRequest, DatasetDefinition } from '../src/types/index.js';

describe('Dataset Snapshot Builder Engine', () => {
  const definition: DatasetDefinition = {
    id: 'ds_orders',
    name: 'orders',
    version: 1,
    created_at: '2026-08-22T01:00:00Z',
    updated_at: '2026-08-22T01:00:00Z',
    sources: [
      {
        method: 'GET',
        route_pattern: '/api/orders',
      },
    ],
    extraction: {
      record_pointer: '/data/orders',
      nested_object_policy: 'flatten',
      nested_array_policy: 'json',
      flatten_delimiter: '__',
    },
    identity_columns: ['id'],
    deduplication: 'keep_latest',
    columns: {},
  };

  const responseBody1 = {
    total: 100,
    data: {
      orders: [
        { id: 101, status: 'pending', total: 45.5, customer: { name: 'Alice' } },
        { id: 102, status: 'completed', total: 90.0, customer: { name: 'Bob' } },
      ],
    },
  };

  const responseBody2 = {
    total: 100,
    data: {
      orders: [
        { id: 101, status: 'shipped', total: 45.5, customer: { name: 'Alice' } }, // updated status
        { id: 103, status: 'new', total: 12.0, customer: { name: 'Charlie' } },
      ],
    },
  };

  const captures: CapturedRequest[] = [
    {
      capture_id: '01AN4Z07BY79KA1307SR9X4010',
      session_id: '01AN4Z07BY79KA1307SR9X4000',
      request: {
        url: 'https://api.example.com/api/orders?page=1',
        sanitized_url: 'https://api.example.com/api/orders?page=1',
        route_template: '/api/orders',
        method: 'GET',
        query_parameters: [],
        headers: [],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        headers: [],
        body_size: 500,
        body_hash: 'hash_body_1',
        body_object_ref: 'hash_body_1',
      },
      timing: {
        started_at: '2026-08-22T01:00:00Z',
        completed_at: '2026-08-22T01:00:01Z',
        duration_ms: 100,
      },
      classification: {
        json_candidate: true,
        parse_status: 'parsed',
      },
    },
    {
      capture_id: '01AN4Z07BY79KA1307SR9X4011',
      session_id: '01AN4Z07BY79KA1307SR9X4000',
      request: {
        url: 'https://api.example.com/api/orders?page=2',
        sanitized_url: 'https://api.example.com/api/orders?page=2',
        route_template: '/api/orders',
        method: 'GET',
        query_parameters: [],
        headers: [],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        headers: [],
        body_size: 500,
        body_hash: 'hash_body_2',
        body_object_ref: 'hash_body_2',
      },
      timing: {
        started_at: '2026-08-22T01:05:00Z',
        completed_at: '2026-08-22T01:05:01Z',
        duration_ms: 100,
      },
      classification: {
        json_candidate: true,
        parse_status: 'parsed',
      },
    },
  ];

  const responseBodies = new Map<string, unknown>([
    ['hash_body_1', responseBody1],
    ['hash_body_2', responseBody2],
  ]);

  it('builds dataset snapshot from multiple captures and tracks coverage', () => {
    const { snapshot, rows } = buildDatasetSnapshot({
      definition,
      captures,
      responseBodies,
    });

    expect(snapshot.row_count).toBe(3); // 101 (deduped), 102, 103
    expect(snapshot.duplicate_count).toBe(1);
    expect(snapshot.coverage.reported_total).toBe(100);
    expect(snapshot.coverage.observed_unique_rows).toBe(3);
    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.coverage_percentage).toBe(3);

    // Schema verification
    expect(snapshot.schema.id.logical_type).toBe('BIGINT');
    expect(snapshot.schema.total.logical_type).toBe('DOUBLE');
    expect(snapshot.schema.customer__name.logical_type).toBe('VARCHAR');

    // Row lineage verification
    const order101 = rows.find(r => r.values.id === 101);
    expect(order101?.values.status).toBe('shipped'); // latest
    expect(order101?.field_lineage.customer__name.source_pointer).toBe('/data/orders/0/customer/name');
  });
});
