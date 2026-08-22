import { describe, it, expect } from 'vitest';
import {
  buildDatasetSnapshot,
  CapturedRequest,
  DatasetDefinition,
  generateULID,
} from '../src/index.js';

describe('Capture Modes & Lineage Provenance', () => {
  it('records capture_mode as page when observed via page capture', () => {
    const capture: CapturedRequest = {
      capture_id: generateULID(),
      session_id: generateULID(),
      capture_mode: 'page',
      request: {
        url: 'https://api.com/api/orders',
        sanitized_url: 'https://api.com/api/orders',
        route_template: 'GET /api/orders',
        method: 'GET',
        query_parameters: [],
        // headers omitted in page mode
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        body_size: 50,
        body_hash: 'h_orders',
        body_object_ref: 'h_orders',
      },
      timing: { started_at: '', completed_at: '', duration_ms: 5 },
      classification: { json_candidate: true, parse_status: 'parsed' },
    };

    const responseBodies = new Map<string, unknown>([
      ['h_orders', { orders: [{ id: 101, status: 'shipped' }] }],
    ]);

    const definition: DatasetDefinition = {
      id: 'ds_orders',
      name: 'orders',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [{ method: 'GET', route_pattern: 'GET /api/orders' }],
      extraction: {
        record_pointer: '/orders',
        nested_object_policy: 'flatten',
        nested_array_policy: 'json',
        flatten_delimiter: '__',
      },
      identity_columns: ['id'],
      deduplication: 'keep_latest',
      columns: {},
    };

    const { snapshot, rows } = buildDatasetSnapshot({
      definition,
      captures: [capture],
      responseBodies,
    });

    expect(snapshot.row_count).toBe(1);
    expect(rows[0].lineage.capture_mode).toBe('page');
    expect(rows[0].lineage.request_url).toBe('https://api.com/api/orders');
  });

  it('records capture_mode as devtools when observed via Chrome DevTools network panel', () => {
    const capture: CapturedRequest = {
      capture_id: generateULID(),
      session_id: generateULID(),
      capture_mode: 'devtools',
      request: {
        url: 'https://api.com/api/customers?token=[REDACTED]',
        sanitized_url: 'https://api.com/api/customers?token=[REDACTED]',
        route_template: 'GET /api/customers',
        method: 'GET',
        query_parameters: [{ name: 'token', value: '[REDACTED]', is_redacted: true }],
        headers: [{ name: 'Authorization', value: '[REDACTED]', is_redacted: true }],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        headers: [{ name: 'Content-Type', value: 'application/json', is_redacted: false }],
        body_size: 40,
        body_hash: 'h_customers',
        body_object_ref: 'h_customers',
      },
      timing: { started_at: '', completed_at: '', duration_ms: 12 },
      classification: { json_candidate: true, parse_status: 'parsed' },
    };

    const responseBodies = new Map<string, unknown>([
      ['h_customers', [{ id: 44, name: 'Alice' }]],
    ]);

    const definition: DatasetDefinition = {
      id: 'ds_customers',
      name: 'customers',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [{ method: 'GET', route_pattern: 'GET /api/customers' }],
      extraction: {
        record_pointer: '/',
        nested_object_policy: 'flatten',
        nested_array_policy: 'json',
        flatten_delimiter: '__',
      },
      identity_columns: ['id'],
      deduplication: 'keep_latest',
      columns: {},
    };

    const { snapshot, rows } = buildDatasetSnapshot({
      definition,
      captures: [capture],
      responseBodies,
    });

    expect(snapshot.row_count).toBe(1);
    expect(rows[0].lineage.capture_mode).toBe('devtools');
    expect(rows[0].lineage.request_url).toBe('https://api.com/api/customers?token=[REDACTED]');
  });
});
