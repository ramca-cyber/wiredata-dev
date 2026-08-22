import { describe, it, expect } from 'vitest';
import {
  generateTypeScriptInterface,
  generateJsonSchema,
  serializeToCsv,
  serializeToJsonl,
  generateFixtureJson,
} from '../src/export/generators.js';
import { ColumnDefinition, ExtractedRow } from '../src/types/index.js';

describe('Export and Code Generators', () => {
  const schema: Record<string, ColumnDefinition> = {
    id: {
      name: 'id',
      original_name: 'id',
      source_pointer_template: '/id',
      logical_type: 'BIGINT',
      inferred_type: 'BIGINT',
      is_visible: true,
      order: 0,
    },
    status: {
      name: 'status',
      original_name: 'status',
      source_pointer_template: '/status',
      logical_type: 'VARCHAR',
      inferred_type: 'VARCHAR',
      is_visible: true,
      order: 1,
    },
    total: {
      name: 'total',
      original_name: 'total',
      source_pointer_template: '/total',
      logical_type: 'DOUBLE',
      inferred_type: 'DOUBLE',
      is_visible: true,
      order: 2,
    },
  };

  const rows: ExtractedRow[] = [
    {
      row_id: 'r1',
      values: { id: 1, status: 'shipped', total: 42.5 },
      lineage: {
        row_id: 'r1',
        session_id: 's1',
        capture_id: 'c1',
        response_hash: 'h1',
        record_pointer: '/0',
        request_url: 'https://api.com/orders',
        captured_at: '2026-08-22T01:00:00Z',
      },
      field_lineage: {},
    },
    {
      row_id: 'r2',
      values: { id: 2, status: 'delivered, urgent', total: 99.0 },
      lineage: {
        row_id: 'r2',
        session_id: 's1',
        capture_id: 'c1',
        response_hash: 'h1',
        record_pointer: '/1',
        request_url: 'https://api.com/orders',
        captured_at: '2026-08-22T01:00:00Z',
      },
      field_lineage: {},
    },
  ];

  it('generates clean TypeScript interface', () => {
    const ts = generateTypeScriptInterface('Order', schema);
    expect(ts).toContain('export interface Order {');
    expect(ts).toContain('id: number | null;');
    expect(ts).toContain('status: string | null;');
    expect(ts).toContain('total: number | null;');
  });

  it('generates valid JSON Schema Draft-07', () => {
    const jsonSchema = generateJsonSchema('Order', schema);
    expect(jsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(jsonSchema.title).toBe('Order');
    expect((jsonSchema.properties as any).id.type).toBe('integer');
    expect((jsonSchema.properties as any).total.type).toBe('number');
  });

  it('serializes rows to CSV with proper cell escaping and optional provenance', () => {
    const csv = serializeToCsv(rows, schema, true);
    expect(csv).toContain('id,status,total,__ndw_capture_id,__ndw_record_pointer,__ndw_captured_at');
    expect(csv).toContain('"delivered, urgent"'); // escaped comma
    expect(csv).toContain('c1,/0,2026-08-22T01:00:00Z');
  });

  it('serializes rows to JSONL', () => {
    const jsonl = serializeToJsonl(rows, schema, false);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, status: 'shipped', total: 42.5 });
  });

  it('generates fixture JSON sample', () => {
    const fixture = generateFixtureJson(rows, 1, 'first');
    const parsed = JSON.parse(fixture);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(1);
  });
});
