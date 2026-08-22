/**
 * Deterministic Logical Type Inference and Anomaly Detection Engine
 */

import { LogicalType, TypeAnomaly } from '../types/index.js';

// ISO 8601 Date: YYYY-MM-DD
const ISO_DATE_REGEX = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
// ISO 8601 Timestamp: YYYY-MM-DDTHH:mm:ss.sssZ or with timezone offset
const ISO_TIMESTAMP_REGEX =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[T\s](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i;

/**
 * Infers the logical type of an individual primitive value
 */
export function inferValueType(value: unknown): LogicalType | 'NULL' {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'boolean') {
    return 'BOOLEAN';
  }

  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      return 'BIGINT';
    }
    return 'DOUBLE';
  }

  if (typeof value === 'bigint') {
    return 'BIGINT';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (ISO_TIMESTAMP_REGEX.test(trimmed)) {
      return 'TIMESTAMP';
    }
    if (ISO_DATE_REGEX.test(trimmed)) {
      return 'DATE';
    }
    return 'VARCHAR';
  }

  if (typeof value === 'object') {
    return 'JSON';
  }

  return 'VARCHAR';
}

/**
 * Checks if a value conforms to an expected logical type
 */
export function conformsToType(value: unknown, expectedType: LogicalType): boolean {
  if (value === null || value === undefined) return true;

  switch (expectedType) {
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'BIGINT':
      return (
        typeof value === 'bigint' ||
        (typeof value === 'number' && Number.isSafeInteger(value)) ||
        (typeof value === 'string' && /^-?\d+$/.test(value.trim()))
      );
    case 'DOUBLE':
    case 'DECIMAL':
      return (
        typeof value === 'number' ||
        (typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim()))
      );
    case 'DATE':
      return typeof value === 'string' && ISO_DATE_REGEX.test(value.trim());
    case 'TIMESTAMP':
      return typeof value === 'string' && ISO_TIMESTAMP_REGEX.test(value.trim());
    case 'JSON':
      return typeof value === 'object';
    case 'VARCHAR':
      return true; // Any scalar can be represented as string
    default:
      return true;
  }
}

/**
 * Infers logical column type across an array of observed values and detects anomalies
 */
export function inferColumnType(
  columnName: string,
  valuesWithPointers: Array<{ value: unknown; rowId: string; pointer: string }>
): {
  inferredType: LogicalType;
  anomaly?: TypeAnomaly;
} {
  const typeCounts: Record<LogicalType, number> = {
    BOOLEAN: 0,
    BIGINT: 0,
    DOUBLE: 0,
    DECIMAL: 0,
    VARCHAR: 0,
    DATE: 0,
    TIMESTAMP: 0,
    JSON: 0,
  };

  let nullCount = 0;
  let totalNonNullable = 0;

  for (const item of valuesWithPointers) {
    const t = inferValueType(item.value);
    if (t === 'NULL') {
      nullCount++;
    } else {
      typeCounts[t]++;
      totalNonNullable++;
    }
  }

  if (totalNonNullable === 0) {
    return { inferredType: 'VARCHAR' };
  }

  // Determine dominant candidate
  let dominantType: LogicalType = 'VARCHAR';

  if (typeCounts.JSON > 0) {
    dominantType = 'JSON';
  } else if (typeCounts.BIGINT > 0 && typeCounts.DOUBLE === 0 && typeCounts.VARCHAR === 0 && typeCounts.BOOLEAN === 0) {
    dominantType = 'BIGINT';
  } else if ((typeCounts.DOUBLE > 0 || typeCounts.BIGINT > 0) && typeCounts.VARCHAR === 0 && typeCounts.BOOLEAN === 0) {
    dominantType = 'DOUBLE';
  } else if (typeCounts.BOOLEAN > 0 && typeCounts.BIGINT === 0 && typeCounts.DOUBLE === 0 && typeCounts.VARCHAR === 0) {
    dominantType = 'BOOLEAN';
  } else if (typeCounts.TIMESTAMP > 0 && typeCounts.VARCHAR === 0 && typeCounts.BIGINT === 0) {
    dominantType = 'TIMESTAMP';
  } else if (typeCounts.DATE > 0 && typeCounts.VARCHAR === 0 && typeCounts.BIGINT === 0) {
    dominantType = 'DATE';
  } else {
    // Mixed types: check if majority (>=75%) conforms to numeric
    const numericCount = typeCounts.BIGINT + typeCounts.DOUBLE;
    if (numericCount / totalNonNullable >= 0.75) {
      dominantType = typeCounts.DOUBLE > 0 ? 'DOUBLE' : 'BIGINT';
    } else {
      dominantType = 'VARCHAR';
    }
  }

  // Find anomalies if dominant type is non-VARCHAR
  const anomalies: Array<{ row_id: string; value: unknown; record_pointer: string }> = [];
  let validCount = 0;
  let incompatibleCount = 0;

  if (dominantType !== 'VARCHAR') {
    for (const item of valuesWithPointers) {
      if (item.value === null || item.value === undefined) {
        // null is not an anomaly
        continue;
      }
      if (conformsToType(item.value, dominantType)) {
        validCount++;
      } else {
        incompatibleCount++;
        if (anomalies.length < 10) {
          anomalies.push({
            row_id: item.rowId,
            value: item.value,
            record_pointer: item.pointer,
          });
        }
      }
    }
  }

  if (incompatibleCount > 0) {
    return {
      inferredType: dominantType,
      anomaly: {
        column_name: columnName,
        expected_type: dominantType,
        incompatible_count: incompatibleCount,
        null_count: nullCount,
        valid_count: validCount,
        sample_anomalies: anomalies,
      },
    };
  }

  return { inferredType: dominantType };
}
