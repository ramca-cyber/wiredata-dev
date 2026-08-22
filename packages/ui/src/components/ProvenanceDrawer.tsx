import React from 'react';
import { ExtractedRow } from '@wiredata/core';
import { colors, fonts } from '../theme/tokens.js';

export interface ProvenanceDrawerProps {
  row: ExtractedRow | null;
  onClose: () => void;
  onShowRawResponse?: (responseHash: string, pointer: string) => void;
}

export const ProvenanceDrawer: React.FC<ProvenanceDrawerProps> = ({
  row,
  onClose,
  onShowRawResponse,
}) => {
  if (!row) return null;

  const { lineage } = row;
  const suppressedCount = lineage.suppressed_source_rows?.length || 0;

  const copyToClipboard = (text: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 440,
        background: colors.panelBg,
        borderLeft: `1px solid ${colors.border}`,
        boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.5)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: fonts.body,
        color: colors.text,
      }}
    >
      {/* Drawer Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: `1px solid ${colors.border}`,
          background: colors.cardBg,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>↗</span>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Row Provenance Lineage</h3>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: colors.textDim,
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Drawer Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {/* Source Request Info */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.textDim, marginBottom: 8, letterSpacing: '0.05em' }}>
            Source Observation
          </div>
          <div
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: 12,
              fontFamily: fonts.mono,
              fontSize: 12,
            }}
          >
            <div style={{ marginBottom: 8, wordBreak: 'break-all' }}>
              <span style={{ color: colors.primaryLight, fontWeight: 600 }}>URL:</span>{' '}
              <span style={{ color: colors.text }}>{lineage.request_url}</span>
            </div>
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: colors.textMuted }}>Capture Method:</span>{' '}
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: lineage.capture_mode === 'devtools' ? `${colors.accent}22` : `${colors.primary}22`,
                  color: lineage.capture_mode === 'devtools' ? colors.accent : colors.primaryLight,
                  fontWeight: 600,
                }}
              >
                {lineage.capture_mode === 'devtools' ? 'DevTools Deep Capture' : 'Page Capture (fetch/XHR)'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: colors.textDim, marginBottom: 8 }}>
              {lineage.capture_mode === 'devtools'
                ? 'Visibility: Chrome Network panel · Request headers: Redacted'
                : 'Visibility: fetch / XMLHttpRequest JSON · Request headers: Not collected'}
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: colors.textMuted }}>Capture ID:</span>{' '}
              <span style={{ color: colors.accent }}>{lineage.capture_id}</span>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: colors.textMuted }}>Captured At:</span>{' '}
              <span style={{ color: colors.text }}>{lineage.captured_at}</span>
            </div>
            <div>
              <span style={{ color: colors.textMuted }}>Response Hash:</span>{' '}
              <span style={{ color: colors.textDim }}>{lineage.response_hash.slice(0, 16)}...</span>
            </div>
          </div>
        </div>

        {/* Record Pointer */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.textDim, marginBottom: 8, letterSpacing: '0.05em' }}>
            JSON Pointer (RFC 6901)
          </div>
          <div
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: 12,
              fontFamily: fonts.mono,
              fontSize: 13,
              color: colors.primaryLight,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{lineage.record_pointer}</span>
            <button
              onClick={() => copyToClipboard(lineage.record_pointer)}
              style={{
                background: 'transparent',
                border: `1px solid ${colors.borderLight}`,
                color: colors.textMuted,
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Copy
            </button>
          </div>
        </div>

        {/* Deduplication & Suppressed Lineage */}
        {suppressedCount > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.warning, marginBottom: 8, letterSpacing: '0.05em' }}>
              Deduplication Lineage ({suppressedCount} Suppressed Duplicates)
            </div>
            <div
              style={{
                background: `${colors.warning}11`,
                border: `1px solid ${colors.warning}33`,
                borderRadius: 6,
                padding: 12,
                fontSize: 12,
              }}
            >
              <p style={{ margin: '0 0 8px 0', color: colors.textMuted }}>
                {suppressedCount} earlier observations matched the identity key and were suppressed. Lineage is retained:
              </p>
              {lineage.suppressed_source_rows?.map((suppressed, i) => (
                <div
                  key={i}
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    color: colors.textDim,
                    borderTop: `1px solid ${colors.border}`,
                    paddingTop: 6,
                    marginTop: 6,
                  }}
                >
                  Capture: {suppressed.capture_id} ({suppressed.captured_at})
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 24 }}>
          <button
            onClick={() => onShowRawResponse?.(lineage.response_hash, lineage.record_pointer)}
            style={{
              background: colors.primary,
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            🔍 Show Raw Response & Record
          </button>
          <button
            onClick={() => copyToClipboard(`curl "${lineage.request_url}"`)}
            style={{
              background: colors.cardBg,
              color: colors.text,
              border: `1px solid ${colors.borderLight}`,
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            📋 Copy Sanitized cURL
          </button>
        </div>
      </div>
    </div>
  );
};
