import React, { useState, useEffect, useRef } from 'react';
import {
  buildDatasetSnapshot,
  CandidateCollection,
  CapturedRequest,
  CaptureSession,
  DatasetDefinition,
  DatasetSnapshot,
  detectCandidateCollections,
  ExtractedRow,
  generateFixtureJson,
  generateJsonSchema,
  generateTypeScriptInterface,
  generateULID,
  serializeToCsv,
  serializeToJsonl,
  ULID,
} from '@wiredata/core';
import {
  DirectoryHandleManager,
  FSDirectoryAdapter,
  InMemoryFileAdapter,
  WorkspaceManager,
} from '@wiredata/workspace';
import { DuckDBClient } from '@wiredata/duckdb';
import {
  colors,
  DatasetHeader,
  fonts,
  JsonTreeViewer,
  ProvenanceDrawer,
  StatusBar,
  VirtualizedTable,
} from '@wiredata/ui';
import { ChromeNetworkCaptureAdapter } from '../adapters/network.js';

type ActiveView = 'captures' | 'datasets' | 'candidates' | 'sql' | 'workspace';

function generateOrdersMock(page: number, pageSize: number = 100) {
  const startId = (page - 1) * pageSize + 1;
  const orders = [];
  const statuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  const cities = ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa'];

  for (let i = 0; i < pageSize; i++) {
    const id = startId + i;
    const customerId = (id % 50) + 1;
    const status = statuses[id % statuses.length];
    const total = Math.round((20 + (id * 13.37) % 500) * 100) / 100;
    const city = cities[id % cities.length];

    orders.push({
      id,
      customer_id: customerId,
      status,
      total,
      created_at: `2026-08-${String((id % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      customer: {
        id: customerId,
        name: `Customer ${customerId}`,
        address: {
          city,
          country: 'Canada',
        },
      },
    });
  }

  return {
    total: 8247,
    page,
    pageSize,
    hasMore: page < 83,
    data: {
      orders,
    },
  };
}

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('captures');
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeSession, setActiveSession] = useState<CaptureSession | null>(null);

  // Storage and Manager
  const [workspaceManager, setWorkspaceManager] = useState<WorkspaceManager>(
    () => new WorkspaceManager(new InMemoryFileAdapter())
  );
  const [workspaceName, setWorkspaceName] = useState<string>('In-Memory Working Session');
  const [duckdbClient] = useState<DuckDBClient>(() => new DuckDBClient());

  // In-flight captured data
  const [captures, setCaptures] = useState<CapturedRequest[]>([]);
  const responseBodiesRef = useRef<Map<string, unknown>>(new Map());
  const [candidatesList, setCandidatesList] = useState<
    Array<{ capture: CapturedRequest; candidates: CandidateCollection[] }>
  >([]);

  // Datasets
  const [definitions, setDefinitions] = useState<DatasetDefinition[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Map<string, { snapshot: DatasetSnapshot; rows: ExtractedRow[] }>>(
    new Map()
  );

  // Selected provenance & modals
  const [selectedRow, setSelectedRow] = useState<ExtractedRow | null>(null);
  const [rawViewerData, setRawViewerData] = useState<{ body: unknown; pointer: string } | null>(null);
  const [exportModalContent, setExportModalContent] = useState<{ title: string; text: string } | null>(null);

  // SQL Runner state
  const [sqlQuery, setSqlQuery] = useState<string>('SELECT * FROM orders LIMIT 20;');
  const [sqlResult, setSqlResult] = useState<{ columns: string[]; rows: any[]; durationMs: number } | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);

  // Adapter ref
  const adapterRef = useRef<ChromeNetworkCaptureAdapter | null>(null);

  // Initialize workspace & session
  useEffect(() => {
    const initSession = async () => {
      const sessionId = generateULID();
      const session: CaptureSession = {
        session_id: sessionId,
        name: 'Active Capture Session',
        started_at: new Date().toISOString(),
        initial_page_url: typeof window !== 'undefined' ? window.location.href : '',
        navigation_history: [],
        capture_count: 0,
        body_bytes: 0,
        application_version: '0.1.0',
        status: 'capturing',
      };
      setActiveSession(session);
      await workspaceManager.initializeWorkspace();
      await workspaceManager.saveSession(session);
      await duckdbClient.init();
    };

    initSession();
  }, []);

  // Handle Directory Picker selection
  const handleSelectWorkspace = async () => {
    try {
      const handle = await DirectoryHandleManager.pickDirectory();
      const fsAdapter = new FSDirectoryAdapter(handle);
      const wm = new WorkspaceManager(fsAdapter);
      await wm.initializeWorkspace();
      setWorkspaceManager(wm);
      setWorkspaceName((handle as any).name || 'Selected Folder');
    } catch (err: any) {
      console.warn('Workspace selection cancelled or not supported:', err.message);
    }
  };

  // Ingest Simulated Fixture Traffic (for standalone testing / browser verification)
  const ingestCapturedData = (capture: CapturedRequest, rawBody?: unknown, candidates?: CandidateCollection[]) => {
    setCaptures(prev => [capture, ...prev]);
    if (rawBody !== undefined && capture.response.body_hash) {
      responseBodiesRef.current.set(capture.response.body_hash, rawBody);
      if (activeSession) {
        workspaceManager.saveCapture(activeSession.session_id, capture, rawBody);
      }
    }
    if (candidates && candidates.length > 0) {
      setCandidatesList(prev => [{ capture, candidates }, ...prev]);
    }
  };

  const handleSimulateFixtureTraffic = async () => {
    if (!activeSession) return;

    const urls = [
      { url: 'http://localhost:5173/api/orders?page=1', method: 'GET' },
      { url: 'http://localhost:5173/api/orders?page=2', method: 'GET' },
      { url: 'http://localhost:5173/api/orders?page=3', method: 'GET' },
      { url: 'http://localhost:5173/api/orders/9182/items', method: 'GET' },
      { url: 'http://localhost:5173/api/customers/44', method: 'GET' },
      { url: 'http://localhost:5173/api/duplicates', method: 'GET' },
      { url: 'http://localhost:5173/api/mixed-types', method: 'GET' },
      {
        url: 'http://localhost:5173/graphql',
        method: 'POST',
        body: JSON.stringify({ operationName: 'OrdersQuery', query: 'query OrdersQuery { orders { id status total } }' }),
      },
    ];

    for (const item of urls) {
      try {
        let rawJson: any = null;
        try {
          const res = await fetch(item.url, {
            method: item.method,
            headers: { 'Content-Type': 'application/json' },
            body: item.body,
          });
          if (res.ok) {
            rawJson = await res.json();
          }
        } catch {}

        // In-memory fallback if fetch is blocked or server offline
        if (!rawJson) {
          if (item.url.includes('/api/orders?page=1')) {
            rawJson = generateOrdersMock(1, 100);
          } else if (item.url.includes('/api/orders?page=2')) {
            rawJson = generateOrdersMock(2, 100);
          } else if (item.url.includes('/api/orders?page=3')) {
            rawJson = generateOrdersMock(3, 100);
          } else if (item.url.includes('/api/orders/9182/items')) {
            rawJson = { order_id: 9182, items: [{ item_id: 91821, sku: 'SKU-A101', quantity: 2, unit_price: 24.99 }] };
          } else if (item.url.includes('/api/customers/44')) {
            rawJson = { id: 44, name: 'Customer 44', email: 'user44@example.com', tier: 'platinum' };
          } else if (item.url.includes('/api/duplicates')) {
            rawJson = { items: [{ id: 1, status: 'v1_initial' }, { id: 1, status: 'v1_updated' }, { id: 2, status: 'v1_single' }] };
          } else if (item.url.includes('/api/mixed-types')) {
            rawJson = { records: [{ id: 1, amount: 45.5 }, { id: 2, amount: 99.0 }, { id: 3, amount: 'unknown' }] };
          } else if (item.url.includes('/graphql')) {
            rawJson = { data: { orders: [{ id: 9182, status: 'shipped', total: 84.12745 }, { id: 9183, status: 'pending', total: 42.11 }] } };
          }
        }

        if (!rawJson) continue;

        const jsonStr = JSON.stringify(rawJson);
        const { sha256, computeNormalizedRoute, extractGraphQLOperation, generateULID, detectCandidateCollections } = await import('@wiredata/core');
        const hash = await sha256(jsonStr);
        const graphqlOp = item.body ? extractGraphQLOperation(item.body) : undefined;
        const normalizedRoute = computeNormalizedRoute(item.method, item.url, graphqlOp);

        const capture: CapturedRequest = {
          capture_id: generateULID(),
          session_id: activeSession.session_id,
          request: {
            url: item.url,
            sanitized_url: item.url,
            route_template: normalizedRoute,
            method: item.method,
            query_parameters: [],
            headers: [{ name: 'Content-Type', value: 'application/json', is_redacted: false }],
            body_sanitized: item.body,
            graphql_operation_name: graphqlOp,
          },
          response: {
            status: 200,
            status_text: 'OK',
            mime_type: 'application/json',
            headers: [{ name: 'Content-Type', value: 'application/json', is_redacted: false }],
            body_size: jsonStr.length,
            body_hash: hash,
            body_object_ref: hash,
          },
          timing: {
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            duration_ms: 45,
          },
          classification: {
            json_candidate: true,
            parse_status: 'parsed',
          },
        };

        const candidates = detectCandidateCollections(rawJson);
        ingestCapturedData(capture, rawJson, candidates);

        // Auto-create orders dataset if found
        if (item.url.includes('/api/orders?page=1') && candidates.length > 0) {
          const cand = candidates.find(c => c.pointer === '/data/orders') || candidates[0];
          const dsId = `ds_${cand.suggested_name}`;
          const def: DatasetDefinition = {
            id: dsId,
            name: cand.suggested_name,
            version: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            sources: [
              {
                method: 'GET',
                route_pattern: '/api/orders',
              },
            ],
            extraction: {
              record_pointer: cand.pointer,
              nested_object_policy: 'flatten',
              nested_array_policy: 'json',
              flatten_delimiter: '__',
            },
            identity_columns: ['id'],
            deduplication: 'keep_latest',
            columns: {},
          };
          setDefinitions(prev => (prev.some(d => d.id === dsId) ? prev : [...prev, def]));
          setActiveDatasetId(dsId);
        }
      } catch (err: any) {
        console.warn('Simulation fetch error:', err);
      }
    }
  };

  // Auto-ingest when running standalone in browser outside Chrome DevTools
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.devtools || !chrome.devtools.network) {
      const timer = setTimeout(() => {
        handleSimulateFixtureTraffic();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [activeSession]);

  // Toggle Capture
  const toggleCapture = () => {
    if (isCapturing) {
      // Stop
      adapterRef.current?.stop();
      setIsCapturing(false);
      if (activeSession) {
        workspaceManager.saveSession({ ...activeSession, status: 'complete', ended_at: new Date().toISOString() });
      }
    } else {
      // Start
      if (!activeSession) return;
      const adapter = new ChromeNetworkCaptureAdapter(
        activeSession.session_id,
        (capture, rawBody, candidates) => {
          ingestCapturedData(capture, rawBody, candidates);
        }
      );
      adapter.start();
      adapterRef.current = adapter;
      setIsCapturing(true);
    }
  };

  // Create Dataset from candidate
  const handleCreateDataset = (candidate: CandidateCollection, capture: CapturedRequest) => {
    const dsId = `ds_${candidate.suggested_name}`;
    const def: DatasetDefinition = {
      id: dsId,
      name: candidate.suggested_name,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [
        {
          method: capture.request.method,
          route_pattern: capture.request.route_template || capture.request.sanitized_url,
          graphql_operation: capture.request.graphql_operation_name,
        },
      ],
      extraction: {
        record_pointer: candidate.pointer,
        nested_object_policy: 'flatten',
        nested_array_policy: 'json',
        flatten_delimiter: '__',
      },
      identity_columns: candidate.sample_keys.includes('id') ? ['id'] : [],
      deduplication: 'keep_latest',
      columns: {},
    };

    const newDefs = [...definitions.filter(d => d.id !== dsId), def];
    setDefinitions(newDefs);
    setActiveDatasetId(dsId);

    // Build snapshot
    rebuildDataset(def);
    setActiveView('datasets');
  };

  // Automatically rebuild dataset snapshots whenever definitions or captures change
  useEffect(() => {
    if (definitions.length > 0 && captures.length > 0) {
      for (const def of definitions) {
        const { snapshot, rows } = buildDatasetSnapshot({
          definition: def,
          captures,
          responseBodies: responseBodiesRef.current,
        });
        setSnapshots(prev => new Map(prev).set(def.id, { snapshot, rows }));
        duckdbClient.registerDataset(def.name, snapshot.schema, rows).catch(console.error);
      }
    }
  }, [definitions, captures]);

  // Rebuild Dataset Snapshot
  const rebuildDataset = (def: DatasetDefinition) => {
    const { snapshot, rows } = buildDatasetSnapshot({
      definition: def,
      captures,
      responseBodies: responseBodiesRef.current,
    });

    setSnapshots(prev => new Map(prev).set(def.id, { snapshot, rows }));
    workspaceManager.saveDatasetDefinition(def);
    workspaceManager.saveDatasetSnapshot(snapshot, rows);

    // Register in DuckDB
    duckdbClient.registerDataset(def.name, snapshot.schema, rows).catch(console.error);
  };

  // Clear All Data (Reset Workbench)
  const handleClearAllData = async () => {
    if (typeof window !== 'undefined' && !window.confirm('Are you sure you want to clear all captures, datasets, and working data?')) return;
    setCaptures([]);
    setDefinitions([]);
    setSnapshots(new Map());
    setCandidatesList([]);
    setActiveDatasetId(null);
    setSelectedRow(null);
    setSqlResult(null);
    responseBodiesRef.current.clear();
    const newSessionId = generateULID();
    const newSession: CaptureSession = {
      session_id: newSessionId,
      name: 'Active Capture Session',
      started_at: new Date().toISOString(),
      initial_page_url: typeof window !== 'undefined' ? window.location.href : '',
      navigation_history: [],
      capture_count: 0,
      body_bytes: 0,
      application_version: '0.1.0',
      status: 'capturing',
    };
    setActiveSession(newSession);
    await workspaceManager.saveSession(newSession);
  };

  // Delete Individual Dataset
  const handleDeleteDataset = (datasetId: string) => {
    setDefinitions(prev => prev.filter(d => d.id !== datasetId));
    setSnapshots(prev => {
      const next = new Map(prev);
      next.delete(datasetId);
      return next;
    });
    if (activeDatasetId === datasetId) {
      const remaining = definitions.filter(d => d.id !== datasetId);
      setActiveDatasetId(remaining[0]?.id || null);
    }
  };

  // Delete Individual Capture
  const handleDeleteCapture = (captureId: ULID) => {
    setCaptures(prev => prev.filter(c => c.capture_id !== captureId));
    setCandidatesList(prev => prev.filter(item => item.capture.capture_id !== captureId));
  };

  // Clear All Captures Only
  const handleClearCaptures = () => {
    setCaptures([]);
    setCandidatesList([]);
  };

  // Dismiss Candidate
  const handleDismissCandidate = (captureId: ULID, pointer: string) => {
    setCandidatesList(prev =>
      prev
        .map(item => {
          if (item.capture.capture_id === captureId) {
            return {
              ...item,
              candidates: item.candidates.filter(c => c.pointer !== pointer),
            };
          }
          return item;
        })
        .filter(item => item.candidates.length > 0)
    );
  };

  // Run SQL Query
  const handleRunQuery = async () => {
    setSqlError(null);
    try {
      const res = await duckdbClient.query(sqlQuery);
      setSqlResult(res);
    } catch (err: any) {
      setSqlError(err.message);
    }
  };

  // Show Raw Response
  const handleShowRaw = (responseHash: string, pointer: string) => {
    const body = responseBodiesRef.current.get(responseHash);
    if (body) {
      setRawViewerData({ body, pointer });
    }
  };

  const activeDataset = definitions.find(d => d.id === activeDatasetId);
  const activeSnapshotData = activeDatasetId ? snapshots.get(activeDatasetId) : undefined;

  const totalBodyBytes = captures.reduce((acc, c) => acc + (c.response.body_size || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: colors.bg }}>
      {/* Top Navbar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 20px',
          background: colors.panelBg,
          borderBottom: `1px solid ${colors.border}`,
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: 'linear-gradient(135deg, #0284c7, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 13,
              color: '#ffffff',
            }}
          >
            W
          </div>
          <span style={{ fontWeight: 700, fontSize: 15, color: colors.text, letterSpacing: '-0.02em' }}>
            Network Data Workbench
          </span>
          <span style={{ fontSize: 11, color: colors.textDim, fontFamily: fonts.mono }}>v0.1.0</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSimulateFixtureTraffic}
            style={{
              background: colors.cardBg,
              color: colors.primaryLight,
              border: `1px solid ${colors.primary}66`,
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            ⚡ Ingest Fixture Data
          </button>
          <button
            onClick={handleClearAllData}
            title="Reset workbench and clear all data"
            style={{
              background: colors.cardBg,
              color: colors.error,
              border: `1px solid ${colors.error}44`,
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            🗑 Clear All
          </button>
          <button
            onClick={handleSelectWorkspace}
            style={{
              background: colors.cardBg,
              color: colors.text,
              border: `1px solid ${colors.borderLight}`,
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            📁 {workspaceName}
          </button>
          <button
            onClick={toggleCapture}
            style={{
              background: isCapturing ? colors.error : colors.primary,
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '6px 16px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: isCapturing ? `0 0 12px ${colors.error}66` : 'none',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#ffffff',
              }}
            />
            {isCapturing ? 'Stop Capture' : 'Start Capture'}
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <aside
          style={{
            width: 230,
            background: colors.panelBg,
            borderRight: `1px solid ${colors.border}`,
            display: 'flex',
            flexDirection: 'column',
            padding: '16px 8px',
            gap: 4,
            userSelect: 'none',
          }}
        >
          <button
            onClick={() => setActiveView('captures')}
            style={{
              background: activeView === 'captures' ? colors.hoverBg : 'transparent',
              color: activeView === 'captures' ? colors.primaryLight : colors.textMuted,
              border: 'none',
              borderRadius: 6,
              padding: '8px 12px',
              textAlign: 'left',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>📡 Captures</span>
            <span style={{ fontSize: 11, background: `${colors.borderLight}`, padding: '1px 6px', borderRadius: 10 }}>
              {captures.length}
            </span>
          </button>

          <button
            onClick={() => setActiveView('candidates')}
            style={{
              background: activeView === 'candidates' ? colors.hoverBg : 'transparent',
              color: activeView === 'candidates' ? colors.accent : colors.textMuted,
              border: 'none',
              borderRadius: 6,
              padding: '8px 12px',
              textAlign: 'left',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>✨ Candidates</span>
            <span style={{ fontSize: 11, background: `${colors.accent}33`, color: colors.accent, padding: '1px 6px', borderRadius: 10 }}>
              {candidatesList.reduce((acc, c) => acc + c.candidates.length, 0)}
            </span>
          </button>

          <button
            onClick={() => setActiveView('sql')}
            style={{
              background: activeView === 'sql' ? colors.hoverBg : 'transparent',
              color: activeView === 'sql' ? colors.primaryLight : colors.textMuted,
              border: 'none',
              borderRadius: 6,
              padding: '8px 12px',
              textAlign: 'left',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ⚡ SQL Workspace
          </button>

          <div style={{ margin: '16px 8px 8px 8px', fontSize: 11, fontWeight: 700, color: colors.textDim, textTransform: 'uppercase' }}>
            Datasets ({definitions.length})
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {definitions.map(def => {
              const snap = snapshots.get(def.id)?.snapshot;
              const isSelected = activeDatasetId === def.id && activeView === 'datasets';
              return (
                <div
                  key={def.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: isSelected ? colors.hoverBg : 'transparent',
                    borderRadius: 6,
                    paddingRight: 6,
                  }}
                >
                  <button
                    onClick={() => {
                      setActiveDatasetId(def.id);
                      setActiveView('datasets');
                    }}
                    style={{
                      flex: 1,
                      background: 'transparent',
                      color: isSelected ? colors.primaryLight : colors.text,
                      border: 'none',
                      padding: '8px 10px',
                      textAlign: 'left',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {def.name}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, color: colors.textDim }}>{snap?.row_count ?? 0}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteDataset(def.id);
                      }}
                      title="Delete dataset"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: colors.textDim,
                        fontSize: 12,
                        cursor: 'pointer',
                        padding: '2px 4px',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* View Content */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Captures Log View */}
          {activeView === 'captures' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, color: colors.text }}>Captured Traffic Log ({captures.length})</h2>
                {captures.length > 0 && (
                  <button
                    onClick={handleClearCaptures}
                    style={{
                      background: 'transparent',
                      color: colors.error,
                      border: `1px solid ${colors.error}44`,
                      borderRadius: 6,
                      padding: '6px 12px',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    Clear Captures
                  </button>
                )}
              </div>
              <div
                style={{
                  flex: 1,
                  background: colors.cardBg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  overflowY: 'auto',
                  fontFamily: fonts.mono,
                  fontSize: 12,
                }}
              >
                {captures.length === 0 ? (
                  <div style={{ padding: '60px 24px', textAlign: 'center', maxWidth: 540, margin: '0 auto' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>📡</div>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.text, margin: '0 0 8px 0' }}>
                      Ready to Capture Application Data
                    </h3>
                    <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 20px 0', lineHeight: 1.6, fontFamily: fonts.body }}>
                      In DevTools mode, JSON responses are captured automatically while you use the application. In this browser preview, click below to ingest sample traffic and explore tables, lineage, and SQL.
                    </p>
                    <button
                      onClick={handleSimulateFixtureTraffic}
                      style={{
                        background: 'linear-gradient(135deg, #0284c7, #2563eb)',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '10px 20px',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        boxShadow: '0 4px 12px rgba(2, 132, 199, 0.3)',
                      }}
                    >
                      ⚡ Ingest Sample Fixture Data
                    </button>
                  </div>
                ) : (
                  captures.map(c => (
                    <div
                      key={c.capture_id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 16px',
                        borderBottom: `1px solid ${colors.border}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, overflow: 'hidden' }}>
                        <span
                          style={{
                            color: c.request.method === 'GET' ? colors.primaryLight : colors.accent,
                            fontWeight: 700,
                            width: 50,
                          }}
                        >
                          {c.request.method}
                        </span>
                        <span style={{ color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.request.sanitized_url}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ color: c.response.status === 200 ? colors.success : colors.error, fontWeight: 600 }}>
                          {c.response.status}
                        </span>
                        <span style={{ color: colors.textDim }}>{c.response.body_size} B</span>
                        {c.response.body_hash && (
                          <button
                            onClick={() => handleShowRaw(c.response.body_hash, '/')}
                            style={{
                              background: 'transparent',
                              border: `1px solid ${colors.borderLight}`,
                              color: colors.primaryLight,
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            Inspect Body
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteCapture(c.capture_id)}
                          title="Exclude this capture"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: colors.textDim,
                            fontSize: 13,
                            cursor: 'pointer',
                            padding: '2px 4px',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Candidates View */}
          {activeView === 'candidates' && (
            <div style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
              <h2 style={{ margin: '0 0 16px 0', fontSize: 18, color: colors.text }}>Discovered Candidate Collections</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
                {candidatesList.length === 0 ? (
                  <div style={{ color: colors.textDim, padding: 20 }}>No dataset candidates detected yet.</div>
                ) : (
                  candidatesList.map(({ capture, candidates }, i) =>
                    candidates.map((cand, j) => (
                      <div
                        key={`${i}-${j}`}
                        style={{
                          background: colors.cardBg,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 8,
                          padding: 16,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 12,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 16, fontWeight: 700, color: colors.primaryLight }}>
                            {cand.suggested_name}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: cand.confidence === 'high' ? `${colors.success}22` : `${colors.warning}22`,
                                color: cand.confidence === 'high' ? colors.success : colors.warning,
                              }}
                            >
                              {cand.confidence.toUpperCase()} CONFIDENCE
                            </span>
                            <button
                              onClick={() => handleDismissCandidate(capture.capture_id, cand.pointer)}
                              title="Dismiss candidate"
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: colors.textDim,
                                fontSize: 12,
                                cursor: 'pointer',
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div style={{ fontSize: 12, fontFamily: fonts.mono, color: colors.textMuted }}>
                          <div>Pointer: {cand.pointer}</div>
                          <div>Endpoint: {capture.request.route_template || capture.request.sanitized_url}</div>
                          <div>Rows: {cand.row_count} | Fields: {cand.field_count}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => handleCreateDataset(cand, capture)}
                            style={{
                              flex: 1,
                              background: colors.primary,
                              color: '#ffffff',
                              border: 'none',
                              borderRadius: 6,
                              padding: '8px 12px',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            + Create Dataset Table
                          </button>
                        </div>
                      </div>
                    ))
                  )
                )}
              </div>
            </div>
          )}

          {/* Dataset Table View */}
          {activeView === 'datasets' && activeSnapshotData && activeDataset && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <DatasetHeader
                snapshot={activeSnapshotData.snapshot}
                onDeleteDataset={() => handleDeleteDataset(activeDataset.id)}
                onExport={format => {
                  if (format === 'csv') {
                    const csv = serializeToCsv(activeSnapshotData.rows, activeSnapshotData.snapshot.schema, true);
                    setExportModalContent({ title: `${activeDataset.name}.csv`, text: csv });
                  } else if (format === 'jsonl') {
                    const jsonl = serializeToJsonl(activeSnapshotData.rows, activeSnapshotData.snapshot.schema, true);
                    setExportModalContent({ title: `${activeDataset.name}.jsonl`, text: jsonl });
                  } else if (format === 'parquet') {
                    duckdbClient.exportParquet(activeDataset.name).then(buf => {
                      setExportModalContent({
                        title: `${activeDataset.name}.parquet`,
                        text: `Parquet binary generated (${buf.length} bytes ready for download).`,
                      });
                    });
                  }
                }}
                onGenerateCode={type => {
                  if (type === 'ts') {
                    const ts = generateTypeScriptInterface(activeDataset.name, activeSnapshotData.snapshot.schema);
                    setExportModalContent({ title: `${activeDataset.name}.d.ts`, text: ts });
                  } else {
                    const js = generateJsonSchema(activeDataset.name, activeSnapshotData.snapshot.schema);
                    setExportModalContent({
                      title: `${activeDataset.name}.schema.json`,
                      text: JSON.stringify(js, null, 2),
                    });
                  }
                }}
              />
              <div style={{ flex: 1, padding: 16, overflow: 'hidden' }}>
                <VirtualizedTable
                  schema={activeSnapshotData.snapshot.schema}
                  rows={activeSnapshotData.rows}
                  onSelectRowSource={row => setSelectedRow(row)}
                />
              </div>
            </div>
          )}

          {/* SQL Workspace View */}
          {activeView === 'sql' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, gap: 16, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0, fontSize: 18, color: colors.text }}>DuckDB SQL Workspace</h2>
                <button
                  onClick={handleRunQuery}
                  style={{
                    background: colors.primary,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 18px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  ▶ Run SQL (Ctrl+Enter)
                </button>
              </div>

              <textarea
                value={sqlQuery}
                onChange={e => setSqlQuery(e.target.value)}
                style={{
                  height: 120,
                  background: colors.cardBg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: 12,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  color: colors.text,
                  resize: 'none',
                  outline: 'none',
                }}
              />

              {sqlError && (
                <div style={{ background: `${colors.error}22`, border: `1px solid ${colors.error}66`, color: colors.error, padding: 12, borderRadius: 6, fontSize: 12, fontFamily: fonts.mono }}>
                  {sqlError}
                </div>
              )}

              {sqlResult && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 16px', background: colors.panelBg, borderBottom: `1px solid ${colors.border}`, fontSize: 12, color: colors.textDim, fontFamily: fonts.mono }}>
                    Returned {sqlResult.rows.length} rows in {sqlResult.durationMs}ms
                  </div>
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fonts.mono }}>
                      <thead>
                        <tr style={{ background: colors.panelBg }}>
                          {sqlResult.columns.map(col => (
                            <th key={col} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: `1px solid ${colors.border}`, color: colors.textMuted }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sqlResult.rows.map((r, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid ${colors.border}33`, background: i % 2 === 0 ? colors.cardBg : colors.panelBg }}>
                            {sqlResult.columns.map(col => (
                              <td key={col} style={{ padding: '6px 12px', color: colors.text }}>
                                {String(r[col] ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Row Provenance Drawer */}
      <ProvenanceDrawer
        row={selectedRow}
        onClose={() => setSelectedRow(null)}
        onShowRawResponse={(hash, pointer) => handleShowRaw(hash, pointer)}
      />

      {/* Raw Response Modal */}
      {rawViewerData && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              width: 800,
              height: 600,
              background: colors.panelBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', background: colors.cardBg, borderBottom: `1px solid ${colors.border}` }}>
              <strong style={{ color: colors.text }}>Raw Response Body Inspector</strong>
              <button onClick={() => setRawViewerData(null)} style={{ background: 'transparent', border: 'none', color: colors.textDim, cursor: 'pointer' }}>
                ✕
              </button>
            </div>
            <div style={{ flex: 1, padding: 16, overflow: 'hidden' }}>
              <JsonTreeViewer data={rawViewerData.body} highlightPointer={rawViewerData.pointer} />
            </div>
          </div>
        </div>
      )}

      {/* Export / Code Modal */}
      {exportModalContent && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              width: 700,
              height: 500,
              background: colors.panelBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', background: colors.cardBg, borderBottom: `1px solid ${colors.border}` }}>
              <strong style={{ color: colors.text }}>{exportModalContent.title}</strong>
              <button onClick={() => setExportModalContent(null)} style={{ background: 'transparent', border: 'none', color: colors.textDim, cursor: 'pointer' }}>
                ✕
              </button>
            </div>
            <div style={{ flex: 1, padding: 16, overflow: 'hidden' }}>
              <textarea
                readOnly
                value={exportModalContent.text}
                style={{
                  width: '100%',
                  height: '100%',
                  background: colors.cardBg,
                  color: colors.text,
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  padding: 12,
                  outline: 'none',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Bottom Status Bar */}
      <StatusBar
        workspaceName={workspaceName}
        isCapturing={isCapturing}
        captureCount={captures.length}
        datasetCount={definitions.length}
        totalBytes={totalBodyBytes}
      />
    </div>
  );
}
