/**
 * WireData Side Panel Companion App
 * Capture controller, visible privacy status indicator, quick dataset counters, and full workbench launcher.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  CandidateCollection,
  CapturedRequest,
  CaptureSession,
  generateULID,
  ULID,
} from '@wiredata/core';
import {
  DirectoryHandleManager,
  FSDirectoryAdapter,
  InMemoryFileAdapter,
  WorkspaceManager,
} from '@wiredata/workspace';
import { colors, fonts } from '@wiredata/ui';
import { PageNetworkCaptureAdapter } from '../adapters/page.js';

export function SidePanelApp() {
  const [activeTab, setActiveTab] = useState<{ id?: number; url?: string; title?: string } | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeSession, setActiveSession] = useState<CaptureSession | null>(null);

  // Metrics
  const [captureCount, setCaptureCount] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [detectedCollections, setDetectedCollections] = useState<Map<string, number>>(new Map());

  // Workspace
  const [workspaceManager, setWorkspaceManager] = useState<WorkspaceManager>(
    () => new WorkspaceManager(new InMemoryFileAdapter())
  );
  const [workspaceName, setWorkspaceName] = useState<string>('In-Memory Working Session');

  const adapterRef = useRef<PageNetworkCaptureAdapter | null>(null);

  // 1. Detect current active tab and initialize workspace
  useEffect(() => {
    const init = async () => {
      // Query active tab
      if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            setActiveTab({
              id: tabs[0].id,
              url: tabs[0].url || '',
              title: tabs[0].title || '',
            });
          }
        } catch (err) {
          console.warn('Tab query error:', err);
        }
      }

      // Check ephemeral session state from service worker
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' }, (sessionState) => {
          if (sessionState?.isCapturing) {
            setIsCapturing(true);
          }
        });
      }

      // Restore workspace handle
      try {
        const cachedHandle = await DirectoryHandleManager.loadHandle();
        if (cachedHandle) {
          const verified = await DirectoryHandleManager.verifyPermission(cachedHandle, 'read');
          if (verified) {
            const fsAdapter = new FSDirectoryAdapter(cachedHandle);
            const wm = new WorkspaceManager(fsAdapter);
            await wm.openOrCreateWorkspace();
            setWorkspaceManager(wm);
            setWorkspaceName((cachedHandle as any).name || 'Workspace Folder');
          }
        } else {
          await workspaceManager.openOrCreateWorkspace();
        }
      } catch {
        await workspaceManager.openOrCreateWorkspace();
      }
    };

    init();

    // Listen for broadcast messages from service worker
    const port = typeof chrome !== 'undefined' && chrome.runtime?.connect ? chrome.runtime.connect({ name: 'wiredata_ui_channel' }) : null;
    if (port) {
      port.onMessage.addListener(msg => {
        if (msg.type === 'CAPTURE_STATUS_CHANGED') {
          setIsCapturing(msg.isCapturing);
        }
      });
    }

    return () => {
      if (port) port.disconnect();
    };
  }, []);

  // Pick Workspace Directory
  const handleSelectWorkspace = async () => {
    try {
      const handle = await DirectoryHandleManager.pickDirectory();
      const fsAdapter = new FSDirectoryAdapter(handle);
      const wm = new WorkspaceManager(fsAdapter);
      await wm.openOrCreateWorkspace();
      setWorkspaceManager(wm);
      setWorkspaceName((handle as any).name || 'Selected Folder');
    } catch (err: any) {
      console.warn('Directory picker cancelled:', err.message);
    }
  };

  // Toggle Page Capture
  const handleToggleCapture = async () => {
    if (isCapturing) {
      // Stop
      if (adapterRef.current) {
        await adapterRef.current.stop();
        adapterRef.current = null;
      }
      setIsCapturing(false);
      if (activeSession) {
        await workspaceManager.saveSession({
          ...activeSession,
          status: 'complete',
          ended_at: new Date().toISOString(),
          capture_count: captureCount,
          body_bytes: totalBytes,
        });
      }
    } else {
      // Start
      if (!activeTab?.id || !activeTab.url) {
        alert('Please open an active web page tab first.');
        return;
      }

      const sessionId = generateULID();
      const session: CaptureSession = {
        session_id: sessionId,
        name: `Page Capture: ${new URL(activeTab.url).hostname}`,
        started_at: new Date().toISOString(),
        initial_page_url: activeTab.url,
        navigation_history: [],
        capture_count: 0,
        body_bytes: 0,
        application_version: '0.1.0',
        status: 'capturing',
      };
      setActiveSession(session);
      await workspaceManager.saveSession(session);

      const adapter = new PageNetworkCaptureAdapter(
        sessionId,
        activeTab.id,
        activeTab.url,
        (capture: CapturedRequest, rawBody: unknown, candidates: CandidateCollection[]) => {
          setCaptureCount(prev => prev + 1);
          setTotalBytes(prev => prev + (capture.response.body_size || 0));

          for (const cand of candidates) {
            setDetectedCollections(prev => {
              const next = new Map(prev);
              const cur = next.get(cand.suggested_name) || 0;
              next.set(cand.suggested_name, cur + cand.row_count);
              return next;
            });
          }

          workspaceManager.saveCapture(sessionId, capture, rawBody);
        }
      );

      await adapter.start();
      adapterRef.current = adapter;
      setIsCapturing(true);
    }
  };

  // Open Full Workbench in a browser tab
  const handleOpenWorkbench = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') });
    } else {
      window.open('/workbench.html', '_blank');
    }
  };

  const hostName = activeTab?.url ? (() => {
    try {
      return new URL(activeTab.url).hostname;
    } catch {
      return activeTab.url;
    }
  })() : 'No Active Tab';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: colors.bg,
        fontFamily: fonts.body,
        color: colors.text,
        padding: 16,
        userSelect: 'none',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: 'linear-gradient(135deg, #0284c7, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 12,
              color: '#ffffff',
            }}
          >
            W
          </div>
          <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.02em' }}>WireData</span>
        </div>
        <span style={{ fontSize: 11, color: colors.textDim, fontFamily: fonts.mono }}>v0.1.0</span>
      </div>

      {/* Target Tab Host Card */}
      <div
        style={{
          background: colors.cardBg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 11, color: colors.textDim, textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>
          Target Page
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primaryLight, wordBreak: 'break-all', fontFamily: fonts.mono }}>
          {hostName}
        </div>
      </div>

      {/* Status & Privacy Banner */}
      <div
        style={{
          background: isCapturing ? `${colors.error}11` : colors.panelBg,
          border: `1px solid ${isCapturing ? colors.error : colors.borderLight}`,
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: isCapturing ? colors.error : colors.textDim,
              boxShadow: isCapturing ? `0 0 10px ${colors.error}` : 'none',
            }}
          />
          <span style={{ fontWeight: 700, fontSize: 13, color: isCapturing ? colors.error : colors.textMuted }}>
            {isCapturing ? '● CAPTURING THIS TAB' : '○ CAPTURE OFF'}
          </span>
        </div>

        <p style={{ margin: 0, fontSize: 12, color: colors.textMuted, lineHeight: 1.5 }}>
          {isCapturing
            ? 'Recording JSON fetch & XHR responses requested by this page. Request headers and passwords are never collected.'
            : 'Capture is off. WireData is not recording network data from this tab.'}
        </p>

        {isCapturing && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, fontFamily: fonts.mono, color: colors.text }}>
            <div>
              <strong style={{ color: colors.primaryLight }}>{captureCount}</strong> responses
            </div>
            <div>
              <strong style={{ color: colors.primaryLight }}>{(totalBytes / 1024).toFixed(1)}</strong> KB
            </div>
          </div>
        )}

        <button
          onClick={handleToggleCapture}
          style={{
            background: isCapturing ? colors.error : 'linear-gradient(135deg, #0284c7, #2563eb)',
            color: '#ffffff',
            border: 'none',
            borderRadius: 6,
            padding: '10px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: isCapturing ? `0 0 12px ${colors.error}44` : '0 4px 12px rgba(2, 132, 199, 0.3)',
          }}
        >
          {isCapturing ? '⏹ Stop Capture' : '⏺ Start Capture'}
        </button>
      </div>

      {/* Detected Datasets Section */}
      <div style={{ flex: 1, overflowY: 'auto', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: colors.textDim, textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>
          Discovered Datasets ({detectedCollections.size})
        </div>

        {detectedCollections.size === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: colors.textDim, fontSize: 12, background: colors.cardBg, borderRadius: 6 }}>
            {isCapturing ? 'Listening for JSON collections...' : 'Start capture and browse to discover datasets.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from(detectedCollections.entries()).map(([name, rows]) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: colors.cardBg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontSize: 12,
                }}
              >
                <span style={{ fontWeight: 600, color: colors.primaryLight }}>{name}</span>
                <span style={{ fontFamily: fonts.mono, color: colors.textMuted }}>{rows.toLocaleString()} rows</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Workspace & Launch Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={handleSelectWorkspace}
          style={{
            background: colors.cardBg,
            color: colors.text,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>📁 {workspaceName}</span>
          <span style={{ fontSize: 10, color: colors.primaryLight }}>Change</span>
        </button>

        <button
          onClick={handleOpenWorkbench}
          style={{
            background: colors.hoverBg,
            color: colors.primaryLight,
            border: `1px solid ${colors.primary}66`,
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
          <span>Open Full Workbench</span>
          <span>↗</span>
        </button>
      </div>
    </div>
  );
}
