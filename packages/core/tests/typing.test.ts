import { describe, it, expect } from 'vitest';
import { inferValueType, inferColumnType, conformsToType } from '../src/inference/typing.js';

describe('Type Inference and Anomaly Detection', () => {
  it('infers primitive scalar types accurately', () => {
    expect(inferValueType(true)).toBe('BOOLEAN');
    expect(inferValueType(100)).toBe('BIGINT');
    expect(inferValueType(100.5)).toBe('DOUBLE');
    expect(inferValueType('2026-08-21')).toBe('DATE');
    expect(inferValueType('2026-08-21T22:14:51Z')).toBe('TIMESTAMP');
    expect(inferValueType('random string')).toBe('VARCHAR');
    expect(inferValueType({ key: 'val' })).toBe('JSON');
    expect(inferValueType(null)).toBe('NULL');
  });

  it('infers column types across homogenous rows', () => {
    const data = [
      { value: 10, rowId: 'r1', pointer: '/0/count' },
      { value: 20, rowId: 'r2', pointer: '/1/count' },
      { value: null, rowId: 'r3', pointer: '/2/count' },
    ];
    const { inferredType, anomaly } = inferColumnType('count', data);
    expect(inferredType).toBe('BIGINT');
    expect(anomaly).toBeUndefined();
  });

  it('detects type anomalies when minority values are incompatible', () => {
    const data = [
      { value: 10.5, rowId: 'r1', pointer: '/0/amount' },
      { value: 20.2, rowId: 'r2', pointer: '/1/amount' },
      { value: 30.1, rowId: 'r3', pointer: '/2/amount' },
      { value: 40.0, rowId: 'r4', pointer: '/3/amount' },
      { value: 'unknown', rowId: 'r5', pointer: '/4/amount' }, // anomaly
    ];

    const { inferredType, anomaly } = inferColumnType('amount', data);
    expect(inferredType).toBe('DOUBLE');
    expect(anomaly).toBeDefined();
    expect(anomaly?.incompatible_count).toBe(1);
    expect(anomaly?.sample_anomalies[0].value).toBe('unknown');
    expect(anomaly?.sample_anomalies[0].record_pointer).toBe('/4/amount');
  });

  it('evaluates type conformance accurately', () => {
    expect(conformsToType(42, 'BIGINT')).toBe(true);
    expect(conformsToType('42', 'BIGINT')).toBe(true);
    expect(conformsToType('abc', 'BIGINT')).toBe(false);
    expect(conformsToType(42.5, 'DOUBLE')).toBe(true);
    expect(conformsToType('2026-08-22T01:00:00Z', 'TIMESTAMP')).toBe(true);
    expect(conformsToType('invalid-date', 'TIMESTAMP')).toBe(false);
  });
});
