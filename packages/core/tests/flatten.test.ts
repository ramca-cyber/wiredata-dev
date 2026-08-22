import { describe, it, expect } from 'vitest';
import { flattenRecord } from '../src/datasets/flatten.js';

describe('Provenance-Preserving Record Flattening', () => {
  it('flattens nested object structures with exact pointers', () => {
    const raw = {
      id: 9182,
      customer: {
        id: 42,
        address: {
          city: 'Toronto',
          postal_code: 'M5V 2T6',
        },
      },
      tags: ['electronics', 'urgent'],
    };

    const basePointer = '/data/orders/14';
    const { values, field_lineage } = flattenRecord(raw, basePointer);

    expect(values['id']).toBe(9182);
    expect(values['customer__id']).toBe(42);
    expect(values['customer__address__city']).toBe('Toronto');
    expect(values['customer__address__postal_code']).toBe('M5V 2T6');
    expect(values['tags']).toBe(JSON.stringify(['electronics', 'urgent']));

    // Verify lineage pointers
    expect(field_lineage['id'].source_pointer).toBe('/data/orders/14/id');
    expect(field_lineage['customer__id'].source_pointer).toBe('/data/orders/14/customer/id');
    expect(field_lineage['customer__address__city'].source_pointer).toBe('/data/orders/14/customer/address/city');
    expect(field_lineage['customer__address__city'].operations).toContain('flatten');
  });

  it('handles primitive values at record pointer', () => {
    const { values, field_lineage } = flattenRecord(12345, '/total');
    expect(values.value).toBe(12345);
    expect(field_lineage.value.source_pointer).toBe('/total');
  });
});
