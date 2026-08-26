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
  name: string;
  rowCount: number;
  capturesCount: number;
  source: string;
  rows: Record<string, any>[];
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

// Smart deduplication for row records (by primary key ID or content hash)
function deduplicateRecordObjects(existingRows: Record<string, any>[], newRows: Record<string, any>[]): Record<string, any>[] {
  const combined = [...existingRows, ...newRows];
  if (combined.length === 0) return [];

  const firstRow = combined[0];
  const keys = Object.keys(firstRow);
  const idCol = keys.find(k => /^(id|_id|uuid|key|code|order_id|user_id|item_id)$/i.test(k));

  const seen = new Set<string>();
  const uniqueRows: Record<string, any>[] = [];

  for (const row of combined) {
    let key: string;
    if (idCol && row[idCol] !== undefined && row[idCol] !== null) {
      key = String(row[idCol]);
    } else {
      key = JSON.stringify(row);
    }

    if (!seen.has(key)) {
      seen.add(key);
      uniqueRows.push(row);
    }
  }

  return uniqueRows;
}

export function SidePanelApp() {
  const appVersion = typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '0.1.6';
  const [activeTab, setActiveTab] = useState<{ id?: number; url?: string; title?: string } | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeSession, setActiveSession] = useState<CaptureSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [scrapeStatus, setScrapeStatus] = useState<{ message: string; tone: 'success' | 'warning' | 'error' } | null>(null);

  // Metrics & Discovered Collections
  const [captureCount, setCaptureCount] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [discoveredItems, setDiscoveredItems] = useState<DiscoveredItem[]>([]);
  const [allHistoryItems, setAllHistoryItems] = useState<DiscoveredItem[]>([]);
  const [viewScope, setViewScope] = useState<'current' | 'all'>('current');
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
          const cands = detectCandidateCollections(body);
          for (const cand of cands) {
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
              const name = cand.suggested_name === 'rows' && cap.capture_mode === 'dom' ? 'scraped_table' : cand.suggested_name;
              const existing = itemsMap.get(name);
              const combined = existing
                ? deduplicateRecordObjects(existing.rows, extractedRows)
                : extractedRows;
              const count = existing ? existing.capturesCount + 1 : 1;
              itemsMap.set(name, {
                name,
                rowCount: combined.length,
                capturesCount: count,
                source: cap.capture_mode === 'dom' ? 'DOM Table' : `JSON API (${cap.request.method})`,
                rows: combined,
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
          setDiscoveredItems(prev => {
            const existing = prev.find(x => x.name === cand.suggested_name);
            const combinedRows = existing
              ? deduplicateRecordObjects(existing.rows, extractedRows)
              : extractedRows;
            const capturesCount = existing ? (existing.capturesCount || 1) + 1 : 1;
            const updatedItem: DiscoveredItem = {
              name: cand.suggested_name,
              rowCount: combinedRows.length,
              capturesCount,
              source: `JSON API (${capture.request.method})`,
              rows: combinedRows,
            };
            return [updatedItem, ...prev.filter(x => x.name !== cand.suggested_name)];
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
      try {
        const params = new URLSearchParams(window.location.search);
        const pId = params.get('tabId');
        const pUrl = params.get('tabUrl');
        if (pId) {
          setActiveTab({ id: Number(pId), url: pUrl ? decodeURIComponent(pUrl) : '', title: '' });
        }
      } catch {}

      if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
        try {
          let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) {
            setActiveTab(prev => ({
              id: tabs[0].id ?? prev?.id,
              url: tabs[0].url || tabs[0].pendingUrl || prev?.url || '',
              title: tabs[0].title || prev?.title || '',
            }));
          }
        } catch (err) {
          console.warn('Tab query error:', err);
        }
      }

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

      let liveState: { isCapturing: boolean; activeTabId: number | null; activeSessionId: string | null } | null = null;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          liveState = await chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' });
        } catch {}
      }

      try {
        const sessions = await wm.listSessions();
        const staleCapturing = sessions.filter((s: CaptureSession) => s.status === 'capturing');
        for (const s of staleCapturing) {
          if (!liveState?.isCapturing || liveState.activeSessionId !== s.session_id) {
            await wm.saveSession({
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
      if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
        try {
          const tab = await chrome.tabs.get(activeInfo.tabId);
          if (tab?.id) {
            setActiveTab({ id: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title || '' });
          }
        } catch {}
      }
    };

    if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
      chrome.tabs.onActivated.addListener(tabActivatedListener);
    }

    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
      if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
        chrome.tabs.onActivated.removeListener(tabActivatedListener);
      }
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
      setScrapeStatus({ message: 'Please open an active web page tab first.', tone: 'error' });
      return;
    }

    setIsScraping(true);
    try {
      let session = activeSession;
      if (!session) {
        session = {
          session_id: generateULID(),
          name: `Table Scrape: ${hostName || 'Active Tab'}`,
          started_at: new Date().toISOString(),
          initial_page_url: targetTab.url ? redactQueryParams(targetTab.url).sanitizedUrl : '',
          navigation_history: [],
          capture_count: 0,
          body_bytes: 0,
          application_version: appVersion,
          status: 'new',
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
        setDiscoveredItems(prev => {
          const existing = prev.find(x => x.name === tableName);
          const combinedRows = existing
            ? deduplicateRecordObjects(existing.rows, outcome.body.rows)
            : outcome.body.rows;
          const capturesCount = existing ? (existing.capturesCount || 1) + 1 : 1;
          const updatedItem: DiscoveredItem = {
            name: tableName,
            rowCount: combinedRows.length,
            capturesCount,
            source: outcome.strategy === 'table' ? 'DOM Table' : 'Virtualized Grid',
            rows: combinedRows,
          };
          return [updatedItem, ...prev.filter(x => x.name !== tableName)];
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

  // 1-Click CSV Export
  const handleExportCsv = (item: DiscoveredItem) => {
    if (!item.rows || item.rows.length === 0) return;
    const headers = Object.keys(item.rows[0]);
    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csvContent = [
      headers.map(escapeCsv).join(','),
      ...item.rows.map(row => headers.map(h => escapeCsv(row[h])).join(',')),
    ].join('\n');
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

  const handleLoadSampleData = () => {
    const sampleOrders: DiscoveredItem = {
      name: 'orders',
      rowCount: 5,
      capturesCount: 1,
      source: 'Sample Data',
      rows: [
        { id: 'ORD-1001', customer: 'Alice Smith', email: 'alice@example.com', items_count: 3, total_amount: 149.99, status: 'completed' },
        { id: 'ORD-1002', customer: 'Bob Jones', email: 'bob@example.com', items_count: 1, total_amount: 49.50, status: 'shipped' },
        { id: 'ORD-1003', customer: 'Charlie Brown', email: 'charlie@example.com', items_count: 5, total_amount: 320.00, status: 'processing' },
        { id: 'ORD-1004', customer: 'Diana Prince', email: 'diana@example.com', items_count: 2, total_amount: 89.90, status: 'completed' },
        { id: 'ORD-1005', customer: 'Evan Wright', email: 'evan@example.com', items_count: 4, total_amount: 210.25, status: 'pending' },
      ],
    };
    const sampleProducts: DiscoveredItem = {
      name: 'products',
      rowCount: 4,
      capturesCount: 1,
      source: 'Sample Data',
      rows: [
        { id: 'PROD-101', name: 'Wireless Keyboard', category: 'Hardware', in_stock: true, unit_price: 129.99 },
        { id: 'PROD-102', name: 'Ultra-Wide 4K Monitor', category: 'Hardware', in_stock: true, unit_price: 499.00 },
        { id: 'PROD-103', name: 'Standing Desk', category: 'Furniture', in_stock: false, unit_price: 650.00 },
        { id: 'PROD-104', name: 'Dual 4K Dock', category: 'Accessories', in_stock: true, unit_price: 89.50 },
      ],
    };
    setDiscoveredItems([sampleOrders, sampleProducts]);
    setCaptureCount(prev => prev + 2);
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
  const hostName = activeTab?.url && !isRestrictedPage ? (() => { try { return new URL(activeTab.url).hostname; } catch { return activeTab.url; } })() : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: colors.bg, fontFamily: fonts.body, color: colors.text, padding: 16, userSelect: 'none', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg, #0284c7, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, color: '#ffffff' }}>W</div>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>WireData</span>
          <span style={{ fontSize: 10, color: colors.textDim, fontFamily: fonts.mono }}>v{appVersion}</span>
        </div>
        <button onClick={handleLoadSampleData} title="Instantly load sample datasets for testing" style={{ background: `${colors.accent}18`, border: `1px solid ${colors.accent}44`, color: colors.accent, borderRadius: 6, padding: '4px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>⚡ Sample Data</button>
      </div>

      {/* Target Tab Host Card */}
      <div style={{ background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: colors.textDim, textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>Target Page</div>
        {hostName ? (
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.primaryLight, wordBreak: 'break-all', fontFamily: fonts.mono }}>{hostName}</div>
        ) : isWorkbenchTab ? (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: colors.primaryLight }}>📊 WireData Workbench Active</div>
            <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>Switch to any website tab to record live API traffic.</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: colors.warning }}>⚠️ No Active Web Page</div>
            <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2 }}>Open any website to record JSON traffic.</div>
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
        <button onClick={handleToggleCapture} style={{ background: isCapturing ? colors.error : 'linear-gradient(135deg, #0284c7, #2563eb)', color: '#ffffff', border: 'none', borderRadius: 6, padding: '10px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: isCapturing ? `0 0 12px ${colors.error}44` : '0 4px 12px rgba(2, 132, 199, 0.3)' }}>{isCapturing ? '⏹ Stop Capture' : '⏺ Start Capture'}</button>
      </div>

      {/* Discovered Collections & Direct Actions (The Power Section) */}
      {(() => {
        const allItems = viewScope === 'current' ? discoveredItems : (allHistoryItems.length > 0 ? allHistoryItems : discoveredItems);
        const visibleItems = searchQuery.trim()
          ? allItems.filter(item =>
              item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
              (item.rows[0] && Object.keys(item.rows[0]).some(k => k.toLowerCase().includes(searchQuery.toLowerCase())))
            )
          : allItems;

        if (allItems.length === 0 && discoveredItems.length === 0) return null;

        return (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: colors.textDim, letterSpacing: '0.04em' }}>
                📦 Collections ({visibleItems.length})
              </div>
              <div style={{ display: 'flex', background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 4, padding: 2 }}>
                <button
                  onClick={() => setViewScope('current')}
                  style={{
                    background: viewScope === 'current' ? colors.cardBg : 'transparent',
                    color: viewScope === 'current' ? colors.primaryLight : colors.textDim,
                    border: 'none',
                    borderRadius: 3,
                    padding: '2px 8px',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  🌐 Current Page
                </button>
                <button
                  onClick={async () => {
                    setViewScope('all');
                    await loadAllHistory(workspaceManager);
                  }}
                  style={{
                    background: viewScope === 'all' ? colors.cardBg : 'transparent',
                    color: viewScope === 'all' ? colors.primaryLight : colors.textDim,
                    border: 'none',
                    borderRadius: 3,
                    padding: '2px 8px',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  📁 All History
                </button>
              </div>
            </div>

            {/* Quick Filter Search */}
            {allItems.length > 1 && (
              <div style={{ marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder="🔍 Filter collections or fields..."
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visibleItems.map(item => (
                <div
                  key={item.name}
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
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 13, color: colors.primaryLight, fontFamily: fonts.mono }}>
                        {item.name}
                      </span>
                      <span style={{ marginLeft: 6, fontSize: 11, color: colors.textDim, background: `${colors.panelBg}`, padding: '2px 6px', borderRadius: 4 }}>
                        {item.rowCount} rows{item.capturesCount > 1 ? ` (${item.capturesCount} captures)` : ''}
                      </span>
                    </div>
                    <span style={{ fontSize: 10, color: colors.textDim }}>{item.source}</span>
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
          </div>
        );
      })()}

      {/* Scrape HTML Table */}
      <div style={{ background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 8, padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: colors.text }}>🔲 Scrape HTML Table</div>
          <button onClick={handleScrapeTable} disabled={isScraping} style={{ background: colors.cardBg, color: colors.text, border: `1px solid ${colors.borderLight}`, borderRadius: 4, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: isScraping ? 'not-allowed' : 'pointer' }}>{isScraping ? 'Scraping…' : 'Scrape Now'}</button>
        </div>
        {scrapeStatus && (
          <div style={{ fontSize: 11, color: scrapeStatus.tone === 'error' ? colors.error : scrapeStatus.tone === 'warning' ? colors.warning : colors.success, background: `${scrapeStatus.tone === 'error' ? colors.error : scrapeStatus.tone === 'warning' ? colors.warning : colors.success}11`, borderRadius: 4, padding: '6px 8px' }}>{scrapeStatus.message}</div>
        )}
      </div>

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

