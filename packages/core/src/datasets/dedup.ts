/**
 * Deduplication Engine with Lineage Preservation
 */

import { DeduplicationPolicy, ExtractedRow } from '../types/index.js';

export interface DeduplicateResult {
  rows: ExtractedRow[];
  duplicate_count: number;
}

/**
 * Builds a deterministic composite identity key for a row
 */
export function computeRowIdentityKey(row: ExtractedRow, identityColumns: string[]): string {
  if (!identityColumns || identityColumns.length === 0) {
    return row.row_id;
  }
  const parts = identityColumns.map(col => {
    const val = row.values[col];
    return val === undefined || val === null ? '<null>' : String(val);
  });
  return parts.join('||');
}

/**
 * Deduplicates rows while preserving full lineage of suppressed rows
 */
export function deduplicateRows(
  rows: ExtractedRow[],
  identityColumns: string[],
  policy: DeduplicationPolicy = 'keep_all'
): DeduplicateResult {
  if (policy === 'keep_all' || identityColumns.length === 0) {
    return { rows, duplicate_count: 0 };
  }

  const grouped = new Map<string, ExtractedRow[]>();

  for (const row of rows) {
    const key = computeRowIdentityKey(row, identityColumns);
    const list = grouped.get(key);
    if (list) {
      list.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  const resultRows: ExtractedRow[] = [];
  let duplicateCount = 0;

  for (const group of grouped.values()) {
    if (group.length === 1) {
      resultRows.push(group[0]);
    } else {
      duplicateCount += group.length - 1;

      // Sort or pick based on policy
      let survivingIndex = 0;
      if (policy === 'keep_latest') {
        // Find newest by captured_at (tie-breaker: later array position is latest)
        let newestTime = -Infinity;
        group.forEach((r, idx) => {
          const t = new Date(r.lineage.captured_at).getTime();
          if (t >= newestTime) {
            newestTime = t;
            survivingIndex = idx;
          }
        });
      } else {
        // keep_first: earliest by captured_at
        let earliestTime = Infinity;
        group.forEach((r, idx) => {
          const t = new Date(r.lineage.captured_at).getTime();
          if (t < earliestTime) {
            earliestTime = t;
            survivingIndex = idx;
          }
        });
      }

      const surviving = group[survivingIndex];
      const suppressed = group.filter((_, idx) => idx !== survivingIndex);

      // Attach suppressed lineage
      const combinedLineage = {
        ...surviving.lineage,
        suppressed_source_rows: [
          ...(surviving.lineage.suppressed_source_rows || []),
          ...suppressed.map(s => s.lineage),
        ],
      };

      resultRows.push({
        ...surviving,
        lineage: combinedLineage,
      });
    }
  }

  return { rows: resultRows, duplicate_count: duplicateCount };
}
