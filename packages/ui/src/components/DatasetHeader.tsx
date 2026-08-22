import React from 'react';
import { CoverageSummary, DatasetSnapshot } from '@wiredata/core';
import { colors, fonts } from '../theme/tokens.js';

export interface DatasetHeaderProps {
  snapshot: DatasetSnapshot;
  onExport?: (format: 'csv' | 'parquet' | 'jsonl') => void;
  onGenerateCode?: (type: 'ts' | 'jsonschema') => void;
  onDeleteDataset?: () => void;
}

export const DatasetHeader: React.FC<DatasetHeaderProps> = ({
  snapshot,
  onExport,
  onGenerateCode,
  onDeleteDataset,
}) => {
  const { coverage, row_count, column_count, duplicate_count } = snapshot;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 20px',
        background: colors.cardBg,
        borderBottom: `1px solid ${colors.border}`,
        fontFamily: fonts.body,
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: colors.text }}>
            {snapshot.dataset_id}
          </h2>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 4,
              background:
                coverage.status === 'complete'
                  ? `${colors.success}22`
                  : `${colors.warning}22`,
              color:
                coverage.status === 'complete'
                  ? colors.success
                  : colors.warning,
              border: `1px solid ${
                coverage.status === 'complete'
                  ? `${colors.success}44`
                  : `${colors.warning}44`
              }`,
            }}
          >
            {coverage.status.toUpperCase()} COVERAGE
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 13, color: colors.textMuted }}>
          <span>
            <strong style={{ color: colors.text }}>{row_count.toLocaleString()}</strong> observed rows
          </span>
          {coverage.reported_total !== undefined && (
            <span>
              <strong style={{ color: colors.text }}>{coverage.reported_total.toLocaleString()}</strong> reported total ({coverage.coverage_percentage}%)
            </span>
          )}
          <span>
            <strong style={{ color: colors.text }}>{column_count}</strong> columns
          </span>
          {duplicate_count > 0 && (
            <span style={{ color: colors.warning }}>
              <strong style={{ color: colors.warning }}>{duplicate_count}</strong> duplicates suppressed
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={() => onGenerateCode?.('ts')}
          style={{
            background: colors.panelBg,
            color: colors.text,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          📄 TypeScript
        </button>
        <button
          onClick={() => onGenerateCode?.('jsonschema')}
          style={{
            background: colors.panelBg,
            color: colors.text,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          📋 JSON Schema
        </button>
        <button
          onClick={() => onExport?.('parquet')}
          style={{
            background: colors.primary,
            color: '#ffffff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          ⬇ Export Parquet
        </button>
        <button
          onClick={() => onExport?.('csv')}
          style={{
            background: colors.panelBg,
            color: colors.text,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          CSV
        </button>
        {onDeleteDataset && (
          <button
            onClick={onDeleteDataset}
            title="Delete this dataset"
            style={{
              background: 'transparent',
              color: colors.error,
              border: `1px solid ${colors.error}44`,
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            🗑 Delete
          </button>
        )}
      </div>
    </div>
  );
};
