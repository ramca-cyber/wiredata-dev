/**
 * Dataset Snapshot Builder Engine
 * Rebuilds deterministic dataset snapshots from raw captures + definition versions
 */

import {
  CapturedRequest,
  ColumnDefinition,
  CoverageSummary,
  DatasetDefinition,
  DatasetSnapshot,
  ExtractedRow,
  TypeAnomaly,
  ULID,
} from '../types/index.js';
import { generateULID } from '../utils/ulid.js';
import { getValueByPointer, joinPointers } from '../json/pointer.js';
import { flattenRecord } from './flatten.js';
import { inferColumnType } from '../inference/typing.js';
import { deduplicateRows } from './dedup.js';

export interface BuildDatasetOptions {
  definition: DatasetDefinition;
  captures: CapturedRequest[];
  responseBodies: Map<string, unknown>; // body_hash -> parsed JSON document
}

export interface BuildDatasetResult {
  snapshot: DatasetSnapshot;
  rows: ExtractedRow[];
}

/**
 * Checks if a captured request matches the dataset source rules
 */
export function matchesSourceRule(capture: CapturedRequest, definition: DatasetDefinition): boolean {
  if (definition.sources.length === 0) {
    return true; // Match all if sources list is empty
  }

  return definition.sources.some(source => {
    // Method match
    if (source.method && source.method.toUpperCase() !== capture.request.method.toUpperCase()) {
      return false;
    }

    // GraphQL operation match
    if (source.graphql_operation) {
      if (capture.request.graphql_operation_name !== source.graphql_operation) {
        return false;
      }
    }

    // Route pattern match
    if (source.route_pattern) {
      const target = capture.request.route_template || capture.request.sanitized_url;
      if (!target.includes(source.route_pattern) && target !== source.route_pattern) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Builds a dataset snapshot from captures
 */
export function buildDatasetSnapshot(options: BuildDatasetOptions): BuildDatasetResult {
  const { definition, captures, responseBodies } = options;
  const contributingCaptureIds: ULID[] = [];
  const rawExtractedRows: ExtractedRow[] = [];

  let reportedTotalCount: number | undefined;

  for (const capture of captures) {
    if (!matchesSourceRule(capture, definition)) {
      continue;
    }

    const bodyObj = responseBodies.get(capture.response.body_hash);
    if (!bodyObj) {
      continue;
    }

    contributingCaptureIds.push(capture.capture_id);

    // Extract records via pointer
    const recordContainer = getValueByPointer(bodyObj, definition.extraction.record_pointer);
    if (!recordContainer) {
      continue;
    }

    // Check for common reported pagination totals in the parent body
    if (typeof bodyObj === 'object' && bodyObj !== null) {
      const totalCandidates = ['total', 'totalCount', 'total_count', 'count', 'total_rows'];
      for (const k of totalCandidates) {
        const val = (bodyObj as any)[k];
        if (typeof val === 'number' && Number.isSafeInteger(val)) {
          reportedTotalCount = Math.max(reportedTotalCount ?? 0, val);
        }
      }
    }

    const items: unknown[] = Array.isArray(recordContainer) ? recordContainer : [recordContainer];

    items.forEach((item, index) => {
      const rowId = generateULID();
      const itemPointer = Array.isArray(recordContainer)
        ? joinPointers(definition.extraction.record_pointer, `/${index}`)
        : definition.extraction.record_pointer;

      const { values, field_lineage } = flattenRecord(item, itemPointer, {
        delimiter: definition.extraction.flatten_delimiter,
        nestedObjectPolicy: definition.extraction.nested_object_policy,
      });

      rawExtractedRows.push({
        row_id: rowId,
        values,
        lineage: {
          row_id: rowId,
          session_id: capture.session_id,
          capture_id: capture.capture_id,
          capture_mode: capture.capture_mode || 'page',
          response_hash: capture.response.body_hash,
          record_pointer: itemPointer,
          page_context_id: capture.page_context_id,
          request_url: capture.request.sanitized_url || capture.request.url,
          captured_at: capture.timing.completed_at || new Date().toISOString(),
        },
        field_lineage,
      });
    });
  }

  // Deduplication
  const { rows: deduplicatedRows, duplicate_count } = deduplicateRows(
    rawExtractedRows,
    definition.identity_columns,
    definition.deduplication
  );

  // Column Schema & Type Inference
  const allColumnNames = new Set<string>();
  for (const row of deduplicatedRows) {
    for (const k of Object.keys(row.values)) {
      allColumnNames.add(k);
    }
  }

  const schema: Record<string, ColumnDefinition> = {};
  const typeAnomalies: TypeAnomaly[] = [];

  let colOrder = 0;
  for (const colName of Array.from(allColumnNames).sort()) {
    const existingDef = definition.columns[colName];

    // Gather values across rows
    const colValuesWithPointers = deduplicatedRows.map(r => ({
      value: r.values[colName],
      rowId: r.row_id,
      pointer: r.field_lineage[colName]?.source_pointer || '',
    }));

    const { inferredType, anomaly } = inferColumnType(colName, colValuesWithPointers);
    if (anomaly) {
      typeAnomalies.push(anomaly);
    }

    const logicalType = existingDef?.type_override || existingDef?.logical_type || inferredType;

    schema[colName] = {
      name: existingDef?.name || colName,
      original_name: colName,
      source_pointer_template: existingDef?.source_pointer_template || colValuesWithPointers[0]?.pointer || '',
      logical_type: logicalType,
      inferred_type: inferredType,
      type_override: existingDef?.type_override,
      is_visible: existingDef?.is_visible ?? true,
      order: existingDef?.order ?? colOrder++,
    };
  }

  // Coverage summary
  let coverageStatus: 'complete' | 'partial' | 'unknown' = 'unknown';
  let coveragePercentage: number | undefined;

  if (reportedTotalCount !== undefined && reportedTotalCount > 0) {
    coveragePercentage = Math.round((deduplicatedRows.length / reportedTotalCount) * 10000) / 100;
    coverageStatus = deduplicatedRows.length >= reportedTotalCount ? 'complete' : 'partial';
  }

  const coverage: CoverageSummary = {
    reported_total: reportedTotalCount,
    observed_unique_rows: deduplicatedRows.length,
    coverage_percentage: coveragePercentage,
    status: coverageStatus,
  };

  const snapshot: DatasetSnapshot = {
    snapshot_id: generateULID(),
    dataset_id: definition.id,
    definition_version: definition.version,
    created_at: new Date().toISOString(),
    row_count: deduplicatedRows.length,
    column_count: Object.keys(schema).length,
    contributing_capture_ids: Array.from(new Set(contributingCaptureIds)),
    schema,
    coverage,
    duplicate_count,
    type_anomalies: typeAnomalies,
  };

  return { snapshot, rows: deduplicatedRows };
}
