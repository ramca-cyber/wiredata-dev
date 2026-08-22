/**
 * Export and Code Generator Engines
 * TypeScript interfaces, JSON Schema, CSV, JSONL, and Fixtures
 */

import { ColumnDefinition, ExtractedRow, LogicalType } from '../types/index.js';

/**
 * Maps a LogicalType to a TypeScript type string
 */
export function logicalTypeToTsType(type: LogicalType): string {
  switch (type) {
    case 'BOOLEAN':
      return 'boolean';
    case 'BIGINT':
    case 'DOUBLE':
    case 'DECIMAL':
      return 'number';
    case 'DATE':
    case 'TIMESTAMP':
    case 'VARCHAR':
      return 'string';
    case 'JSON':
      return 'Record<string, unknown> | unknown[]';
    default:
      return 'unknown';
  }
}

/**
 * Maps a LogicalType to JSON Schema property descriptor
 */
export function logicalTypeToJsonSchema(type: LogicalType): Record<string, unknown> {
  switch (type) {
    case 'BOOLEAN':
      return { type: 'boolean' };
    case 'BIGINT':
      return { type: 'integer' };
    case 'DOUBLE':
    case 'DECIMAL':
      return { type: 'number' };
    case 'DATE':
      return { type: 'string', format: 'date' };
    case 'TIMESTAMP':
      return { type: 'string', format: 'date-time' };
    case 'JSON':
      return { type: ['object', 'array'] };
    case 'VARCHAR':
    default:
      return { type: 'string' };
  }
}

/**
 * Generates clean, idiomatic TypeScript interface from a dataset schema
 */
export function generateTypeScriptInterface(
  interfaceName: string,
  schema: Record<string, ColumnDefinition>
): string {
  const safeName = interfaceName
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (letter) => letter.toUpperCase())
    .replace(/[\s\W_]+/g, '');

  const lines: string[] = [`export interface ${safeName} {`];

  for (const col of Object.values(schema).sort((a, b) => a.order - b.order)) {
    if (!col.is_visible) continue;
    const tsType = logicalTypeToTsType(col.logical_type);
    const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(col.name) ? col.name : JSON.stringify(col.name);
    lines.push(`  ${key}: ${tsType} | null;`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Generates JSON Schema draft-07 document from dataset schema
 */
export function generateJsonSchema(
  title: string,
  schema: Record<string, ColumnDefinition>
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const col of Object.values(schema).sort((a, b) => a.order - b.order)) {
    if (!col.is_visible) continue;
    properties[col.name] = {
      ...logicalTypeToJsonSchema(col.logical_type),
      description: `Source: ${col.source_pointer_template}`,
    };
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title,
    type: 'object',
    properties,
    required,
  };
}

/**
 * Serializes dataset rows to CSV format
 */
export function serializeToCsv(
  rows: ExtractedRow[],
  schema: Record<string, ColumnDefinition>,
  includeProvenance: boolean = false
): string {
  const visibleCols = Object.values(schema)
    .filter(c => c.is_visible)
    .sort((a, b) => a.order - b.order)
    .map(c => c.name);

  const headerCols = [...visibleCols];
  if (includeProvenance) {
    headerCols.push('__ndw_capture_id', '__ndw_record_pointer', '__ndw_captured_at');
  }

  function escapeCsvCell(val: unknown): string {
    if (val === null || val === undefined) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const lines: string[] = [headerCols.map(escapeCsvCell).join(',')];

  for (const row of rows) {
    const rowValues = visibleCols.map(col => escapeCsvCell(row.values[col]));
    if (includeProvenance) {
      rowValues.push(
        escapeCsvCell(row.lineage.capture_id),
        escapeCsvCell(row.lineage.record_pointer),
        escapeCsvCell(row.lineage.captured_at)
      );
    }
    lines.push(rowValues.join(','));
  }

  return lines.join('\n');
}

/**
 * Serializes dataset rows to JSON Lines (JSONL) format
 */
export function serializeToJsonl(
  rows: ExtractedRow[],
  schema: Record<string, ColumnDefinition>,
  includeProvenance: boolean = false
): string {
  const visibleCols = new Set(
    Object.values(schema)
      .filter(c => c.is_visible)
      .map(c => c.name)
  );

  return rows
    .map(row => {
      const output: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row.values)) {
        if (visibleCols.has(k)) {
          output[k] = v;
        }
      }
      if (includeProvenance) {
        output.__ndw_capture_id = row.lineage.capture_id;
        output.__ndw_record_pointer = row.lineage.record_pointer;
        output.__ndw_captured_at = row.lineage.captured_at;
      }
      return JSON.stringify(output);
    })
    .join('\n');
}

/**
 * Exports sample fixture JSON
 */
export function generateFixtureJson(
  rows: ExtractedRow[],
  count: number = 10,
  mode: 'first' | 'random' = 'first'
): string {
  let sampled: ExtractedRow[] = [];
  if (mode === 'random') {
    const shuffled = [...rows].sort(() => Math.random() - 0.5);
    sampled = shuffled.slice(0, count);
  } else {
    sampled = rows.slice(0, count);
  }

  return JSON.stringify(
    sampled.map(r => r.values),
    null,
    2
  );
}
