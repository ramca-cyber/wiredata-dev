import React, { useState, useMemo, useRef, useEffect } from 'react';
import { ColumnDefinition, ExtractedRow, LogicalType } from '@wiredata/core';
import { colors, fonts } from '../theme/tokens.js';

export interface VirtualizedTableProps {
  schema: Record<string, ColumnDefinition>;
  rows: ExtractedRow[];
  onSelectRowSource?: (row: ExtractedRow) => void;
  onSelectFieldValue?: (row: ExtractedRow, colName: string, value: unknown) => void;
  rowHeight?: number;
  height?: number | string;
}

export const VirtualizedTable: React.FC<VirtualizedTableProps> = ({
  schema,
  rows,
  onSelectRowSource,
  onSelectFieldValue,
  rowHeight = 36,
  height = '100%',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(500);

  const columns = useMemo(() => {
    return Object.values(schema)
      .filter(c => c.is_visible)
      .sort((a, b) => a.order - b.order);
  }, [schema]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  const totalRows = rows.length;
  const totalHeight = totalRows * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const endIndex = Math.min(totalRows - 1, Math.floor((scrollTop + containerHeight) / rowHeight) + 5);

  const visibleRows = useMemo(() => {
    const slice = [];
    for (let i = startIndex; i <= endIndex; i++) {
      if (rows[i]) {
        slice.push({ row: rows[i], index: i });
      }
    }
    return slice;
  }, [rows, startIndex, endIndex]);

  const formatCellValue = (val: unknown, type: LogicalType): React.ReactNode => {
    if (val === null || val === undefined) {
      return <span style={{ color: colors.textDim, fontStyle: 'italic' }}>null</span>;
    }
    if (type === 'BOOLEAN') {
      return (
        <span
          style={{
            color: val ? colors.success : colors.error,
            fontWeight: 600,
          }}
        >
          {String(val)}
        </span>
      );
    }
    if (typeof val === 'object') {
      return <span style={{ color: colors.accent }}>{JSON.stringify(val)}</span>;
    }
    return String(val);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height,
        background: colors.cardBg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: fonts.body,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          background: colors.panelBg,
          borderBottom: `1px solid ${colors.border}`,
          fontWeight: 600,
          fontSize: 12,
          color: colors.textMuted,
          paddingRight: 16,
          userSelect: 'none',
        }}
      >
        <div style={{ width: 50, padding: '10px 12px', textAlign: 'center', color: colors.textDim }}>#</div>
        {columns.map(col => (
          <div
            key={col.name}
            style={{
              flex: 1,
              minWidth: 140,
              padding: '10px 12px',
              borderRight: `1px solid ${colors.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.name}</span>
            <span
              style={{
                fontSize: 10,
                color: colors.primaryLight,
                background: `${colors.primary}22`,
                padding: '2px 5px',
                borderRadius: 3,
                fontFamily: fonts.mono,
              }}
            >
              {col.logical_type}
            </span>
          </div>
        ))}
        <div style={{ width: 80, padding: '10px 12px', textAlign: 'center' }}>Source</div>
      </div>

      {/* Virtualized Body */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'auto',
          position: 'relative',
        }}
      >
        <div style={{ height: totalHeight, width: '100%', position: 'relative' }}>
          {visibleRows.map(({ row, index }) => (
            <div
              key={row.row_id}
              style={{
                position: 'absolute',
                top: index * rowHeight,
                left: 0,
                right: 0,
                height: rowHeight,
                display: 'flex',
                alignItems: 'center',
                background: index % 2 === 0 ? colors.cardBg : colors.panelBg,
                borderBottom: `1px solid ${colors.border}44`,
                fontSize: 13,
                fontFamily: fonts.mono,
                color: colors.text,
              }}
            >
              <div style={{ width: 50, padding: '0 12px', textAlign: 'center', color: colors.textDim, fontSize: 11 }}>
                {index + 1}
              </div>
              {columns.map(col => (
                <div
                  key={col.name}
                  onClick={() => onSelectFieldValue?.(row, col.name, row.values[col.name])}
                  style={{
                    flex: 1,
                    minWidth: 140,
                    padding: '0 12px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: onSelectFieldValue ? 'pointer' : 'default',
                  }}
                  title={String(row.values[col.name] ?? '')}
                >
                  {formatCellValue(row.values[col.name], col.logical_type)}
                </div>
              ))}
              <div style={{ width: 80, padding: '0 12px', textAlign: 'center' }}>
                <button
                  onClick={() => onSelectRowSource?.(row)}
                  title="View Exact Source Lineage"
                  style={{
                    background: 'transparent',
                    border: `1px solid ${colors.primary}66`,
                    color: colors.primaryLight,
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  ↗ Source
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
