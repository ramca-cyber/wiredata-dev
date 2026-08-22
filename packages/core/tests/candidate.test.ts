import { describe, it, expect } from 'vitest';
import { detectCandidateCollections } from '../src/inference/candidate.js';

describe('JSON Candidate Collection Detection', () => {
  it('detects root array candidate', () => {
    const doc = [
      { id: 1, name: 'Product A', price: 19.99 },
      { id: 2, name: 'Product B', price: 29.99 },
      { id: 3, name: 'Product C', price: 39.99 },
    ];

    const candidates = detectCandidateCollections(doc);
    expect(candidates.length).toBeGreaterThan(0);
    const rootCandidate = candidates.find(c => c.pointer === '/');
    expect(rootCandidate).toBeDefined();
    expect(rootCandidate?.row_count).toBe(3);
    expect(rootCandidate?.confidence).toBe('high');
  });

  it('detects nested collection in object (e.g. /data/orders)', () => {
    const doc = {
      status: 'success',
      data: {
        total: 100,
        orders: [
          { id: 101, status: 'shipped', total: 150.0 },
          { id: 102, status: 'pending', total: 75.5 },
          { id: 103, status: 'delivered', total: 200.0 },
        ],
      },
    };

    const candidates = detectCandidateCollections(doc);
    const ordersCand = candidates.find(c => c.pointer === '/data/orders');
    expect(ordersCand).toBeDefined();
    expect(ordersCand?.row_count).toBe(3);
    expect(ordersCand?.suggested_name).toBe('orders');
    expect(ordersCand?.confidence).toBe('high');
  });

  it('detects multiple candidates in response and ranks by confidence', () => {
    const doc = {
      orders: [
        { id: 1, customer: 'Alice' },
        { id: 2, customer: 'Bob' },
        { id: 3, customer: 'Charlie' },
      ],
      facets: [
        { key: 'category', count: 12 },
        { key: 'brand', count: 5 },
      ],
      warnings: ['deprecated endpoint'],
    };

    const candidates = detectCandidateCollections(doc);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].pointer).toBe('/orders');
    expect(candidates[0].confidence).toBe('high');
  });
});
