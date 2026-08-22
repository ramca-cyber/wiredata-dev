import React from 'react';
import { colors, fonts } from '../theme/tokens.js';

export interface StatusBarProps {
  workspaceName?: string;
  isCapturing: boolean;
  captureCount: number;
  datasetCount: number;
  totalBytes: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  workspaceName = 'Local Workspace',
  isCapturing,
  captureCount,
  datasetCount,
  totalBytes,
}) => {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <footer
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 16px',
        background: colors.panelBg,
        borderTop: `1px solid ${colors.border}`,
        fontSize: 11,
        fontFamily: fonts.mono,
        color: colors.textDim,
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: isCapturing ? colors.error : colors.textDim,
              boxShadow: isCapturing ? `0 0 8px ${colors.error}` : 'none',
            }}
          />
          <strong style={{ color: isCapturing ? colors.error : colors.textMuted }}>
            {isCapturing ? 'RECORDING' : 'IDLE'}
          </strong>
        </span>
        <span>
          Workspace: <strong style={{ color: colors.text }}>{workspaceName}</strong>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span>
          Captures: <strong style={{ color: colors.text }}>{captureCount}</strong>
        </span>
        <span>
          Datasets: <strong style={{ color: colors.primaryLight }}>{datasetCount}</strong>
        </span>
        <span>
          Memory: <strong style={{ color: colors.text }}>{formatBytes(totalBytes)}</strong>
        </span>
      </div>
    </footer>
  );
};
