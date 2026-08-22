/**
 * Provenance-Preserving Object Flattening Engine
 */

import { FieldLineage, JSONPointer, NestedObjectPolicy } from '../types/index.js';
import { compilePointer, joinPointers } from '../json/pointer.js';

export interface FlattenResult {
  values: Record<string, unknown>;
  field_lineage: Record<string, FieldLineage>;
}

export interface FlattenOptions {
  delimiter?: string; // default "__"
  nestedObjectPolicy?: NestedObjectPolicy; // 'flatten' | 'json'
}

/**
 * Flattens a single record object while tracking exact JSON pointer provenance for every extracted column
 */
export function flattenRecord(
  rawRecord: unknown,
  basePointer: JSONPointer,
  options: FlattenOptions = {}
): FlattenResult {
  const delimiter = options.delimiter ?? '__';
  const nestedPolicy = options.nestedObjectPolicy ?? 'flatten';

  const values: Record<string, unknown> = {};
  const field_lineage: Record<string, FieldLineage> = {};

  if (rawRecord === null || rawRecord === undefined || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
    // Primitive or array at root
    const colName = 'value';
    values[colName] = rawRecord;
    field_lineage[colName] = {
      column_name: colName,
      source_pointer: basePointer,
      raw_value: rawRecord,
      transformed_value: rawRecord,
      operations: [],
    };
    return { values, field_lineage };
  }

  function recurse(currentObj: Record<string, unknown>, pathSegments: string[], pointerTokens: string[]) {
    for (const [key, value] of Object.entries(currentObj)) {
      const newPath = [...pathSegments, key];
      const newTokens = [...pointerTokens, key];
      const fieldPointer = joinPointers(basePointer, compilePointer(newTokens));

      if (
        nestedPolicy === 'flatten' &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0
      ) {
        // Flatten nested object
        recurse(value as Record<string, unknown>, newPath, newTokens);
      } else {
        const colName = newPath.join(delimiter);
        let transformedVal: unknown = value;
        const operations: string[] = [];

        if (newPath.length > 1) {
          operations.push('flatten');
        }

        // Format array or complex object if retained as JSON
        if (typeof value === 'object' && value !== null) {
          transformedVal = JSON.stringify(value);
          operations.push('json_serialize');
        }

        values[colName] = transformedVal;
        field_lineage[colName] = {
          column_name: colName,
          source_pointer: fieldPointer,
          raw_value: value,
          transformed_value: transformedVal,
          operations,
        };
      }
    }
  }

  recurse(rawRecord as Record<string, unknown>, [], []);
  return { values, field_lineage };
}
