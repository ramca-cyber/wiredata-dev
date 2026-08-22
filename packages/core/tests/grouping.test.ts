import { describe, it, expect } from 'vitest';
import { groupCandidatesByRoute } from '../src/inference/grouping.js';
import { CapturedRequest, generateULID } from '../src/index.js';

describe('Route Grouping & Sub-Collection Aggregation', () => {
  it('aggregates multiple paginated captures under single logical route candidate', () => {
    const sessionId = generateULID();
    const captures: CapturedRequest[] = [
      {
        capture_id: generateULID(),
        session_id: sessionId,
        request: {
          url: 'https://api.com/api/orders?page=1',
          sanitized_url: 'https://api.com/api/orders?page=1',
          route_template: 'GET /api/orders',
          method: 'GET',
          query_parameters: [],
          headers: [],
        },
        response: {
          status: 200,
          status_text: 'OK',
          mime_type: 'application/json',
          headers: [],
          body_size: 100,
          body_hash: 'hash1',
          body_object_ref: 'hash1',
        },
        timing: { started_at: '', completed_at: '', duration_ms: 10 },
        classification: { json_candidate: true, parse_status: 'parsed' },
      },
      {
        capture_id: generateULID(),
        session_id: sessionId,
        request: {
          url: 'https://api.com/api/orders?page=2',
          sanitized_url: 'https://api.com/api/orders?page=2',
          route_template: 'GET /api/orders',
          method: 'GET',
          query_parameters: [],
          headers: [],
        },
        response: {
          status: 200,
          status_text: 'OK',
          mime_type: 'application/json',
          headers: [],
          body_size: 100,
          body_hash: 'hash2',
          body_object_ref: 'hash2',
        },
        timing: { started_at: '', completed_at: '', duration_ms: 10 },
        classification: { json_candidate: true, parse_status: 'parsed' },
      },
    ];

    const responseBodies = new Map<string, unknown>([
      ['hash1', { data: { orders: [{ id: 1 }, { id: 2 }] } }],
      ['hash2', { data: { orders: [{ id: 3 }, { id: 4 }] } }],
    ]);

    const grouped = groupCandidatesByRoute(captures, responseBodies);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].route_template).toBe('GET /api/orders');
    expect(grouped[0].total_captures).toBe(2);

    const ordersCol = grouped[0].collections.find(c => c.pointer === '/data/orders');
    expect(ordersCol).toBeDefined();
    expect(ordersCol?.total_rows).toBe(4); // 2 + 2 aggregated
  });
});
