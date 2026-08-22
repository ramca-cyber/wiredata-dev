import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  normalizeQueryShape,
  extractGraphQLOperation,
  computeNormalizedRoute,
  isIdentifierSegment,
} from '../src/inference/route.ts';

describe('Route Normalization & GraphQL Grouping', () => {
  it('identifies numerical IDs, UUIDs, and ULIDs as identifier segments', () => {
    expect(isIdentifierSegment('123')).toBe(true);
    expect(isIdentifierSegment('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isIdentifierSegment('01AN4Z07BY79KA1307SR9X4MV3')).toBe(true);
    expect(isIdentifierSegment('orders')).toBe(false);
    expect(isIdentifierSegment('api')).toBe(false);
  });

  it('normalizes path routes with dynamic segments into templates', () => {
    expect(normalizePath('/api/orders/9182')).toBe('/api/orders/{id}');
    expect(normalizePath('/api/orders/550e8400-e29b-41d4-a716-446655440000/items')).toBe('/api/orders/{id}/items');
    expect(normalizePath('/api/users/01AN4Z07BY79KA1307SR9X4MV3/profile')).toBe('/api/users/{id}/profile');
  });

  it('normalizes query parameter shapes', () => {
    const shape = normalizeQueryShape('https://example.com/api/orders?page=2&limit=50&sort=desc');
    expect(shape).toEqual({
      limit: '*',
      page: '*',
      sort: '*',
    });
  });

  it('extracts GraphQL operation name from JSON body or raw GraphQL string', () => {
    const jsonBody = JSON.stringify({
      operationName: 'GetOrdersList',
      query: 'query GetOrdersList { orders { id } }',
      variables: { limit: 10 },
    });
    expect(extractGraphQLOperation(jsonBody)).toBe('GetOrdersList');

    const rawQuery = 'query UserProfileQuery { user { name } }';
    expect(extractGraphQLOperation({ query: rawQuery })).toBe('UserProfileQuery');
  });

  it('computes standardized normalized route strings', () => {
    expect(computeNormalizedRoute('GET', 'https://api.com/api/orders/9182?page=1')).toBe('GET /api/orders/{id}');
    expect(computeNormalizedRoute('POST', 'https://api.com/graphql', 'GetOrders')).toBe('POST /graphql (GetOrders)');
  });
});
