import React, { useState } from 'react';
import { JSONPointer } from '@wiredata/core';
import { colors, fonts } from '../theme/tokens.js';

export interface JsonTreeViewerProps {
  data: unknown;
  highlightPointer?: JSONPointer;
  onSelectPointer?: (pointer: JSONPointer) => void;
}

export const JsonTreeViewer: React.FC<JsonTreeViewerProps> = ({
  data,
  highlightPointer,
  onSelectPointer,
}) => {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['', '/']));

  const toggleExpand = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (value: unknown, currentPointer: string, keyName?: string, depth: number = 0): React.ReactNode => {
    const isHighlighted = highlightPointer && (highlightPointer === currentPointer || highlightPointer.startsWith(`${currentPointer}/`));
    const isExactMatch = highlightPointer === currentPointer;
    const isObject = value !== null && typeof value === 'object';
    const isArray = Array.isArray(value);
    const isExpanded = expandedPaths.has(currentPointer) || isHighlighted;

    const indent = depth * 16;

    if (!isObject) {
      // Leaf primitive
      let valColor = colors.text;
      if (typeof value === 'string') valColor = '#38bdf8';
      else if (typeof value === 'number') valColor = '#f59e0b';
      else if (typeof value === 'boolean') valColor = '#10b981';
      else if (value === null) valColor = colors.textDim;

      return (
        <div
          key={currentPointer}
          onClick={() => onSelectPointer?.(currentPointer)}
          style={{
            paddingLeft: indent,
            paddingTop: 2,
            paddingBottom: 2,
            background: isExactMatch ? `${colors.primary}33` : 'transparent',
            borderLeft: isExactMatch ? `3px solid ${colors.primaryLight}` : '3px solid transparent',
            cursor: onSelectPointer ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            fontSize: 12,
            fontFamily: fonts.mono,
          }}
        >
          {keyName !== undefined && (
            <span style={{ color: '#e2e8f0', marginRight: 6 }}>"{keyName}":</span>
          )}
          <span style={{ color: valColor }}>{JSON.stringify(value)}</span>
        </div>
      );
    }

    // Object or Array
    const entries = isArray
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);

    const openBracket = isArray ? '[' : '{';
    const closeBracket = isArray ? ']' : '}';

    return (
      <div key={currentPointer} style={{ paddingLeft: indent }}>
        <div
          onClick={() => toggleExpand(currentPointer)}
          style={{
            cursor: 'pointer',
            paddingTop: 2,
            paddingBottom: 2,
            display: 'flex',
            alignItems: 'center',
            background: isExactMatch ? `${colors.primary}33` : 'transparent',
            borderLeft: isExactMatch ? `3px solid ${colors.primaryLight}` : '3px solid transparent',
            fontSize: 12,
            fontFamily: fonts.mono,
            userSelect: 'none',
          }}
        >
          <span style={{ color: colors.textDim, width: 14, display: 'inline-block' }}>
            {isExpanded ? '▼' : '▶'}
          </span>
          {keyName !== undefined && (
            <span style={{ color: '#e2e8f0', marginRight: 6 }}>"{keyName}":</span>
          )}
          <span style={{ color: colors.textMuted }}>{openBracket}</span>
          {!isExpanded && (
            <span style={{ color: colors.textDim, margin: '0 4px' }}>
              ... {entries.length} {isArray ? 'items' : 'keys'} ...
            </span>
          )}
          {!isExpanded && <span style={{ color: colors.textMuted }}>{closeBracket}</span>}
        </div>

        {isExpanded && (
          <div>
            {entries.map(([k, v]) => {
              const childPointer = currentPointer === '/' ? `/${k}` : `${currentPointer}/${k}`;
              return renderNode(v, childPointer, isArray ? undefined : k, depth + 1);
            })}
            <div style={{ paddingLeft: 14, color: colors.textMuted, fontSize: 12, fontFamily: fonts.mono }}>
              {closeBracket}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        background: colors.cardBg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 16,
        overflowX: 'auto',
        overflowY: 'auto',
        maxHeight: '100%',
      }}
    >
      {renderNode(data, '/')}
    </div>
  );
};
