/**
 * WireData Side Panel Companion App
 * Capture controller, visible privacy status indicator, quick dataset counters,
 * inline table previewer, TypeScript interface generator, JSON Schema export,
 * 1-click CSV/JSONL export, and SQL runner launcher.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  CandidateCollection,
  CapturedRequest,
  CaptureSession,
  detectCandidateCollections,
  generateULID,
  redactQueryParams,
  serializeToCsv,
  ULID,
} from '@wiredata/core';
import {
  DirectoryHandleManager,
  FSDirectoryAdapter,
  createDefaultWorkspaceAdapter,
  WorkspaceManager,
} from '@wiredata/workspace';
import { colors, fonts } from '@wiredata/ui';
import { PageNetworkCaptureAdapter } from '../adapters/page.js';
import { captureTableFromActiveTab } from '../adapters/dom-table.js';

interface DiscoveredItem {
  id: string; // mode:domain:route:pointer
  name: string;
  domain: string;
  pageUrl: string;
  route: string;
  pointer: string;
  rowCount: number;
  capturesCount: number;
  source: string;
  rows: Record<string, any>[];
  captureRefs: Array<{ sessionId: ULID; captureId: ULID; bodyHash?: string }>;
}

// Generate clean TypeScript interface and JSON Schema from sample records
function generateTypesFromRows(name: string, rows: Record<string, any>[]): { tsInterface: string; jsonSchema: string } {
  const safeName = name.replace(/(?:^\w|[A-Z]|\b\w)/g, l => l.toUpperCase()).replace(/[\s\W_]+/g, '') || 'Item';
  if (!rows || rows.length === 0) {
    return {
      tsInterface: `export interface ${safeName} {\n  [key: string]: unknown;\n}`,
      jsonSchema: JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', title: safeName, type: 'object', properties: {} }, null, 2),
    };
  }

  const keys = Object.keys(rows[0]);
  const lines = [`export interface ${safeName} {`];
  const properties: Record<string, any> = {};

  for (const k of keys) {
    const sampleValues = rows.slice(0, 25).map(r => r[k]).filter(v => v !== null && v !== undefined);
    let sampleType = 'string';
    let jsonType = 'string';

    if (sampleValues.length > 0) {
      const val = sampleValues[0];
      if (typeof val === 'boolean') {
        sampleType = 'boolean';
        jsonType = 'boolean';
      } else if (typeof val === 'number') {
        sampleType = 'number';
        jsonType = Number.isInteger(val) ? 'integer' : 'number';
      } else if (Array.isArray(val)) {
        sampleType = 'unknown[]';
        jsonType = 'array';
      } else if (typeof val === 'object') {
        sampleType = 'Record<string, unknown>';
        jsonType = 'object';
      } else if (typeof val === 'string') {
        sampleType = 'string';
        jsonType = 'string';
      }
    }

    const keyIdent = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
    lines.push(`  ${keyIdent}: ${sampleType};`);
    properties[k] = { type: jsonType };
  }
  lines.push('}');

  const schemaObj = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: safeName,
    type: 'object',
    properties,
  };

  return {
    tsInterface: lines.join('\n'),
    jsonSchema: JSON.stringify(schemaObj, null, 2),
  };
}

export function SidePanelApp() {
  const appVersion = typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '0.1.9';
  const [activeTab, setActiveTab] = useState<{ id?: number; url?: string; title?: string } | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const isCapturingRef = useRef<boolean>(false);
  isCapturingRef.current = isCapturing;
  const [activeSession, setActiveSession] = useState<CaptureSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [scrapeStatus, setScrapeStatus] = useState<{ message: string; tone: 'success' | 'warning' | 'error' } | null>(null);
  const [domainPermissionGranted, setDomainPermissionGranted] = useState<boolean | null>(null);

  // Metrics & Discovered Collections
  const [captureCount, setCaptureCount] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [discoveredItems, setDiscoveredItems] = useState<DiscoveredItem[]>([]);
  const [allHistoryItems, setAllHistoryItems] = useState<DiscoveredItem[]>([]);
  const [viewMode, setViewMode] = useState<'session' | 'history'>('session');
  const [selectedDomainFilter, setSelectedDomainFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedBadge, setCopiedBadge] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<DiscoveredItem | null>(null);
  const [previewTab, setPreviewTab] = useState<'table' | 'typescript' | 'schema' | 'json'>('table');

  // Workspace: defaults to shared browser-local IndexedDB storage
  const [workspaceManager, setWorkspaceManager] = useState<WorkspaceManager>(
    () => new WorkspaceManager(createDefaultWorkspaceAdapter())
  );
  const [workspaceName, setWorkspaceName] = useState<string>('Browser Storage (Local)');
  const [hasPersistentWorkspace, setHasPersistentWorkspace] = useState<boolean>(false);

  const adapterRef = useRef<PageNetworkCaptureAdapter | null>(null);
  const pendingWritesRef = useRef<Set<Promise<unknown>>>(new Set());

  // Helper to extract hostname from URL
  const getDomainFromUrl = (rawUrl?: string): string => {
    if (!rawUrl) return 'Unknown Domain';
    try {
      return new URL(rawUrl).hostname || rawUrl;
    } catch {
      return rawUrl;
    }
  };

  const currentTabDomain = getDomainFromUrl(activeTab?.url);

  // Check active tab domain permission status
  const checkDomainPermission = async (tabUrl?: string) => {
    if (!tabUrl || !tabUrl.startsWith('http')) {
      setDomainPermissionGranted(null);
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.permissions?.contains) {
      try {
        const originPattern = `${new URL(tabUrl).origin}/*`;
        const has = await chrome.permissions.contains({ origins: [originPattern] });
        setDomainPermissionGranted(has);
      } catch {
        setDomainPermissionGranted(false);
      }
    }
  };

  const syncActiveTab = async () => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) return;
    try {
      // 1. Try querying active tab in last focused window
      let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let candidate = tabs.find(t => t.id && t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));

      // 2. If not found or focused on sidepanel, query active tabs across all windows
      if (!candidate) {
        tabs = await chrome.tabs.query({ active: true });
        candidate = tabs.find(t => t.id && t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
      }

      // 3. Fallback to any active tab
      if (!candidate && tabs[0]?.id) {
        candidate = tabs[0];
      }

      if (candidate?.id) {
        const foundTab = {
          id: candidate.id,
          url: candidate.url || candidate.pendingUrl || '',
          title: candidate.title || '',
        };
        setActiveTab(foundTab);
        checkDomainPermission(foundTab.url);
      }
    } catch {}
  };

  const loadAllHistory = async (wm: WorkspaceManager) => {
    try {
      const sessions = await wm.listSessions();
      const itemsMap = new Map<string, DiscoveredItem>();

      for (const sess of sessions) {
        const caps = await wm.listCaptures(sess.session_id);
        for (const cap of caps) {
          if (!cap.response.body_hash) continue;
          const body = await wm.getBodyObject(cap.response.body_hash);
          if (!body) continue;

          const candidates = detectCandidateCollections(body);
          const domain = getDomainFromUrl(cap.request.sanitized_url || sess.initial_page_url);

          for (const cand of candidates) {
            let extractedRows: Record<string, any>[] = [];
            if (!cand.pointer || cand.pointer === '' || cand.pointer === '/') {
              extractedRows = Array.isArray(body) ? body : [];
            } else {
              try {
                const ptrParts = cand.pointer.replace(/^\//, '').split('/');
                let cur: any = body;
                for (const part of ptrParts) {
                  if (cur && typeof cur === 'object') cur = cur[part];
                }
                extractedRows = Array.isArray(cur) ? cur : [];
              } catch {}
            }

            if (extractedRows.length > 0) {
              const colKey = `${domain}:${cand.suggested_name}:${cand.pointer}`;
              const existing = itemsMap.get(colKey);
              const combinedRows = existing ? [...existing.rows, ...extractedRows] : extractedRows;
              const capturesCount = existing ? existing.capturesCount + 1 : 1;
              const refs = existing
                ? [...existing.captureRefs, { sessionId: sess.session_id, captureId: cap.capture_id, bodyHash: cap.response.body_hash }]
                : [{ sessionId: sess.session_id, captureId: cap.capture_id, bodyHash: cap.response.body_hash }];

              itemsMap.set(colKey, {
                id: colKey,
                name: cand.suggested_name,
                domain,
                pageUrl: sess.initial_page_url || cap.request.sanitized_url,
                route: cap.request.route_template || cap.request.sanitized_url,
                pointer: cand.pointer,
                rowCount: combinedRows.length,
                capturesCount,
                source: `${domain} (JSON API)`,
                rows: combinedRows,
                captureRefs: refs,
              });
            }
          }
        }
      }
      setAllHistoryItems(Array.from(itemsMap.values()));
    } catch {}
  };

  const attachCaptureCallback = (sessionId: ULID, wm: WorkspaceManager) => (
    capture: CapturedRequest,
    rawBody: unknown,
    candidates: CandidateCollection[]
  ) => {
    setCaptureCount(prev => prev + 1);
    setTotalBytes(prev => prev + (capture.response.body_size || 0));

    const domain = getDomainFromUrl(capture.request.sanitized_url || activeTab?.url);

    if (candidates && candidates.length > 0) {
      for (const cand of candidates) {
        let extractedRows: Record<string, any>[] = [];
        if (!cand.pointer || cand.pointer === '' || cand.pointer === '/') {
          extractedRows = Array.isArray(rawBody) ? rawBody : [];
        } else {
          try {
            const ptrParts = cand.pointer.replace(/^\//, '').split('/');
            let cur: any = rawBody;
            for (const part of ptrParts) {
              if (cur && typeof cur === 'object') cur = cur[part];
            }
            extractedRows = Array.isArray(cur) ? cur : [];
          } catch {}
        }

        if (extractedRows.length > 0) {
          const colKey = `${domain}:${cand.suggested_name}:${cand.pointer}`;
          setDiscoveredItems(prev => {
            const existing = prev.find(x => x.id === colKey);
            const combinedRows = existing ? [...existing.rows, ...extractedRows] : extractedRows;
            const capturesCount = existing ? (existing.capturesCount || 1) + 1 : 1;
            const refs = existing ? [...existing.captureRefs, { sessionId, captureId: capture.capture_id, bodyHash: capture.response.body_hash }] : [{ sessionId, captureId: capture.capture_id, bodyHash: capture.response.body_hash }];
            const updatedItem: DiscoveredItem = {
              id: colKey,
              name: cand.suggested_name,
              domain,
              pageUrl: activeTab?.url || capture.request.sanitized_url,
              route: capture.request.route_template || capture.request.sanitized_url,
              pointer: cand.pointer,
              rowCount: combinedRows.length,
              capturesCount,
              source: `${domain} (JSON API)`,
              rows: combinedRows,
              captureRefs: refs,
            };
            return [updatedItem, ...prev.filter(x => x.id !== colKey)];
          });
        }
      }
    }

    const writePromise = wm.saveCapture(sessionId, capture, rawBody)
      .finally(() => {
        pendingWritesRef.current.delete(writePromise);
      });
    pendingWritesRef.current.add(writePromise);
  };

  useEffect(() => {
    const init = async () => {
      await syncActiveTab();

      // Check persistent workspace
      try {
        const cachedHandle = await DirectoryHandleManager.loadHandle();
        let wm = workspaceManager;
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

      let liveState: { isCapturing: boolean; activeTabId: number | null; activeSessionId: string | null } | null = null;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          liveState = await chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' });
        } catch {}
      }

      try {
        const sessions = await workspaceManager.listSessions();
        const staleCapturing = sessions.filter((s: CaptureSession) => s.status === 'capturing');
        for (const s of staleCapturing) {
          if (!liveState?.isCapturing || liveState.activeSessionId !== s.session_id) {
            await workspaceManager.saveSession({
              ...s,
              status: 'recovered',
              ended_at: s.ended_at || new Date().toISOString(),
            });
          }
        }
      } catch {}
    };

    init();

    const listener = (msg: any) => {
      if (msg?.type === 'CAPTURE_STATUS_CHANGED') {
        setIsCapturing(msg.isCapturing);
        if (!msg.isCapturing) {
          adapterRef.current = null;
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(listener);
    }

    const tabActivatedListener = async (activeInfo: { tabId: number; windowId: number }) => {
      if (isCapturingRef.current) return;
      await syncActiveTab();
    };

    const tabUpdatedListener = (tabId: number, changeInfo: any, tab: any) => {
      if (isCapturingRef.current) return;
      if (tab.active) {
        setActiveTab({ id: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title || '' });
        checkDomainPermission(tab.url || tab.pendingUrl);
      }
    };

    const windowFocusListener = () => {
      if (!isCapturingRef.current) {
        syncActiveTab();
      }
    };

    if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
      chrome.tabs.onActivated.addListener(tabActivatedListener);
    }
    if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener(tabUpdatedListener);
    }
    window.addEventListener('focus', windowFocusListener);

    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
      if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
        chrome.tabs.onActivated.removeListener(tabActivatedListener);
      }
      if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
        chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
      }
      window.removeEventListener('focus', windowFocusListener);
    };
  }, []);

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

  const handleToggleCapture = async () => {
    setStartError(null);

    if (isCapturing) {
      if (adapterRef.current) {
        await adapterRef.current.stop();
        adapterRef.current = null;
      }
      if (pendingWritesRef.current.size > 0) {
        await Promise.allSettled(Array.from(pendingWritesRef.current));
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
      let targetTab = activeTab;
      if (!targetTab?.id && typeof chrome !== 'undefined' && chrome.tabs?.query) {
        try {
          let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) {
            targetTab = { id: tabs[0].id, url: tabs[0].url || tabs[0].pendingUrl || '', title: tabs[0].title || '' };
            setActiveTab(targetTab);
          }
        } catch {}
      }

      if (!targetTab?.id) {
        setStartError('Please select an active web page tab to capture.');
        return;
      }

      if (targetTab.url?.startsWith('chrome')) {
        setStartError('Cannot capture browser internal pages.');
        return;
      }

      // Request on-demand host permission for the active tab's origin if needed
      if (typeof chrome !== 'undefined' && chrome.permissions?.request && targetTab.url) {
        try {
          const parsed = new URL(targetTab.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            const originPattern = `${parsed.origin}/*`;
            const hasPermission = await chrome.permissions.contains({ origins: [originPattern] }).catch(() => false);
            if (!hasPermission) {
              const granted = await chrome.permissions.request({ origins: [originPattern] }).catch(() => false);
              if (!granted) {
                setStartError(`Host permission for ${parsed.hostname} was not granted.`);
                return;
              }
            }
          }
        } catch {}
      }

      let hostNameClean = 'Active Web Tab';
      try { if (targetTab.url) hostNameClean = new URL(targetTab.url).hostname; } catch {}

      const sessionId = generateULID();
      const session: CaptureSession = {
        session_id: sessionId,
        name: `Page Capture: ${hostNameClean}`,
        started_at: new Date().toISOString(),
        initial_page_url: targetTab.url ? redactQueryParams(targetTab.url).sanitizedUrl : '',
        navigation_history: [],
        capture_count: 0,
        body_bytes: 0,
        application_version: appVersion,
        status: 'capturing',
      };

      const adapter = new PageNetworkCaptureAdapter(
        sessionId,
        targetTab.id,
        targetTab.url || '',
        attachCaptureCallback(sessionId, workspaceManager)
      );

      try {
        await adapter.start();
      } catch (err: any) {
        setStartError(err?.message || 'Failed to start capture.');
        return;
      }

      setActiveSession(session);
      await workspaceManager.saveSession(session);
      adapterRef.current = adapter;
      setIsCapturing(true);
    }
  };

  const handleScrapeTable = async () => {
    setScrapeStatus(null);
    setIsScraping(true);

    try {
      let targetTab = activeTab;
      if (!targetTab?.id && typeof chrome !== 'undefined' && chrome.tabs?.query) {
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          targetTab = { id: tabs[0].id, url: tabs[0].url || tabs[0].pendingUrl || '', title: tabs[0].title || '' };
          setActiveTab(targetTab);
        }
      }

      if (!targetTab?.id) {
        setScrapeStatus({ message: 'No active web page found to scrape.', tone: 'error' });
        return;
      }

      if (targetTab.url?.startsWith('chrome')) {
        setScrapeStatus({ message: 'Cannot scrape internal browser pages.', tone: 'error' });
        return;
      }

      // Request on-demand host permission for the active tab's origin if needed
      if (typeof chrome !== 'undefined' && chrome.permissions?.request && targetTab.url) {
        try {
          const parsed = new URL(targetTab.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            const originPattern = `${parsed.origin}/*`;
            const hasPermission = await chrome.permissions.contains({ origins: [originPattern] }).catch(() => false);
            if (!hasPermission) {
              const granted = await chrome.permissions.request({ origins: [originPattern] }).catch(() => false);
              if (!granted) {
                setScrapeStatus({ message: `Host permission for ${parsed.hostname} was not granted.`, tone: 'error' });
                return;
              }
            }
          }
        } catch {}
      }

      let session = activeSession;
      if (!session) {
        let hostNameClean = 'Active Web Tab';
        try { if (targetTab.url) hostNameClean = new URL(targetTab.url).hostname; } catch {}
        const sessionId = generateULID();
        session = {
          session_id: sessionId,
          name: `DOM Scrape: ${hostNameClean}`,
          started_at: new Date().toISOString(),
          initial_page_url: targetTab.url ? redactQueryParams(targetTab.url).sanitizedUrl : '',
          navigation_history: [],
          capture_count: 0,
          body_bytes: 0,
          application_version: appVersion,
          status: 'complete',
        };
        setActiveSession(session);
        await workspaceManager.saveSession(session);
      }

      const outcome = await captureTableFromActiveTab(session.session_id, targetTab.id);
      if (!outcome) {
        setScrapeStatus({ message: 'No HTML table or grid found on this page.', tone: 'error' });
        return;
      }

      setCaptureCount(prev => prev + 1);
      setTotalBytes(prev => prev + (outcome.capture.response.body_size || 0));

      if (outcome.body?.rows && outcome.body.rows.length > 0) {
        const tableName = outcome.candidates[0]?.suggested_name || 'scraped_table';
        const colKey = `dom:${outcome.capture.request.sanitized_url}:/`;
        setDiscoveredItems(prev => {
          const existing = prev.find(x => x.id === colKey);
          const combinedRows = existing ? [...existing.rows, ...outcome.body.rows] : outcome.body.rows;
          const capturesCount = existing ? (existing.capturesCount || 1) + 1 : 1;
          const refs = existing
            ? [...existing.captureRefs, { sessionId: session!.session_id, captureId: outcome.capture.capture_id, bodyHash: outcome.capture.response.body_hash }]
            : [{ sessionId: session!.session_id, captureId: outcome.capture.capture_id, bodyHash: outcome.capture.response.body_hash }];
          const updatedItem: DiscoveredItem = {
            id: colKey,
            name: tableName,
            domain: currentTabDomain,
            pageUrl: targetTab.url || outcome.capture.request.sanitized_url,
            route: outcome.capture.request.sanitized_url,
            pointer: '/',
            rowCount: combinedRows.length,
            capturesCount,
            source: outcome.strategy === 'table' ? `${currentTabDomain} (DOM Table)` : `${currentTabDomain} (Virtualized Grid)`,
            rows: combinedRows,
            captureRefs: refs,
          };
          return [updatedItem, ...prev.filter(x => x.id !== colKey)];
        });
      }

      await workspaceManager.saveCapture(session.session_id, outcome.capture, outcome.body);

      if (outcome.incomplete) {
        setScrapeStatus({
          message: `Captured ${outcome.rowCount} of ~${outcome.expectedRowCount} rows (scroll manually to load more).`,
          tone: 'warning',
        });
      } else {
        setScrapeStatus({
          message: `Scraped ${outcome.rowCount} rows (${outcome.strategy === 'table' ? 'HTML Table' : 'Grid'}).`,
          tone: 'success',
        });
      }
    } catch (err: any) {
      setScrapeStatus({ message: err?.message || 'Failed to scrape table.', tone: 'error' });
    } finally {
      setIsScraping(false);
    }
  };

  // 1-Click CSV Export (Formula safe)
  const handleExportCsv = (item: DiscoveredItem) => {
    if (!item.rows || item.rows.length === 0) return;
    const headers = Object.keys(item.rows[0]);
    const mockSchema: Record<string, any> = {};
    headers.forEach((h, i) => {
      mockSchema[h] = { name: h, original_name: h, logical_type: 'VARCHAR', inferred_type: 'VARCHAR', is_visible: true, order: i };
    });
    const mockRows = item.rows.map(r => ({
      values: r,
      lineage: { capture_id: item.captureRefs[0]?.captureId || '', record_pointer: item.pointer, captured_at: new Date().toISOString() },
      field_lineage: {},
    }));
    const csvContent = serializeToCsv(mockRows as any, mockSchema, false, { spreadsheetSafe: true });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 1-Click JSONL Export
  const handleExportJsonl = (item: DiscoveredItem) => {
    if (!item.rows || item.rows.length === 0) return;
    const content = item.rows.map(r => JSON.stringify(r)).join('\n');
    const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.name}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 1-Click Copy JSON
  const handleCopyJson = (item: DiscoveredItem) => {
    navigator.clipboard.writeText(JSON.stringify(item.rows, null, 2));
    setCopiedBadge(`${item.name}_json`);
    setTimeout(() => setCopiedBadge(null), 2000);
  };

  // 1-Click Copy TypeScript Interface
  const handleCopyTypes = (item: DiscoveredItem) => {
    const { tsInterface } = generateTypesFromRows(item.name, item.rows);
    navigator.clipboard.writeText(tsInterface);
    setCopiedBadge(`${item.name}_ts`);
    setTimeout(() => setCopiedBadge(null), 2000);
  };

  // 1-Click Copy JSON Schema
  const handleCopySchema = (item: DiscoveredItem) => {
    const { jsonSchema } = generateTypesFromRows(item.name, item.rows);
    navigator.clipboard.writeText(jsonSchema);
    setCopiedBadge(`${item.name}_schema`);
    setTimeout(() => setCopiedBadge(null), 2000);
  };

  // 1-Click SQL Runner Jump
  const handleJumpToSql = (item: DiscoveredItem) => {
    const query = `SELECT * FROM ${item.name} LIMIT 50;`;
    const targetUrl = chrome?.runtime?.getURL
      ? chrome.runtime.getURL(`workbench.html?sql=${encodeURIComponent(query)}&tab=sql`)
      : `/workbench.html?sql=${encodeURIComponent(query)}&tab=sql`;
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: targetUrl });
    } else {
      window.open(targetUrl, '_blank');
    }
  };

  const handleClearAllItems = async () => {
    setDiscoveredItems([]);
    setAllHistoryItems([]);
    setCaptureCount(0);
    setTotalBytes(0);
    setScrapeStatus(null);
    setPreviewItem(null);
    try {
      if (activeSession) {
        const caps = await workspaceManager.listCaptures(activeSession.session_id);
        for (const c of caps) {
          await workspaceManager.deleteCapture(activeSession.session_id, c.capture_id);
        }
        await workspaceManager.gcOrphanedObjects();
      }
    } catch {}
  };

  const handleRemoveItem = (id: string) => {
    setDiscoveredItems(prev => prev.filter(x => x.id !== id));
    setAllHistoryItems(prev => prev.filter(x => x.id !== id));
    if (previewItem?.id === id) setPreviewItem(null);
    setScrapeStatus(null);
  };

  const handleOpenWorkbench = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') });
    } else {
      window.open('/workbench.html', '_blank');
    }
  };

  const isWorkbenchTab = !!activeTab?.url?.includes('workbench.html');
  const isRestrictedPage = !activeTab?.url || activeTab.url.startsWith('chrome');
  const hostName = activeTab?.url && !isRestrictedPage ? currentTabDomain : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: colors.bg, fontFamily: fonts.body, color: colors.text, padding: 16, userSelect: 'none', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg, #0284c7, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, color: '#ffffff' }}>W</div>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>WireData</span>
          <span style={{ fontSize: 10, color: colors.textDim, fontFamily: fonts.mono }}>v{appVersion}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={handleOpenWorkbench}
            title="Open Full SQL Data Workbench"
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.borderLight}`,
              color: colors.primaryLight,
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            📊 Workbench ↗
          </button>
        </div>
      </div>

      {/* Target Tab Host & Domain Card */}
      <div style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: colors.textDim, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>Active Web Page</span>
          <button
            onClick={syncActiveTab}
            title="Re-sync current active browser tab"
            style={{
              background: 'transparent',
              border: 'none',
              color: colors.primaryLight,
              fontSize: 11,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              padding: 0,
            }}
          >
            🔄 Sync Tab
          </button>
        </div>

        {hostName ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: colors.primaryLight, wordBreak: 'break-all', fontFamily: fonts.mono }}>
                {hostName}
              </div>
              {domainPermissionGranted !== null && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: domainPermissionGranted ? '#10b98122' : `${colors.warning}22`,
                    color: domainPermissionGranted ? '#10b981' : colors.warning,
                    border: `1px solid ${domainPermissionGranted ? '#10b98144' : `${colors.warning}44`}`,
                  }}
                >
                  {domainPermissionGranted ? '✓ Authorized' : '🔒 Prompt on Capture'}
                </span>
              )}
            </div>
            {activeTab?.title && (
              <div style={{ fontSize: 11, color: colors.textDim, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeTab.title}
              </div>
            )}
          </div>
        ) : isWorkbenchTab ? (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: colors.primaryLight }}>📊 WireData Workbench Active</div>
            <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>Switch to any website tab to record live API traffic or scrape tables.</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: colors.warning }}>⚠️ No Active Web Page</div>
            <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>Open or focus any website to record JSON traffic.</div>
          </div>
        )}
      </div>

      {/* Capture Controller Banner */}
      <div style={{ background: isCapturing ? `${colors.error}11` : colors.panelBg, border: `1px solid ${isCapturing ? colors.error : colors.borderLight}`, borderRadius: 10, padding: 14, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: isCapturing ? colors.error : colors.textDim, boxShadow: isCapturing ? `0 0 10px ${colors.error}` : 'none' }} />
            <span style={{ fontWeight: 700, fontSize: 12, color: isCapturing ? colors.error : colors.textMuted }}>{isCapturing ? '● CAPTURING THIS TAB' : '○ CAPTURE OFF'}</span>
          </div>
          {isCapturing && (
            <div style={{ display: 'flex', gap: 10, fontSize: 11, fontFamily: fonts.mono, color: colors.text }}>
              <div><strong style={{ color: colors.primaryLight }}>{captureCount}</strong> reqs</div>
              <div><strong style={{ color: colors.primaryLight }}>{(totalBytes / 1024).toFixed(1)}</strong> KB</div>
            </div>
          )}
        </div>
        {startError && (
          <div style={{ fontSize: 11, color: colors.error, background: `${colors.error}11`, border: `1px solid ${colors.error}44`, borderRadius: 6, padding: '6px 8px' }}>{startError}</div>
        )}
        <div style={{ fontSize: 10, color: colors.textDim, lineHeight: 1.4 }}>
          🔒 Captures JSON response bodies and sanitized request URLs from this tab only. Stored locally on your device; nothing is sent to WireData.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button onClick={handleToggleCapture} style={{ background: isCapturing ? colors.error : 'linear-gradient(135deg, #0284c7, #2563eb)', color: '#ffffff', border: 'none', borderRadius: 6, padding: '10px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', boxShadow: isCapturing ? `0 0 12px ${colors.error}44` : '0 4px 12px rgba(2, 132, 199, 0.3)' }}>
            {isCapturing ? '⏹ Stop Capture' : '⏺ Start Capture'}
          </button>
          <button
            onClick={handleScrapeTable}
            disabled={isScraping || isCapturing}
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.borderLight}`,
              color: isScraping ? colors.textDim : colors.text,
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: isScraping || isCapturing ? 'not-allowed' : 'pointer',
            }}
          >
            {isScraping ? '⏳ Scraping...' : '📑 Scrape Table'}
          </button>
        </div>
        {scrapeStatus && (
          <div style={{ fontSize: 11, padding: '6px 8px', borderRadius: 6, background: scrapeStatus.tone === 'success' ? '#10b98122' : scrapeStatus.tone === 'warning' ? `${colors.warning}22` : `${colors.error}22`, color: scrapeStatus.tone === 'success' ? '#10b981' : scrapeStatus.tone === 'warning' ? colors.warning : colors.error, border: `1px solid ${scrapeStatus.tone === 'success' ? '#10b98144' : scrapeStatus.tone === 'warning' ? `${colors.warning}44` : `${colors.error}44`}` }}>
            {scrapeStatus.message}
          </div>
        )}
      </div>

      {/* Discovered Datasets & Actions (Session-Centric Power Section) */}
      {(() => {
        const rawPool = viewMode === 'session' ? discoveredItems : allHistoryItems;

        // Compute available domains for filter chips
        const uniqueDomains = Array.from(new Set(rawPool.map(x => x.domain).filter(Boolean)));

        const domainFiltered = selectedDomainFilter === 'ALL'
          ? rawPool
          : rawPool.filter(x => x.domain === selectedDomainFilter);

        const visibleItems = searchQuery.trim()
          ? domainFiltered.filter(item =>
              item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
              item.domain.toLowerCase().includes(searchQuery.toLowerCase()) ||
              (item.rows[0] && Object.keys(item.rows[0]).some(k => k.toLowerCase().includes(searchQuery.toLowerCase())))
            )
          : domainFiltered;

        return (
          <div style={{ marginBottom: 12 }}>
            {/* Session vs History Tabs */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 6 }}>
              <div style={{ display: 'flex', background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: 2 }}>
                <button
                  onClick={() => { setViewMode('session'); setSelectedDomainFilter('ALL'); }}
                  style={{
                    background: viewMode === 'session' ? colors.cardBg : 'transparent',
                    color: viewMode === 'session' ? colors.primaryLight : colors.textDim,
                    border: 'none',
                    borderRadius: 4,
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <span>⏺ Current Session</span>
                  <span style={{ fontSize: 10, background: viewMode === 'session' ? `${colors.primaryLight}22` : 'transparent', padding: '1px 5px', borderRadius: 4 }}>
                    {discoveredItems.length}
                  </span>
                </button>
                <button
                  onClick={async () => {
                    setViewMode('history');
                    setSelectedDomainFilter('ALL');
                    await loadAllHistory(workspaceManager);
                  }}
                  style={{
                    background: viewMode === 'history' ? colors.cardBg : 'transparent',
                    color: viewMode === 'history' ? colors.primaryLight : colors.textDim,
                    border: 'none',
                    borderRadius: 4,
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <span>📁 Saved History</span>
                  <span style={{ fontSize: 10, background: viewMode === 'history' ? `${colors.primaryLight}22` : 'transparent', padding: '1px 5px', borderRadius: 4 }}>
                    {allHistoryItems.length}
                  </span>
                </button>
              </div>

              {visibleItems.length > 0 && (
                <button
                  onClick={handleClearAllItems}
                  title="Clear dataset list"
                  style={{
                    background: 'transparent',
                    border: `1px solid ${colors.error}44`,
                    color: colors.error,
                    borderRadius: 4,
                    padding: '3px 7px',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Clear All
                </button>
              )}
            </div>

            {/* Domain Filter Pills (Shown only when multiple domains exist) */}
            {uniqueDomains.length > 1 && (
              <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 6, marginBottom: 8 }}>
                <button
                  onClick={() => setSelectedDomainFilter('ALL')}
                  style={{
                    background: selectedDomainFilter === 'ALL' ? colors.primaryLight : colors.cardBg,
                    color: selectedDomainFilter === 'ALL' ? '#ffffff' : colors.textDim,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: 12,
                    padding: '2px 8px',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  All Sources ({rawPool.length})
                </button>
                {uniqueDomains.map(d => {
                  const count = rawPool.filter(x => x.domain === d).length;
                  return (
                    <button
                      key={d}
                      onClick={() => setSelectedDomainFilter(d)}
                      style={{
                        background: selectedDomainFilter === d ? colors.primaryLight : colors.cardBg,
                        color: selectedDomainFilter === d ? '#ffffff' : colors.textDim,
                        border: `1px solid ${colors.borderLight}`,
                        borderRadius: 12,
                        padding: '2px 8px',
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d} ({count})
                    </button>
                  );
                })}
              </div>
            )}

            {/* Quick Search */}
            {rawPool.length > 2 && (
              <div style={{ marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder="🔍 Filter datasets or column names..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    background: colors.cardBg,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 11,
                    color: colors.text,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            {visibleItems.length === 0 ? (
              <div style={{ background: colors.panelBg, border: `1px dashed ${colors.borderLight}`, borderRadius: 8, padding: '16px 12px', textAlign: 'center', color: colors.textDim, fontSize: 11 }}>
                <div>
                  {viewMode === 'session'
                    ? 'No datasets captured in this session yet.'
                    : 'No saved capture sessions found in workspace storage.'}
                </div>
                {viewMode === 'session' && (
                  <div style={{ marginTop: 4, fontSize: 10, color: colors.textDim }}>
                    Click <strong>⏺ Start Capture</strong> to record API calls or <strong>📑 Scrape Table</strong> to extract page data.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visibleItems.map(item => (
                <div
                  key={item.id}
                  style={{
                    background: colors.cardBg,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: 8,
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: colors.primaryLight, fontFamily: fonts.mono }}>
                        {item.name}
                      </span>
                      <span style={{ fontSize: 10, color: colors.textDim, background: `${colors.panelBg}`, padding: '2px 6px', borderRadius: 4 }}>
                        {item.rowCount} rows{item.capturesCount > 1 ? ` (${item.capturesCount} reqs)` : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: colors.textDim, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.domain}>
                        {item.domain}
                      </span>
                      <button
                        onClick={() => handleRemoveItem(item.id)}
                        title={`Remove ${item.name}`}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: colors.textDim,
                          fontSize: 13,
                          cursor: 'pointer',
                          padding: '0 4px',
                          lineHeight: 1,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Primary & Quick Actions Bar */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
                    <button
                      onClick={() => {
                        setPreviewItem(item);
                        setPreviewTab('table');
                      }}
                      title="Inspect table records and columns"
                      style={{
                        background: colors.panelBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: colors.text,
                        borderRadius: 4,
                        padding: '5px 4px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                    >
                      👁️ View
                    </button>
                    <button
                      onClick={() => handleExportCsv(item)}
                      title="Download as CSV spreadsheet"
                      style={{
                        background: colors.panelBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: colors.success,
                        borderRadius: 4,
                        padding: '5px 4px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                    >
                      💾 CSV
                    </button>
                    <button
                      onClick={() => handleExportJsonl(item)}
                      title="Download as JSON Lines (JSONL)"
                      style={{
                        background: colors.panelBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: colors.primaryLight,
                        borderRadius: 4,
                        padding: '5px 4px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                    >
                      📄 JSONL
                    </button>
                    <button
                      onClick={() => handleCopyTypes(item)}
                      title="Copy TypeScript interface"
                      style={{
                        background: colors.panelBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: copiedBadge === `${item.name}_ts` ? colors.success : colors.accent,
                        borderRadius: 4,
                        padding: '5px 4px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                    >
                      {copiedBadge === `${item.name}_ts` ? '✓' : 'TS'}
                    </button>
                    <button
                      onClick={() => handleJumpToSql(item)}
                      title="Query with SQL in Workbench"
                      style={{
                        background: `${colors.primary}18`,
                        border: `1px solid ${colors.primary}44`,
                        color: colors.primaryLight,
                        borderRadius: 4,
                        padding: '5px 4px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'center',
                      }}
                    >
                      ⚡ SQL
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    })()}



      {/* Primary Transition Action to Full Workbench */}
      <div style={{ marginTop: 'auto', paddingTop: 10 }}>
        <button
          onClick={handleOpenWorkbench}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, #1e293b, #0f172a)',
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            padding: '12px 14px',
            color: '#f8fafc',
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Open Full SQL Workbench</span>
            <span>↗</span>
          </div>
          <span style={{ fontSize: 10, color: colors.textDim }}>
            For multi-table joins, DuckDB SQL queries, and dataset lineage
          </span>
        </button>
      </div>

      {/* Rich Multi-Format Inspector Modal */}
      {previewItem && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 1000,
            padding: 12,
          }}
        >
          <div
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              overflow: 'hidden',
            }}
          >
            {/* Modal Header */}
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <strong style={{ fontSize: 13, color: colors.primaryLight, fontFamily: fonts.mono }}>
                  {previewItem.name}
                </strong>
                <span style={{ fontSize: 11, color: colors.textDim, marginLeft: 8 }}>
                  ({previewItem.rowCount} rows)
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => handleExportCsv(previewItem)}
                  style={{
                    background: colors.panelBg,
                    border: `1px solid ${colors.borderLight}`,
                    color: colors.success,
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  💾 CSV
                </button>
                <button
                  onClick={() => handleExportJsonl(previewItem)}
                  style={{
                    background: colors.panelBg,
                    border: `1px solid ${colors.borderLight}`,
                    color: colors.primaryLight,
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  📄 JSONL
                </button>
                <button
                  onClick={() => setPreviewItem(null)}
                  style={{
                    background: colors.panelBg,
                    border: `1px solid ${colors.borderLight}`,
                    color: colors.text,
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal Format Switcher Tabs */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${colors.borderLight}`, background: colors.panelBg, padding: '4px 8px', gap: 4 }}>
              {(['table', 'typescript', 'schema', 'json'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setPreviewTab(tab)}
                  style={{
                    background: previewTab === tab ? colors.cardBg : 'transparent',
                    color: previewTab === tab ? colors.primaryLight : colors.textMuted,
                    border: `1px solid ${previewTab === tab ? colors.borderLight : 'transparent'}`,
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {tab === 'table' ? '📊 Table' : tab === 'typescript' ? '📄 TypeScript' : tab === 'schema' ? '📋 JSON Schema' : '📦 Raw JSON'}
                </button>
              ))}
            </div>

            {/* Modal Content */}
            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {previewTab === 'table' && (
                previewItem.rows.length > 0 ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: fonts.mono }}>
                    <thead>
                      <tr>
                        {Object.keys(previewItem.rows[0]).map(h => (
                          <th
                            key={h}
                            style={{
                              background: colors.panelBg,
                              padding: '6px 8px',
                              border: `1px solid ${colors.border}`,
                              textAlign: 'left',
                              color: colors.textDim,
                              position: 'sticky',
                              top: 0,
                              zIndex: 1,
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewItem.rows.map((row, idx) => (
                        <tr key={idx} style={{ background: idx % 2 === 0 ? 'transparent' : `${colors.panelBg}44` }}>
                          {Object.keys(previewItem.rows[0]).map(h => (
                            <td
                              key={h}
                              style={{
                                padding: '5px 8px',
                                border: `1px solid ${colors.borderLight}`,
                                color: colors.text,
                                whiteSpace: 'nowrap',
                                maxWidth: 160,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {typeof row[h] === 'object' ? JSON.stringify(row[h]) : String(row[h] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: 20, textAlign: 'center', color: colors.textDim, fontSize: 12 }}>
                    No rows in this collection.
                  </div>
                )
              )}

              {previewTab === 'typescript' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                    <button
                      onClick={() => handleCopyTypes(previewItem)}
                      style={{
                        background: colors.cardBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: copiedBadge === `${previewItem.name}_ts` ? colors.success : colors.primaryLight,
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {copiedBadge === `${previewItem.name}_ts` ? '✓ Copied Interface!' : '📋 Copy TypeScript'}
                    </button>
                  </div>
                  <pre style={{ margin: 0, flex: 1, background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: 10, fontSize: 11, fontFamily: fonts.mono, color: colors.primaryLight, overflow: 'auto' }}>
                    {generateTypesFromRows(previewItem.name, previewItem.rows).tsInterface}
                  </pre>
                </div>
              )}

              {previewTab === 'schema' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                    <button
                      onClick={() => handleCopySchema(previewItem)}
                      style={{
                        background: colors.cardBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: copiedBadge === `${previewItem.name}_schema` ? colors.success : colors.primaryLight,
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {copiedBadge === `${previewItem.name}_schema` ? '✓ Copied Schema!' : '📋 Copy JSON Schema'}
                    </button>
                  </div>
                  <pre style={{ margin: 0, flex: 1, background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: 10, fontSize: 11, fontFamily: fonts.mono, color: colors.accent, overflow: 'auto' }}>
                    {generateTypesFromRows(previewItem.name, previewItem.rows).jsonSchema}
                  </pre>
                </div>
              )}

              {previewTab === 'json' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                    <button
                      onClick={() => handleCopyJson(previewItem)}
                      style={{
                        background: colors.cardBg,
                        border: `1px solid ${colors.borderLight}`,
                        color: copiedBadge === `${previewItem.name}_json` ? colors.success : colors.primaryLight,
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {copiedBadge === `${previewItem.name}_json` ? '✓ Copied JSON!' : '📋 Copy JSON'}
                    </button>
                  </div>
                  <pre style={{ margin: 0, flex: 1, background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: 10, fontSize: 11, fontFamily: fonts.mono, color: colors.text, overflow: 'auto' }}>
                    {JSON.stringify(previewItem.rows, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

