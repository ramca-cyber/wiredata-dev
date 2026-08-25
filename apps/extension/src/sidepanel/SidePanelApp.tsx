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
  redactQueryParams,
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
import { captureTableFromActiveTab } from '../adapters/dom-table.js';

export function SidePanelApp() {
  const [activeTab, setActiveTab] = useState<{ id?: number; url?: string; title?: string } | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeSession, setActiveSession] = useState<CaptureSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [scrapeStatus, setScrapeStatus] = useState<{ message: string; tone: 'success' | 'warning' | 'error' } | null>(
    null
  );

  // Metrics
  const [captureCount, setCaptureCount] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [detectedCollections, setDetectedCollections] = useState<Map<string, number>>(new Map());

  // Workspace
  const [workspaceManager, setWorkspaceManager] = useState<WorkspaceManager>(
    () => new WorkspaceManager(new InMemoryFileAdapter())
  );
  const [workspaceName, setWorkspaceName] = useState<string>('In-Memory Working Session');
  // Capture is disabled until a real, persisted folder is attached. The
  // in-memory adapter exists for tests/dev only — starting a capture against
  // it means a user can record data, close the panel, and lose all of it.
  const [hasPersistentWorkspace, setHasPersistentWorkspace] = useState<boolean>(false);

  const adapterRef = useRef<PageNetworkCaptureAdapter | null>(null);

  const attachCaptureCallback = (sessionId: ULID, wm: WorkspaceManager) => (
    capture: CapturedRequest,
    rawBody: unknown,
    candidates: CandidateCollection[]
  ) => {
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

    wm.saveCapture(sessionId, capture, rawBody);
  };

  // 1. Detect current active tab, initialize/reconcile workspace and session state
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

      // Restore workspace handle (requires readwrite: this panel writes captures,
      // datasets, and exports, not just reads them)
      let wm = workspaceManager;
      try {
        const cachedHandle = await DirectoryHandleManager.loadHandle();
        if (cachedHandle) {
          const verified = await DirectoryHandleManager.verifyPermission(cachedHandle, 'readwrite');
          if (verified) {
            const fsAdapter = new FSDirectoryAdapter(cachedHandle);
            wm = new WorkspaceManager(fsAdapter);
            await wm.openOrCreateWorkspace();
            setWorkspaceManager(wm);
            setWorkspaceName((cachedHandle as any).name || 'Workspace Folder');
            setHasPersistentWorkspace(true);
          } else {
            await workspaceManager.openOrCreateWorkspace();
          }
        } else {
          await workspaceManager.openOrCreateWorkspace();
        }
      } catch {
        await workspaceManager.openOrCreateWorkspace();
      }

      // Check the service worker's live ephemeral session state. The worker
      // itself can be killed and restarted at any time, so this is the
      // authoritative source for "is a capture actually running right now" —
      // not anything we might have persisted to disk previously.
      let liveState: { isCapturing: boolean; activeTabId: number | null; activeSessionId: string | null } | null = null;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          liveState = await chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' });
        } catch {}
      }

      // Reconcile any sessions this panel previously wrote as 'capturing' that
      // the service worker no longer considers active (panel/tab closed, tab
      // navigated origin, or the worker restarted mid-capture without ever
      // getting a chance to finalize the persisted session on disk).
      try {
        const sessions = await wm.listSessions();
        for (const session of sessions) {
          if (session.status !== 'capturing') continue;
          const stillLive = liveState?.isCapturing && liveState.activeSessionId === session.session_id;
          if (!stillLive) {
            await wm.saveSession({ ...session, status: 'recovered', ended_at: session.ended_at || new Date().toISOString() });
          } else {
            // Resume reflecting the live session in this panel, and reattach
            // a real adapter so Stop Capture actually has something to stop —
            // without this, a panel reopened mid-capture shows "capturing"
            // but pressing Stop is a no-op.
            const existingCaptures = await wm.listCaptures(session.session_id);
            const bytes = existingCaptures.reduce((acc, c) => acc + (c.response.body_size || 0), 0);
            setActiveSession(session);
            setCaptureCount(existingCaptures.length);
            setTotalBytes(bytes);
            if (liveState?.activeTabId) {
              const adapter = new PageNetworkCaptureAdapter(
                session.session_id,
                liveState.activeTabId,
                session.initial_page_url,
                attachCaptureCallback(session.session_id, wm)
              );
              adapterRef.current = adapter;
            }
            setIsCapturing(true);
          }
        }
      } catch {}
    };

    init();

    // Listen for broadcasts from the service worker. Delivery is plain
    // runtime messages, not a long-lived port — the worker can be killed
    // and restarted between messages at any time, and a port held open in
    // its global scope would silently stop being able to deliver anything
    // the moment that happens.
    const listener = (msg: any) => {
      if (msg?.type === 'CAPTURE_STATUS_CHANGED') {
        setIsCapturing(msg.isCapturing);
      }
    };
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(listener);
    }

    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
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
      setHasPersistentWorkspace(true);
    } catch (err: any) {
      console.warn('Directory picker cancelled:', err.message);
    }
  };

  // Toggle Page Capture
  const handleToggleCapture = async () => {
    setStartError(null);

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
      if (!hasPersistentWorkspace) {
        setStartError('Choose a workspace folder before starting capture.');
        return;
      }
      if (!activeTab?.id || !activeTab.url) {
        setStartError('Please open an active web page tab first.');
        return;
      }

      const sessionId = generateULID();
      const session: CaptureSession = {
        session_id: sessionId,
        name: `Page Capture: ${new URL(activeTab.url).hostname}`,
        started_at: new Date().toISOString(),
        initial_page_url: redactQueryParams(activeTab.url).sanitizedUrl,
        navigation_history: [],
        capture_count: 0,
        body_bytes: 0,
        application_version: '0.1.0',
        status: 'capturing',
      };

      const adapter = new PageNetworkCaptureAdapter(
        sessionId,
        activeTab.id,
        activeTab.url,
        attachCaptureCallback(sessionId, workspaceManager)
      );

      // Only report capture as active, and only persist the session, once
      // the service worker has confirmed the hook actually installed —
      // injection can fail (restricted page, expired activeTab grant, etc.)
      // and the UI must not claim to be recording when nothing is happening.
      try {
        await adapter.start();
      } catch (err: any) {
        setStartError(err?.message || 'Failed to start capture on this tab.');
        return;
      }

      setActiveSession(session);
      await workspaceManager.saveSession(session);
      adapterRef.current = adapter;
      setIsCapturing(true);
    }
  };

  // One-shot scrape of whatever table/grid is on the page right now.
  // Independent of Start/Stop Capture (network capture) — a user may want
  // one without the other. Reuses the active capture session if one is
  // already running, so both capture modes land in the same session; if
  // there's no active session yet, this creates a lightweight one so the
  // scrape still lands in the workspace and shows up when the Workbench
  // hydrates it.
  const handleScrapeTable = async () => {
    setScrapeStatus(null);

    if (!hasPersistentWorkspace) {
      setScrapeStatus({ message: 'Choose a workspace folder before scraping.', tone: 'error' });
      return;
    }
    if (!activeTab?.id) {
      setScrapeStatus({ message: 'Please open an active web page tab first.', tone: 'error' });
      return;
    }

    setIsScraping(true);
    try {
      let session = activeSession;
      if (!session) {
        session = {
          session_id: generateULID(),
          name: `Table Scrape: ${hostName}`,
          started_at: new Date().toISOString(),
          initial_page_url: activeTab.url ? redactQueryParams(activeTab.url).sanitizedUrl : '',
          navigation_history: [],
          capture_count: 0,
          body_bytes: 0,
          application_version: '0.1.0',
          status: 'new',
        };
        setActiveSession(session);
        await workspaceManager.saveSession(session);
      }

      const outcome = await captureTableFromActiveTab(session.session_id, activeTab.id);
      if (!outcome) {
        setScrapeStatus({ message: 'No table or grid found on this page.', tone: 'error' });
        return;
      }

      setCaptureCount(prev => prev + 1);
      setTotalBytes(prev => prev + (outcome.capture.response.body_size || 0));
      for (const cand of outcome.candidates) {
        setDetectedCollections(prev => {
          const next = new Map(prev);
          const cur = next.get(cand.suggested_name) || 0;
          next.set(cand.suggested_name, cur + cand.row_count);
          return next;
        });
      }
      await workspaceManager.saveCapture(session.session_id, outcome.capture, outcome.body);

      if (outcome.incomplete) {
        setScrapeStatus({
          message: `Captured ${outcome.rowCount} of ~${outcome.expectedRowCount} rows. This grid didn't respond to scrolling, so the scrape is likely partial — scroll through it manually first, then scrape again.`,
          tone: 'warning',
        });
      } else {
        setScrapeStatus({
          message: `Captured ${outcome.rowCount} rows (${outcome.strategy === 'table' ? 'plain table' : 'virtualized grid'}).`,
          tone: 'success',
        });
      }
    } catch (err: any) {
      setScrapeStatus({ message: err?.message || 'Failed to scrape this page.', tone: 'error' });
    } finally {
      setIsScraping(false);
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
            ? 'Recording JSON fetch & XHR responses requested by this page. Request headers and credentials are never collected.'
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

        {startError && (
          <div
            style={{
              fontSize: 12,
              color: colors.error,
              background: `${colors.error}11`,
              border: `1px solid ${colors.error}44`,
              borderRadius: 6,
              padding: '8px 10px',
            }}
          >
            {startError}
          </div>
        )}

        {!hasPersistentWorkspace && !isCapturing ? (
          <button
            onClick={handleSelectWorkspace}
            style={{
              background: 'linear-gradient(135deg, #0284c7, #2563eb)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            📁 Choose Workspace to Enable Capture
          </button>
        ) : (
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
        )}
      </div>

      {/* Scrape Visible Table / Grid — one-shot, independent of Start/Stop Capture */}
      <div
        style={{
          background: colors.panelBg,
          border: `1px solid ${colors.borderLight}`,
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: colors.text }}>🔲 Scrape Table on Page</div>
        <p style={{ margin: 0, fontSize: 12, color: colors.textMuted, lineHeight: 1.5 }}>
          Grabs whatever HTML table or grid is visible on this page right now — a one-time snapshot, not a live
          recording. Rows are captured exactly as displayed; large virtualized grids that don't respond to
          programmatic scrolling may only capture what's currently rendered.
        </p>

        {scrapeStatus && (
          <div
            style={{
              fontSize: 12,
              color:
                scrapeStatus.tone === 'error'
                  ? colors.error
                  : scrapeStatus.tone === 'warning'
                    ? colors.warning
                    : colors.success,
              background:
                scrapeStatus.tone === 'error'
                  ? `${colors.error}11`
                  : scrapeStatus.tone === 'warning'
                    ? `${colors.warning}11`
                    : `${colors.success}11`,
              border: `1px solid ${
                scrapeStatus.tone === 'error' ? colors.error : scrapeStatus.tone === 'warning' ? colors.warning : colors.success
              }44`,
              borderRadius: 6,
              padding: '8px 10px',
            }}
          >
            {scrapeStatus.message}
          </div>
        )}

        <button
          onClick={handleScrapeTable}
          disabled={isScraping || !hasPersistentWorkspace}
          style={{
            background: hasPersistentWorkspace ? colors.cardBg : colors.panelBg,
            color: hasPersistentWorkspace ? colors.text : colors.textDim,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: 6,
            padding: '10px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: hasPersistentWorkspace && !isScraping ? 'pointer' : 'not-allowed',
            opacity: isScraping ? 0.7 : 1,
          }}
        >
          {isScraping ? 'Scraping…' : '🔲 Scrape Table'}
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
