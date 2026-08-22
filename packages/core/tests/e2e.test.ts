import { describe, it, expect } from 'vitest';
import {
  buildDatasetSnapshot,
  computeNormalizedRoute,
  detectCandidateCollections,
  extractGraphQLOperation,
  generateFixtureJson,
  generateJsonSchema,
  generateTypeScriptInterface,
  generateULID,
  redactHeaders,
  redactJsonBody,
  redactQueryParams,
  serializeToCsv,
  serializeToJsonl,
  sha256,
  CapturedRequest,
  DatasetDefinition,
} from '../src/index.js';
import {
  handleMockRequest,
  generateOrdersPage,
} from '../../../apps/fixture-app/src/mock-server.js';

describe('End-to-End V1 Acceptance Scenario & Edge Cases', () => {
  it('executes full V1 acceptance scenario across all fixture endpoints', async () => {
    const sessionId = generateULID();
    const captures: CapturedRequest[] = [];
    const responseBodies = new Map<string, unknown>();

    // 1. Trigger Orders Pages 1, 2, 3
    for (let page = 1; page <= 3; page++) {
      const url = `http://localhost:5173/api/orders?page=${page}&limit=100`;
      const res = await handleMockRequest({
        method: 'GET',
        url,
        body: '',
        headers: { Accept: 'application/json' },
      });

      const bodyObj = JSON.parse(res.body);
      const hash = await sha256(res.body);
      responseBodies.set(hash, bodyObj);

      const normalizedRoute = computeNormalizedRoute('GET', url);
      const { sanitizedUrl, params } = redactQueryParams(url);

      const capture: CapturedRequest = {
        capture_id: generateULID(),
        session_id: sessionId,
        request: {
          url,
          sanitized_url: sanitizedUrl,
          route_template: normalizedRoute,
          method: 'GET',
          query_parameters: params,
          headers: redactHeaders([{ name: 'Accept', value: 'application/json' }]),
        },
        response: {
          status: res.status,
          status_text: 'OK',
          mime_type: 'application/json',
          headers: [],
          body_size: res.body.length,
          body_hash: hash,
          body_object_ref: hash,
        },
        timing: {
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 30,
        },
        classification: {
          json_candidate: true,
          parse_status: 'parsed',
        },
      };

      captures.push(capture);
    }

    // 2. Candidate Detection on Orders response
    const sampleBody = responseBodies.values().next().value;
    const candidates = detectCandidateCollections(sampleBody);
    expect(candidates.length).toBeGreaterThan(0);
    const ordersCand = candidates.find(c => c.pointer === '/data/orders');
    expect(ordersCand).toBeDefined();
    expect(ordersCand?.suggested_name).toBe('orders');
    expect(ordersCand?.confidence).toBe('high');

    // 3. Build 'orders' Dataset
    const ordersDef: DatasetDefinition = {
      id: 'ds_orders',
      name: 'orders',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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

    const { snapshot: ordersSnapshot, rows: orderRows } = buildDatasetSnapshot({
      definition: ordersDef,
      captures,
      responseBodies,
    });

    // Coverage & row verification
    expect(orderRows).toHaveLength(300); // 3 pages * 100 rows
    expect(ordersSnapshot.coverage.reported_total).toBe(8247);
    expect(ordersSnapshot.coverage.observed_unique_rows).toBe(300);
    expect(ordersSnapshot.coverage.status).toBe('partial');
    expect(ordersSnapshot.coverage.coverage_percentage).toBe(3.64);

    // Provenance reverse verification
    const sampleRow = orderRows[0];
    expect(sampleRow.lineage.record_pointer).toMatch(/^\/data\/orders\/\d+$/);
    expect(sampleRow.field_lineage.customer__address__city.source_pointer).toMatch(
      /^\/data\/orders\/\d+\/customer\/address\/city$/
    );
    expect(sampleRow.field_lineage.customer__address__city.operations).toContain('flatten');

    // 4. Code Generation & Export verification
    const tsCode = generateTypeScriptInterface('Order', ordersSnapshot.schema);
    expect(tsCode).toContain('export interface Order {');
    expect(tsCode).toContain('customer__address__city: string | null;');
    expect(tsCode).toContain('total: number | null;');

    const jsonSchema = generateJsonSchema('Order', ordersSnapshot.schema);
    expect((jsonSchema.properties as any).customer__address__city).toBeDefined();

    const csvData = serializeToCsv(orderRows, ordersSnapshot.schema, true);
    expect(csvData.split('\n').length).toBe(301); // 1 header + 300 rows
    expect(csvData).toContain('__ndw_capture_id,__ndw_record_pointer,__ndw_captured_at');

    const jsonlData = serializeToJsonl(orderRows, ordersSnapshot.schema, false);
    expect(jsonlData.split('\n')).toHaveLength(300);

    const fixtureData = generateFixtureJson(orderRows, 5);
    expect(JSON.parse(fixtureData)).toHaveLength(5);
  });

  it('handles GraphQL operation extraction and grouping', async () => {
    const queryBody = JSON.stringify({
      operationName: 'OrdersQuery',
      query: 'query OrdersQuery { orders { id status total } }',
    });

    const opName = extractGraphQLOperation(queryBody);
    expect(opName).toBe('OrdersQuery');

    const route = computeNormalizedRoute('POST', 'https://api.com/graphql', opName);
    expect(route).toBe('POST /graphql (OrdersQuery)');

    const res = await handleMockRequest({
      method: 'POST',
      url: '/graphql',
      body: queryBody,
      headers: { 'Content-Type': 'application/json' },
    });

    const bodyObj = JSON.parse(res.body);
    const candidates = detectCandidateCollections(bodyObj);
    const ordersCand = candidates.find(c => c.pointer === '/data/orders');
    expect(ordersCand).toBeDefined();
    expect(ordersCand?.row_count).toBe(2);
  });

  it('handles type anomaly detection on mixed types', async () => {
    const res = await handleMockRequest({
      method: 'GET',
      url: '/api/mixed-types',
      body: '',
      headers: {},
    });

    const bodyObj = JSON.parse(res.body);
    const hash = await sha256(res.body);
    const sessionId = generateULID();

    const capture: CapturedRequest = {
      capture_id: generateULID(),
      session_id: sessionId,
      request: {
        url: '/api/mixed-types',
        sanitized_url: '/api/mixed-types',
        method: 'GET',
        query_parameters: [],
        headers: [],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        headers: [],
        body_size: res.body.length,
        body_hash: hash,
        body_object_ref: hash,
      },
      timing: {
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 10,
      },
      classification: {
        json_candidate: true,
        parse_status: 'parsed',
      },
    };

    const def: DatasetDefinition = {
      id: 'ds_mixed',
      name: 'mixed_records',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [],
      extraction: {
        record_pointer: '/records',
        nested_object_policy: 'flatten',
        nested_array_policy: 'json',
        flatten_delimiter: '__',
      },
      identity_columns: ['id'],
      deduplication: 'keep_latest',
      columns: {},
    };

    const { snapshot } = buildDatasetSnapshot({
      definition: def,
      captures: [capture],
      responseBodies: new Map([[hash, bodyObj]]),
    });

    expect(snapshot.row_count).toBe(4);
    expect(snapshot.type_anomalies.length).toBeGreaterThan(0);
    const amountAnomaly = snapshot.type_anomalies.find(a => a.column_name === 'amount');
    expect(amountAnomaly).toBeDefined();
    expect(amountAnomaly?.incompatible_count).toBe(1);
    expect(amountAnomaly?.sample_anomalies[0].value).toBe('unknown');
  });

  it('handles duplicate suppression with full lineage retention', async () => {
    const res = await handleMockRequest({
      method: 'GET',
      url: '/api/duplicates',
      body: '',
      headers: {},
    });

    const bodyObj = JSON.parse(res.body);
    const hash = await sha256(res.body);
    const sessionId = generateULID();

    const capture: CapturedRequest = {
      capture_id: generateULID(),
      session_id: sessionId,
      request: {
        url: '/api/duplicates',
        sanitized_url: '/api/duplicates',
        method: 'GET',
        query_parameters: [],
        headers: [],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        headers: [],
        body_size: res.body.length,
        body_hash: hash,
        body_object_ref: hash,
      },
      timing: {
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 10,
      },
      classification: {
        json_candidate: true,
        parse_status: 'parsed',
      },
    };

    const def: DatasetDefinition = {
      id: 'ds_dups',
      name: 'duplicates',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [],
      extraction: {
        record_pointer: '/items',
        nested_object_policy: 'flatten',
        nested_array_policy: 'json',
        flatten_delimiter: '__',
      },
      identity_columns: ['id'],
      deduplication: 'keep_latest',
      columns: {},
    };

    const { snapshot, rows } = buildDatasetSnapshot({
      definition: def,
      captures: [capture],
      responseBodies: new Map([[hash, bodyObj]]),
    });

    expect(snapshot.row_count).toBe(2);
    expect(snapshot.duplicate_count).toBe(1);

    const dupRow = rows.find(r => r.values.id === 1);
    expect(dupRow?.values.status).toBe('v1_updated'); // latest
    expect(dupRow?.lineage.suppressed_source_rows).toBeDefined();
    expect(dupRow?.lineage.suppressed_source_rows).toHaveLength(1);
  });
});
