/**
 * Unified Workbench Application Component
 * Hosts full-tab analysis (datasets, virtualized tables, DuckDB SQL, provenance, exports)
 * and deep capture controls when hosted inside Chrome DevTools.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  groupCandidatesByRoute,
  GroupedRouteCandidate,
  redactQueryParams,
  serializeToCsv,
  serializeToJsonl,
  ULID,
} from '@wiredata/core';
import {
  DirectoryHandleManager,
  FSDirectoryAdapter,
  createDefaultWorkspaceAdapter,
  WorkspaceManager,
} from '@wiredata/workspace';
import { DuckDBClient, ParseRuleSuggestion } from '@wiredata/duckdb';
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

export interface WorkbenchAppProps {
  hostMode: 'devtools' | 'fulltab';
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

function generateCurlCommand(capture: CapturedRequest): string {
  const url = capture.request.sanitized_url || capture.request.url;
  const method = capture.request.method || 'GET';
  return `curl -X ${method} '${url}' \\\n  -H 'Accept: application/json'`;
}

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

export function WorkbenchApp({ hostMode }: WorkbenchAppProps) {
  const [activeView, setActiveView] = useState<ActiveView>('captures');
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeSession, setActiveSession] = useState<CaptureSession | null>(null);

  // Storage and Manager (defaults to shared browser-local IndexedDB storage)
  const [workspaceManager, setWorkspaceManager] = useState<WorkspaceManager>(
    () => new WorkspaceManager(createDefaultWorkspaceAdapter())
  );
  const [workspaceName, setWorkspaceName] = useState<string>('Browser Storage (Local)');
  const [duckdbClient] = useState<DuckDBClient>(() => new DuckDBClient());
  const [duckdbStatus, setDuckdbStatus] = useState<{ ready: boolean; error: string | null }>({
    ready: false,
    error: null,
  });

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

  // Scope: Current Page Session vs All Workspace Sessions
  const [sessionScope, setSessionScope] = useState<'current' | 'all'>('current');
  const [allSessions, setAllSessions] = useState<CaptureSession[]>([]);

  // Search & Type Generation state
  const [capturesSearch, setCapturesSearch] = useState<string>('');
  const [candidatesSearch, setCandidatesSearch] = useState<string>('');
  const [copiedCurlId, setCopiedCurlId] = useState<string | null>(null);
  const [typeModalData, setTypeModalData] = useState<{ title: string; tsInterface: string; jsonSchema: string } | null>(null);
  const [typeModalTab, setTypeModalTab] = useState<'ts' | 'schema'>('ts');
  const [copiedTypeBadge, setCopiedTypeBadge] = useState<string | null>(null);

  // Selected provenance & modals
  const [selectedRow, setSelectedRow] = useState<ExtractedRow | null>(null);
  const [rawViewerData, setRawViewerData] = useState<{ body: unknown; pointer: string } | null>(null);
  const [exportModalContent, setExportModalContent] = useState<{ title: string; text: string } | null>(null);
  const [parseSuggestions, setParseSuggestions] = useState<ParseRuleSuggestion[] | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // SQL Runner state
  const [sqlQuery, setSqlQuery] = useState<string>('SELECT * FROM orders LIMIT 20;');
  const [sqlResult, setSqlResult] = useState<{ columns: string[]; rows: any[]; durationMs: number } | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);

  // Adapter ref
  const adapterRef = useRef<ChromeNetworkCaptureAdapter | null>(null);

  const handleCopyCurl = (capture: CapturedRequest) => {
    const cmd = generateCurlCommand(capture);
    navigator.clipboard.writeText(cmd);
    setCopiedCurlId(capture.capture_id);
    setTimeout(() => setCopiedCurlId(null), 2000);
  };

  const handleShowTypeModal = (name: string, sampleKeys: string[], pointer: string, capturesForRoute: CapturedRequest[]) => {
    const sampleRows: Record<string, any>[] = [];
    for (const cap of capturesForRoute) {
      if (!cap.response.body_hash) continue;
      const body = responseBodiesRef.current.get(cap.response.body_hash);
      if (!body) continue;
      if (!pointer || pointer === '' || pointer === '/') {
        if (Array.isArray(body)) sampleRows.push(...body.slice(0, 10));
      } else {
        try {
          const parts = pointer.replace(/^\//, '').split('/');
          let cur: any = body;
          for (const p of parts) if (cur && typeof cur === 'object') cur = cur[p];
          if (Array.isArray(cur)) sampleRows.push(...cur.slice(0, 10));
        } catch {}
      }
    }

    const { tsInterface, jsonSchema } = generateTypesFromRows(
      name,
      sampleRows.length > 0 ? sampleRows : [Object.fromEntries(sampleKeys.map(k => [k, 'string']))]
    );
    setTypeModalData({ title: name, tsInterface, jsonSchema });
    setTypeModalTab('ts');
  };

  const handleExportCandidateJsonl = (name: string, pointer: string, capturesForRoute: CapturedRequest[]) => {
    const rows: Record<string, any>[] = [];
    for (const cap of capturesForRoute) {
      if (!cap.response.body_hash) continue;
      const body = responseBodiesRef.current.get(cap.response.body_hash);
      if (!body) continue;
      if (!pointer || pointer === '' || pointer === '/') {
        if (Array.isArray(body)) rows.push(...body);
      } else {
        try {
          const parts = pointer.replace(/^\//, '').split('/');
          let cur: any = body;
          for (const p of parts) if (cur && typeof cur === 'object') cur = cur[p];
          if (Array.isArray(cur)) rows.push(...cur);
        } catch {}
      }
    }
    if (rows.length === 0) return;
    const content = rows.map(r => JSON.stringify(r)).join('\n');
    const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Loads persisted sessions (captures, body objects, dataset definitions).
   * Supports 'current' (latest active session) or 'all' (all workspace sessions).
   */
  const hydrateFromWorkspace = async (wm: WorkspaceManager, scope: 'current' | 'all' = sessionScope): Promise<boolean> => {
    const sessions = await wm.listSessions();
    if (sessions.length === 0) return false;
    setAllSessions(sessions);

    const latestSession = sessions[0];
    let loadedCaptures: CapturedRequest[] = [];

    if (scope === 'all') {
      for (const sess of sessions) {
        const caps = await wm.listCaptures(sess.session_id);
        loadedCaptures.push(...caps);
      }
    } else {
      loadedCaptures = await wm.listCaptures(latestSession.session_id);
    }

    const loadedCandidates: Array<{ capture: CapturedRequest; candidates: CandidateCollection[] }> = [];
    for (const capture of loadedCaptures) {
      if (!capture.response.body_hash) continue;
      const body = await wm.getBodyObject(capture.response.body_hash);
      if (body === null) continue;
      responseBodiesRef.current.set(capture.response.body_hash, body);
      const rawCands = detectCandidateCollections(body);
      const candidates = rawCands.map(c => ({
        ...c,
        suggested_name: c.suggested_name === 'rows' && capture.capture_mode === 'dom' ? 'scraped_table' : c.suggested_name,
      }));
      if (candidates.length > 0) {
        loadedCandidates.push({ capture, candidates });
      }
    }

    const loadedDefinitions = await wm.listDatasetDefinitions();

    setActiveSession(latestSession);
    setCaptures(loadedCaptures);
    setCandidatesList(loadedCandidates);
    setDefinitions(loadedDefinitions);
    if (loadedDefinitions.length > 0) {
      setActiveDatasetId(loadedDefinitions[0].id);
    }

    return true;
  };

  const handleScopeChange = async (scope: 'current' | 'all') => {
    setSessionScope(scope);
    await hydrateFromWorkspace(workspaceManager, scope);
  };

  // Initialize workspace & session
  useEffect(() => {
    const initSession = async () => {
      const sessionId = generateULID();
      let pageUrl = '';
      if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          pageUrl = tabs[0]?.url || '';
        } catch {}
      }

      const appVersion = typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '0.1.6';
      const freshSession: CaptureSession = {
        session_id: sessionId,
        name: 'Active Capture Session',
        started_at: new Date().toISOString(),
        initial_page_url: pageUrl ? redactQueryParams(pageUrl).sanitizedUrl : pageUrl,
        navigation_history: [],
        capture_count: 0,
        body_bytes: 0,
        application_version: appVersion,
        status: 'new',
      };

      // Restore workspace (filesystem if permitted, or default shared IndexedDB)
      let hydrated = false;
      let wm = workspaceManager;

      try {
        const cachedHandle = await DirectoryHandleManager.loadHandle();
        if (cachedHandle) {
          const verified = await DirectoryHandleManager.verifyPermission(cachedHandle, 'readwrite');
          if (verified) {
            wm = new WorkspaceManager(new FSDirectoryAdapter(cachedHandle));
            setWorkspaceManager(wm);
            setWorkspaceName((cachedHandle as any).name || 'Workspace Folder');
          }
        }
        await wm.openOrCreateWorkspace();
        hydrated = await hydrateFromWorkspace(wm);
      } catch {
        try {
          await workspaceManager.openOrCreateWorkspace();
          hydrated = await hydrateFromWorkspace(workspaceManager);
        } catch {}
      }

      if (!hydrated) {
        setActiveSession(freshSession);
      }

      await duckdbClient.init();
      setDuckdbStatus({ ready: duckdbClient.isEngineReady, error: duckdbClient.engineError });

      // Support direct jump from Side Panel via URL parameters (e.g. ?sql=SELECT...&tab=sql)
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const sqlParam = urlParams.get('sql');
        const tabParam = urlParams.get('tab');
        if (sqlParam) {
          setSqlQuery(sqlParam);
        }
        if (tabParam === 'sql' || tabParam === 'candidates' || tabParam === 'captures' || tabParam === 'datasets') {
          setActiveView(tabParam as ActiveView);
        }
      } catch {}
    };

    initSession();
  }, []);

  // Handle Directory Picker selection
  const handleSelectWorkspace = async () => {
    try {
      const handle = await DirectoryHandleManager.pickDirectory();
      const fsAdapter = new FSDirectoryAdapter(handle);
      const wm = new WorkspaceManager(fsAdapter);
      await wm.openOrCreateWorkspace();
      setWorkspaceManager(wm);
      setWorkspaceName((handle as any).name || 'Selected Folder');
      await hydrateFromWorkspace(wm);
    } catch (err: any) {
      console.warn('Workspace selection cancelled or not supported:', err.message);
    }
  };

  // Ingest data
  const ingestCapturedData = (
    capture: CapturedRequest,
    rawBody?: unknown,
    candidates?: CandidateCollection[]
  ) => {
    setCaptures(prev => [capture, ...prev]);

    if (rawBody !== undefined && capture.response.body_hash) {
      responseBodiesRef.current.set(capture.response.body_hash, rawBody);
    }

    if (candidates && candidates.length > 0) {
      setCandidatesList(prev => [{ capture, candidates }, ...prev]);
    }

    if (activeSession) {
      workspaceManager.saveCapture(activeSession.session_id, capture, rawBody);
    }
  };

  // Toggle Deep Capture in DevTools Mode
  const toggleCapture = () => {
    if (isCapturing) {
      adapterRef.current?.stop();
      setIsCapturing(false);
      if (activeSession) {
        workspaceManager.saveSession({ ...activeSession, status: 'complete', ended_at: new Date().toISOString() });
      }
    } else {
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

  // Dev demo simulation (Only enabled in DEV mode)
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
          if (res.ok) rawJson = await res.json();
        } catch {}

        if (!rawJson) {
          if (item.url.includes('/api/orders?page=1')) rawJson = generateOrdersMock(1, 100);
          else if (item.url.includes('/api/orders?page=2')) rawJson = generateOrdersMock(2, 100);
          else if (item.url.includes('/api/orders?page=3')) rawJson = generateOrdersMock(3, 100);
          else if (item.url.includes('/api/orders/9182/items')) rawJson = { order_id: 9182, items: [{ item_id: 91821, sku: 'SKU-A101', quantity: 2, unit_price: 24.99 }] };
          else if (item.url.includes('/api/customers/44')) rawJson = { id: 44, name: 'Customer 44', email: 'user44@example.com', tier: 'platinum' };
          else if (item.url.includes('/api/duplicates')) rawJson = { items: [{ id: 1, status: 'v1_initial' }, { id: 1, status: 'v1_updated' }, { id: 2, status: 'v1_single' }] };
          else if (item.url.includes('/api/mixed-types')) rawJson = { records: [{ id: 1, amount: 45.5 }, { id: 2, amount: 99.0 }, { id: 3, amount: 'unknown' }] };
          else if (item.url.includes('/graphql')) rawJson = { data: { orders: [{ id: 9182, status: 'shipped', total: 84.12745 }, { id: 9183, status: 'pending', total: 42.11 }] } };
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
          capture_mode: 'page',
          request: {
            url: item.url,
            sanitized_url: item.url,
            route_template: normalizedRoute,
            method: item.method,
            query_parameters: [],
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

        if (item.url.includes('/api/orders?page=1') && candidates.length > 0) {
          const cand = candidates.find(c => c.pointer === '/data/orders') || candidates[0];
          const dsId = `ds_${cand.suggested_name}`;
          const def: DatasetDefinition = {
            id: dsId,
            name: cand.suggested_name,
            version: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            sources: [{ method: 'GET', route_pattern: '/api/orders' }],
            extraction: {
              record_pointer: cand.pointer,
              nested_object_policy: 'flatten',
              nested_array_policy: 'json',
              flatten_delimiter: '__',
            },
            identity_columns: ['id'],
            deduplication: 'keep_all',
            columns: {},
          };
          setDefinitions(prev => (prev.some(d => d.id === dsId) ? prev : [...prev, def]));
          setActiveDatasetId(dsId);
        }
      } catch (err: any) {
        console.warn('Simulation error:', err);
      }
    }
  };

  // Convert Discovered Candidate to Structured Dataset
  const handleCreateDatasetFromCandidate = (capture: CapturedRequest, candidate: CandidateCollection) => {
    const dsId = `ds_${candidate.suggested_name}_${generateULID().slice(-4).toLowerCase()}`;
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
      identity_columns: [],
      deduplication: 'keep_all',
      columns: {},
    };

    const newDefs = [...definitions.filter(d => d.id !== dsId), def];
    setDefinitions(newDefs);
    setActiveDatasetId(dsId);
    rebuildDataset(def);
    setActiveView('datasets');
  };

  const handleCreateDataset = (candidate: CandidateCollection, capture: CapturedRequest) => {
    handleCreateDatasetFromCandidate(capture, candidate);
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

  const rebuildDataset = (def: DatasetDefinition) => {
    const { snapshot, rows } = buildDatasetSnapshot({
      definition: def,
      captures,
      responseBodies: responseBodiesRef.current,
    });

    setSnapshots(prev => new Map(prev).set(def.id, { snapshot, rows }));
    workspaceManager.saveDatasetDefinition(def);
    workspaceManager.saveDatasetSnapshot(snapshot, rows);
    duckdbClient.registerDataset(def.name, snapshot.schema, rows).catch(console.error);
  };

  // Ask DuckDB to test candidate parse rules against a dataset's raw scraped
  // text (see DuckDBClient.suggestParseRules) — read-only, nothing is
  // applied until the user confirms a specific suggestion below.
  const handleSuggestCleanup = async (def: DatasetDefinition, snapshot: DatasetSnapshot, rows: ExtractedRow[]) => {
    setSuggestError(null);
    setSuggestLoading(true);
    try {
      const columnValues: Record<string, string[]> = {};
      for (const colName of Object.keys(snapshot.schema)) {
        columnValues[colName] = rows.map(r => {
          const raw = r.field_lineage[colName]?.raw_value;
          return typeof raw === 'string' ? raw : '';
        });
      }
      const suggestions = await duckdbClient.suggestParseRules(columnValues);
      setParseSuggestions(suggestions);
    } catch (err: any) {
      setSuggestError(err?.message || 'Failed to get suggestions.');
    } finally {
      setSuggestLoading(false);
    }
  };

  // Persists a confirmed suggestion as a ColumnParseRule on the dataset
  // definition (so it reapplies on every future rebuild) and rebuilds now.
  const handleApplySuggestion = (def: DatasetDefinition, suggestion: ParseRuleSuggestion) => {
    const existingCol = def.columns[suggestion.column] ?? {
      name: suggestion.column,
      original_name: suggestion.column,
      logical_type: 'VARCHAR' as const,
      inferred_type: 'VARCHAR' as const,
      is_visible: true,
      order: Object.keys(def.columns).length,
    };
    const provisionalDef: DatasetDefinition = {
      ...def,
      columns: {
        ...def.columns,
        [suggestion.column]: { ...existingCol, parse_rule: suggestion.rule },
      },
    };

    // buildDatasetSnapshot always prefers an existing column's logical_type
    // over a fresh inference (correct — a persisted decision shouldn't
    // flip-flop just because new data came in), but that means the
    // placeholder above would otherwise freeze this column at whatever type
    // it had *before* the rule ran. Rebuild once locally to learn the real
    // post-rule type, then persist that as the actual decision.
    const { snapshot: provisional } = buildDatasetSnapshot({
      definition: provisionalDef,
      captures,
      responseBodies: responseBodiesRef.current,
    });
    const freshType = provisional.schema[suggestion.column]?.inferred_type ?? 'VARCHAR';

    const updatedDef: DatasetDefinition = {
      ...provisionalDef,
      updated_at: new Date().toISOString(),
      columns: {
        ...provisionalDef.columns,
        [suggestion.column]: { ...provisionalDef.columns[suggestion.column], logical_type: freshType, inferred_type: freshType },
      },
    };
    setDefinitions(prev => prev.map(d => (d.id === def.id ? updatedDef : d)));
    rebuildDataset(updatedDef);
    setParseSuggestions(prev => (prev ? prev.filter(s => s.column !== suggestion.column) : prev));
  };

  // Data clearing handlers
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
    try {
      await workspaceManager.clearWorkspaceContents();
    } catch {}
    const newSessionId = generateULID();
    const newSession: CaptureSession = {
      session_id: newSessionId,
      name: 'Active Capture Session',
      started_at: new Date().toISOString(),
      initial_page_url: activeSession?.initial_page_url || '',
      navigation_history: [],
      capture_count: 0,
      body_bytes: 0,
      application_version: '0.1.7',
      status: 'new',
    };
    setActiveSession(newSession);
    await workspaceManager.saveSession(newSession);
  };

  const handleDeleteDataset = async (datasetId: string) => {
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
    try {
      await workspaceManager.deleteDataset(datasetId);
      await workspaceManager.gcOrphanedObjects();
    } catch {}
  };

  const handleDeleteCapture = async (captureId: ULID) => {
    const targetCapture = captures.find(c => c.capture_id === captureId);
    setCaptures(prev => prev.filter(c => c.capture_id !== captureId));
    setCandidatesList(prev => prev.filter(item => item.capture.capture_id !== captureId));
    const sessId = targetCapture?.session_id || activeSession?.session_id;
    if (sessId) {
      try {
        await workspaceManager.deleteCapture(sessId, captureId);
        await workspaceManager.gcOrphanedObjects();
      } catch {}
    }
  };

  const handleClearCaptures = async () => {
    const capsToDel = [...captures];
    setCaptures([]);
    setCandidatesList([]);
    for (const c of capsToDel) {
      try {
        await workspaceManager.deleteCapture(c.session_id, c.capture_id);
      } catch {}
    }
    try {
      await workspaceManager.gcOrphanedObjects();
    } catch {}
  };

  const handleClearAllDatasets = async () => {
    const defsToDel = [...definitions];
    setDefinitions([]);
    setSnapshots(new Map());
    setActiveDatasetId(null);
    for (const d of defsToDel) {
      try {
        await workspaceManager.deleteDataset(d.id);
      } catch {}
    }
    try {
      await workspaceManager.gcOrphanedObjects();
    } catch {}
  };

  const handleClearCandidates = () => {
    setCandidatesList([]);
  };

  const handleDismissRouteGroup = async (routeCaptures: CapturedRequest[]) => {
    const captureIds = new Set(routeCaptures.map(c => c.capture_id));
    setCandidatesList(prev => prev.filter(item => !captureIds.has(item.capture.capture_id)));
    setCaptures(prev => prev.filter(c => !captureIds.has(c.capture_id)));
    for (const c of routeCaptures) {
      try {
        await workspaceManager.deleteCapture(c.session_id, c.capture_id);
      } catch {}
    }
    try {
      await workspaceManager.gcOrphanedObjects();
    } catch {}
  };

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

  const handleRunQuery = async () => {
    setSqlError(null);
    try {
      const res = await duckdbClient.query(sqlQuery);
      setSqlResult(res);
    } catch (err: any) {
      setSqlError(err.message);
    }
  };

  const handleShowRaw = (responseHash: string, pointer: string) => {
    const body = responseBodiesRef.current.get(responseHash);
    if (body) {
      setRawViewerData({ body, pointer });
    }
  };

  const activeDataset = definitions.find(d => d.id === activeDatasetId);
  const activeSnapshotData = activeDatasetId ? snapshots.get(activeDatasetId) : undefined;
  const totalBodyBytes = captures.reduce((acc, c) => acc + (c.response.body_size || 0), 0);

  const groupedRouteCandidates = useMemo(() => {
    return groupCandidatesByRoute(captures, responseBodiesRef.current);
  }, [captures]);

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
          <span style={{ fontSize: 11, color: colors.textDim, fontFamily: fonts.mono }}>
            v{typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '0.1.7'}
          </span>
          <span
            data-testid="duckdb-status"
            data-state={duckdbStatus.ready ? 'active' : duckdbStatus.error ? 'error' : 'initializing'}
            style={{
              fontSize: 10,
              fontWeight: 700,
              background: duckdbStatus.ready ? `${colors.success}22` : duckdbStatus.error ? `${colors.error}22` : `${colors.warning}22`,
              color: duckdbStatus.ready ? colors.success : duckdbStatus.error ? colors.error : colors.warning,
              padding: '2px 6px',
              borderRadius: 4,
              fontFamily: fonts.mono,
            }}
          >
            {duckdbStatus.ready ? '● DuckDB SQL' : duckdbStatus.error ? '✕ DuckDB Error' : '○ DuckDB Init'}
          </span>
          {hostMode === 'devtools' && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                background: `${colors.accent}22`,
                color: colors.accent,
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              DEEP CAPTURE (DEVTOOLS)
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {hostMode === 'devtools' && (
            <button
              onClick={toggleCapture}
              style={{
                background: isCapturing ? colors.error : 'linear-gradient(135deg, #0284c7, #2563eb)',
                color: '#ffffff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {isCapturing ? '⏹ Stop DevTools Capture' : '⏺ Start DevTools Capture'}
            </button>
          )}
          <button
            onClick={handleSimulateFixtureTraffic}
            title="Load sample dataset (e-commerce orders and customers) to test queries, schema, and views"
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
            ⚡ Load Sample Data
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
          {hostMode === 'devtools' && (
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
          )}
        </div>
      </header>

      {/* DevTools Pre-Capture Prominent Disclosure */}
      {hostMode === 'devtools' && (
        <div
          style={{
            padding: '8px 20px',
            background: isCapturing ? `${colors.error}11` : colors.panelBg,
            borderBottom: `1px solid ${isCapturing ? colors.error : colors.borderLight}`,
            fontSize: 12,
            color: colors.textMuted,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            {isCapturing
              ? '● DevTools Capture Active: Recording JSON API responses and sanitized URLs from inspected tab. Request auth headers are not stored. All processing stays strictly local.'
              : 'ℹ️ DevTools Capture: WireData will locally record JSON response bodies and sanitized request URLs from this inspected tab. Request authentication headers are not stored. Response bodies are stored as returned and may contain sensitive information. Nothing is transmitted to WireData or third parties.'}
          </span>
        </div>
      )}

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
              {groupedRouteCandidates.reduce((acc, r) => acc + r.collections.length, 0)}
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

          <div style={{ margin: '16px 8px 8px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: colors.textDim, textTransform: 'uppercase' }}>
              Datasets ({definitions.length})
            </span>
            {definitions.length > 0 && (
              <button
                onClick={handleClearAllDatasets}
                title="Clear all datasets"
                style={{
                  background: 'transparent',
                  border: `1px solid ${colors.error}44`,
                  color: colors.error,
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Clear All
              </button>
            )}
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
                      onClick={e => {
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <h2 style={{ margin: 0, fontSize: 18, color: colors.text }}>Captured Traffic Log ({captures.length})</h2>
                  <div style={{ display: 'flex', background: colors.panelBg, border: `1px solid ${colors.border}`, borderRadius: 6, padding: 2 }}>
                    <button
                      onClick={() => handleScopeChange('current')}
                      style={{
                        background: sessionScope === 'current' ? colors.hoverBg : 'transparent',
                        color: sessionScope === 'current' ? colors.primaryLight : colors.textMuted,
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      🌐 Current Page Only
                    </button>
                    <button
                      onClick={() => handleScopeChange('all')}
                      style={{
                        background: sessionScope === 'all' ? colors.hoverBg : 'transparent',
                        color: sessionScope === 'all' ? colors.primaryLight : colors.textMuted,
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      📁 All Workspace ({allSessions.length})
                    </button>
                  </div>
                </div>
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
              {captures.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <input
                    type="text"
                    placeholder="🔍 Filter captures by URL, HTTP method, or status..."
                    value={capturesSearch}
                    onChange={e => setCapturesSearch(e.target.value)}
                    style={{
                      width: '100%',
                      background: colors.cardBg,
                      border: `1px solid ${colors.borderLight}`,
                      borderRadius: 6,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: colors.text,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}
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
                      {hostMode === 'devtools'
                        ? 'Click "Start Capture" above to record JSON responses from this inspected tab with full DevTools visibility.'
                        : 'Capture is managed from the WireData Side Panel companion. Open the side panel to start recording.'}
                    </p>
                  </div>
                ) : (
                  (capturesSearch.trim()
                    ? captures.filter(c =>
                        c.request.sanitized_url.toLowerCase().includes(capturesSearch.toLowerCase()) ||
                        c.request.method.toLowerCase().includes(capturesSearch.toLowerCase()) ||
                        String(c.response.status).includes(capturesSearch)
                      )
                    : captures
                  ).map(c => (
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: c.response.status === 200 ? colors.success : colors.error, fontWeight: 600 }}>
                          {c.response.status}
                        </span>
                        <span style={{ color: colors.textDim }}>{c.response.body_size} B</span>
                        {c.classification.sensitive_response_fields && c.classification.sensitive_response_fields.length > 0 && (
                          <span
                            title={`Credential-shaped field name(s) detected, stored exactly as received: ${c.classification.sensitive_response_fields.join(', ')}`}
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              color: colors.warning,
                              background: `${colors.warning}22`,
                              padding: '2px 6px',
                              borderRadius: 4,
                            }}
                          >
                            ⚠ {c.classification.sensitive_response_fields.length} sensitive field{c.classification.sensitive_response_fields.length > 1 ? 's' : ''}
                          </span>
                        )}
                        <button
                          onClick={() => handleCopyCurl(c)}
                          title="Copy as cURL command"
                          style={{
                            background: 'transparent',
                            border: `1px solid ${colors.borderLight}`,
                            color: copiedCurlId === c.capture_id ? colors.success : colors.primaryLight,
                            borderRadius: 4,
                            padding: '2px 8px',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                        >
                          {copiedCurlId === c.capture_id ? '✓ cURL' : '📋 cURL'}
                        </button>
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
            <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <h2 style={{ margin: '0 0 6px 0', fontSize: 18, color: colors.text }}>
                    Discovered Data Collections
                  </h2>
                  <p style={{ margin: 0, color: colors.textMuted, fontSize: 13 }}>
                    Automatically grouped by logical API route. You can extract combined datasets across all paginated captures, generate TypeScript interfaces, or export JSONL.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ display: 'flex', background: colors.panelBg, border: `1px solid ${colors.border}`, borderRadius: 6, padding: 2, flexShrink: 0 }}>
                    <button
                      onClick={() => handleScopeChange('current')}
                      style={{
                        background: sessionScope === 'current' ? colors.hoverBg : 'transparent',
                        color: sessionScope === 'current' ? colors.primaryLight : colors.textMuted,
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      🌐 Current Page Only
                    </button>
                    <button
                      onClick={() => handleScopeChange('all')}
                      style={{
                        background: sessionScope === 'all' ? colors.hoverBg : 'transparent',
                        color: sessionScope === 'all' ? colors.primaryLight : colors.textMuted,
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      📁 All Workspace ({allSessions.length})
                    </button>
                  </div>
                  {candidatesList.length > 0 && (
                    <button
                      onClick={handleClearCandidates}
                      title="Clear all discovered candidates"
                      style={{
                        background: 'transparent',
                        border: `1px solid ${colors.error}44`,
                        color: colors.error,
                        borderRadius: 6,
                        padding: '6px 12px',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                    >
                      Clear Candidates
                    </button>
                  )}
                </div>
              </div>

              {/* Candidates Search Filter */}
              {groupedRouteCandidates.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <input
                    type="text"
                    placeholder="🔍 Filter routes, candidate collection names, or fields..."
                    value={candidatesSearch}
                    onChange={e => setCandidatesSearch(e.target.value)}
                    style={{
                      width: '100%',
                      background: colors.cardBg,
                      border: `1px solid ${colors.borderLight}`,
                      borderRadius: 6,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: colors.text,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}

              {groupedRouteCandidates.length === 0 ? (
                <div style={{ color: colors.textDim, padding: 40, textAlign: 'center', background: colors.cardBg, borderRadius: 8, border: `1px solid ${colors.border}` }}>
                  No dataset candidates detected in captured traffic yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {(candidatesSearch.trim()
                    ? groupedRouteCandidates.filter(rg =>
                        rg.route_template.toLowerCase().includes(candidatesSearch.toLowerCase()) ||
                        rg.collections.some(c =>
                          c.suggested_name.toLowerCase().includes(candidatesSearch.toLowerCase()) ||
                          c.sample_keys.some(k => k.toLowerCase().includes(candidatesSearch.toLowerCase()))
                        )
                      )
                    : groupedRouteCandidates
                  ).map(routeGroup => (
                    <div
                      key={routeGroup.route_id}
                      style={{
                        background: colors.cardBg,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 10,
                        overflow: 'hidden',
                      }}
                    >
                      {/* Route Header Banner */}
                      <div
                        style={{
                          padding: '12px 18px',
                          background: colors.hoverBg,
                          borderBottom: `1px solid ${colors.border}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 10,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            style={{
                              background: routeGroup.method === 'GET' ? `${colors.primary}22` : `${colors.accent}22`,
                              color: routeGroup.method === 'GET' ? colors.primaryLight : colors.accent,
                              fontWeight: 700,
                              fontSize: 12,
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontFamily: fonts.mono,
                            }}
                          >
                            {routeGroup.method}
                          </span>
                          <span style={{ fontSize: 14, fontWeight: 700, color: colors.text, fontFamily: fonts.mono }}>
                            {routeGroup.route_template.startsWith(routeGroup.method + ' ')
                              ? routeGroup.route_template.slice(routeGroup.method.length + 1)
                              : routeGroup.route_template}
                          </span>
                          {routeGroup.graphql_operation && (
                            <span style={{ fontSize: 12, color: colors.accent, background: `${colors.accent}22`, padding: '2px 6px', borderRadius: 4 }}>
                              GraphQL: {routeGroup.graphql_operation}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: colors.textMuted }}>
                          <span>
                            <strong style={{ color: colors.text }}>{routeGroup.total_captures}</strong> {routeGroup.total_captures === 1 ? 'capture' : 'captures (paginated/repeated)'}
                          </span>
                          <button
                            onClick={() => handleDismissRouteGroup(routeGroup.captures)}
                            title="Dismiss this candidate collection group"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: colors.textDim,
                              fontSize: 14,
                              cursor: 'pointer',
                              padding: '2px 6px',
                              lineHeight: 1,
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {/* Collections within this Route */}
                      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {routeGroup.collections.map(col => {
                          const isSubCollection = col.is_sub_collection || col.pointer.includes('items') || col.pointer.includes('children');
                          return (
                            <div
                              key={col.pointer}
                              style={{
                                background: colors.panelBg,
                                border: `1px solid ${colors.borderLight}`,
                                borderRadius: 8,
                                padding: 16,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 10,
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ fontSize: 16, fontWeight: 700, color: colors.primaryLight }}>
                                    {col.suggested_name}
                                  </span>
                                  {isSubCollection && (
                                    <span style={{ fontSize: 11, color: colors.accent, background: `${colors.accent}22`, padding: '2px 6px', borderRadius: 4 }}>
                                      ⑂ Sub-Collection
                                    </span>
                                  )}
                                  <span
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: col.confidence === 'high' ? `${colors.success}22` : `${colors.warning}22`,
                                      color: col.confidence === 'high' ? colors.success : colors.warning,
                                    }}
                                  >
                                    {col.confidence.toUpperCase()} CONFIDENCE
                                  </span>
                                </div>
                                <span style={{ fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono }}>
                                  Pointer: {col.pointer}
                                </span>
                              </div>

                              <div style={{ fontSize: 12, color: colors.textMuted, display: 'flex', gap: 16 }}>
                                <span>
                                  Total records: <strong style={{ color: colors.text }}>{col.total_rows.toLocaleString()}</strong> ({col.sample_rows_per_capture} per capture)
                                </span>
                                <span>
                                  Fields: <strong style={{ color: colors.text }}>{col.field_count}</strong> ({col.sample_keys.slice(0, 5).join(', ')}...)
                                </span>
                              </div>

                              <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                                <button
                                  onClick={() => {
                                    const firstCapture = routeGroup.captures[0];
                                    const cand: CandidateCollection = {
                                      pointer: col.pointer,
                                      display_path: col.pointer,
                                      suggested_name: col.suggested_name,
                                      confidence: col.confidence,
                                      confidence_score: 0.9,
                                      row_count: col.total_rows,
                                      field_count: col.field_count,
                                      sample_keys: col.sample_keys,
                                    };
                                    handleCreateDataset(cand, firstCapture);
                                  }}
                                  style={{
                                    background: 'linear-gradient(135deg, #0284c7, #2563eb)',
                                    color: '#ffffff',
                                    border: 'none',
                                    borderRadius: 6,
                                    padding: '8px 16px',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                  }}
                                >
                                  ⚡ Extract Combined Dataset ({col.total_rows} rows from {routeGroup.total_captures} {routeGroup.total_captures === 1 ? 'capture' : 'pages'})
                                </button>

                                <button
                                  onClick={() => handleShowTypeModal(col.suggested_name, col.sample_keys, col.pointer, routeGroup.captures)}
                                  title="Inspect & Copy TypeScript Interface or JSON Schema"
                                  style={{
                                    background: colors.cardBg,
                                    color: colors.accent,
                                    border: `1px solid ${colors.accent}44`,
                                    borderRadius: 6,
                                    padding: '8px 14px',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                  }}
                                >
                                  📄 TypeScript / Schema
                                </button>

                                <button
                                  onClick={() => handleExportCandidateJsonl(col.suggested_name, col.pointer, routeGroup.captures)}
                                  title="Download as JSON Lines (.jsonl)"
                                  style={{
                                    background: colors.cardBg,
                                    color: colors.primaryLight,
                                    border: `1px solid ${colors.borderLight}`,
                                    borderRadius: 6,
                                    padding: '8px 14px',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                  }}
                                >
                                  📄 JSONL
                                </button>

                                {routeGroup.total_captures > 1 && (
                                  <button
                                    onClick={() => {
                                      const latest = routeGroup.captures[routeGroup.captures.length - 1];
                                      const cand: CandidateCollection = {
                                        pointer: col.pointer,
                                        display_path: col.pointer,
                                        suggested_name: `${col.suggested_name}_single_page`,
                                        confidence: col.confidence,
                                        confidence_score: 0.9,
                                        row_count: col.sample_rows_per_capture,
                                        field_count: col.field_count,
                                        sample_keys: col.sample_keys,
                                      };
                                      const dsId = `ds_${cand.suggested_name}_${latest.capture_id.slice(-4)}`;
                                      const def: DatasetDefinition = {
                                        id: dsId,
                                        name: cand.suggested_name,
                                        version: 1,
                                        created_at: new Date().toISOString(),
                                        updated_at: new Date().toISOString(),
                                        sources: [{ method: latest.request.method, route_pattern: latest.request.url }],
                                        extraction: {
                                          record_pointer: cand.pointer,
                                          nested_object_policy: 'flatten',
                                          nested_array_policy: 'json',
                                          flatten_delimiter: '__',
                                        },
                                        identity_columns: cand.sample_keys.find(k => /^(id|_id|uuid|key|code|order_id|user_id|item_id)$/i.test(k))
                                          ? [cand.sample_keys.find(k => /^(id|_id|uuid|key|code|order_id|user_id|item_id)$/i.test(k))!]
                                          : [],
                                        deduplication: 'keep_latest',
                                        columns: {},
                                      };
                                      setDefinitions(prev => [...prev.filter(d => d.id !== dsId), def]);
                                      setActiveDatasetId(dsId);
                                      rebuildDataset(def);
                                      setActiveView('datasets');
                                    }}
                                    style={{
                                      background: colors.cardBg,
                                      color: colors.text,
                                      border: `1px solid ${colors.borderLight}`,
                                      borderRadius: 6,
                                      padding: '8px 14px',
                                      fontSize: 12,
                                      fontWeight: 500,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Extract Single Capture Only ({col.sample_rows_per_capture} rows)
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${activeDataset.name}.csv`;
                    a.click();
                  } else if (format === 'jsonl') {
                    const jsonl = serializeToJsonl(activeSnapshotData.rows, activeSnapshotData.snapshot.schema, true);
                    const blob = new Blob([jsonl], { type: 'application/x-jsonlines' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${activeDataset.name}.jsonl`;
                    a.click();
                  } else if (format === 'parquet') {
                    duckdbClient.exportParquet(activeDataset.name).then(buf => {
                      const blob = new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${activeDataset.name}.parquet`;
                      a.click();
                    });
                  }
                }}
                onGenerateCode={type => {
                  if (type === 'ts') {
                    const code = generateTypeScriptInterface(activeDataset.name, activeSnapshotData.snapshot.schema);
                    setExportModalContent({ title: `TypeScript Interface: ${activeDataset.name}.d.ts`, text: code });
                  } else if (type === 'jsonschema') {
                    const schemaObj = generateJsonSchema(activeDataset.name, activeSnapshotData.snapshot.schema);
                    setExportModalContent({
                      title: `JSON Schema: ${activeDataset.name}.schema.json`,
                      text: JSON.stringify(schemaObj, null, 2),
                    });
                  }
                }}
              />

              {activeSnapshotData.rows[0]?.lineage.capture_mode === 'dom' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '8px 20px',
                    background: `${colors.primary}11`,
                    borderBottom: `1px solid ${colors.border}`,
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: colors.textMuted }}>
                    Scraped from a page — every cell is text. DuckDB can test whether any columns look like numbers, percentages, or dates.
                  </span>
                  <button
                    onClick={() => handleSuggestCleanup(activeDataset, activeSnapshotData.snapshot, activeSnapshotData.rows)}
                    disabled={suggestLoading}
                    style={{
                      background: colors.cardBg,
                      color: colors.primaryLight,
                      border: `1px solid ${colors.primary}66`,
                      borderRadius: 6,
                      padding: '5px 12px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: suggestLoading ? 'default' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {suggestLoading ? 'Checking columns…' : '✨ Suggest Cleanup'}
                  </button>
                </div>
              )}

              {suggestError && (
                <div style={{ padding: '8px 20px', fontSize: 12, color: colors.error, background: `${colors.error}11` }}>
                  {suggestError}
                </div>
              )}

              <div style={{ flex: 1, overflow: 'hidden' }}>
                <VirtualizedTable
                  rows={activeSnapshotData.rows}
                  schema={activeSnapshotData.snapshot.schema}
                  onSelectRowSource={row => setSelectedRow(row)}
                />
              </div>
            </div>
          )}

          {/* SQL Workspace View */}
          {activeView === 'sql' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <h2 style={{ margin: 0, fontSize: 18, color: colors.text }}>⚡ DuckDB SQL Engine</h2>
                  <span
                    title={duckdbStatus.error || undefined}
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: duckdbStatus.ready ? `${colors.success}22` : `${colors.error}22`,
                      color: duckdbStatus.ready ? colors.success : colors.error,
                    }}
                  >
                    {duckdbStatus.ready ? 'ACTIVE' : 'UNAVAILABLE'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleRunQuery}
                    style={{
                      background: 'linear-gradient(135deg, #0284c7, #2563eb)',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: 6,
                      padding: '8px 16px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    ▶ Run SQL (Ctrl+Enter)
                  </button>
                </div>
              </div>

              <textarea
                value={sqlQuery}
                onChange={e => setSqlQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    handleRunQuery();
                  }
                }}
                style={{
                  height: 100,
                  background: colors.cardBg,
                  color: colors.text,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: 12,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  resize: 'none',
                  outline: 'none',
                  marginBottom: 16,
                }}
              />

              {sqlError && (
                <div
                  style={{
                    background: `${colors.error}22`,
                    border: `1px solid ${colors.error}44`,
                    color: colors.error,
                    padding: '10px 14px',
                    borderRadius: 6,
                    marginBottom: 12,
                    fontSize: 12,
                    fontFamily: fonts.mono,
                  }}
                >
                  Error: {sqlError}
                </div>
              )}

              <div
                style={{
                  flex: 1,
                  background: colors.cardBg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  overflow: 'auto',
                }}
              >
                {sqlResult ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fonts.mono }}>
                    <thead>
                      <tr style={{ background: colors.hoverBg, borderBottom: `1px solid ${colors.border}` }}>
                        {sqlResult.columns.map(col => (
                          <th key={col} style={{ padding: '8px 12px', textAlign: 'left', color: colors.textDim }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sqlResult.rows.map((row, idx) => (
                        <tr key={idx} style={{ borderBottom: `1px solid ${colors.border}` }}>
                          {sqlResult.columns.map(col => (
                            <td key={col} style={{ padding: '8px 12px', color: colors.text }}>
                              {String(row[col] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: 30, color: colors.textDim, textAlign: 'center' }}>
                    Execute SQL query above to preview query results.
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Provenance Drawer */}
      {selectedRow && (
        <ProvenanceDrawer
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
          onShowRawResponse={(hash, pointer) => handleShowRaw(hash, pointer)}
        />
      )}

      {/* Raw Response JSON Modal */}
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
          onClick={() => setRawViewerData(null)}
        >
          <div
            style={{
              width: '80vw',
              maxWidth: 900,
              height: '80vh',
              background: colors.panelBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: `1px solid ${colors.border}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontWeight: 600, color: colors.text }}>
                Raw Body Viewer (Highlighted Pointer: {rawViewerData.pointer})
              </span>
              <button
                onClick={() => setRawViewerData(null)}
                style={{ background: 'transparent', border: 'none', color: colors.textDim, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
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
          onClick={() => setExportModalContent(null)}
        >
          <div
            style={{
              width: '70vw',
              maxWidth: 800,
              maxHeight: '80vh',
              background: colors.panelBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: `1px solid ${colors.border}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontWeight: 600, color: colors.text }}>{exportModalContent.title}</span>
              <button
                onClick={() => setExportModalContent(null)}
                style={{ background: 'transparent', border: 'none', color: colors.textDim, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <textarea
              readOnly
              value={exportModalContent.text}
              style={{
                flex: 1,
                minHeight: 350,
                background: colors.cardBg,
                color: colors.text,
                padding: 16,
                fontFamily: fonts.mono,
                fontSize: 12,
                border: 'none',
                resize: 'none',
                outline: 'none',
              }}
            />
          </div>
        </div>
      )}

      {/* Suggested Cleanup Modal */}
      {parseSuggestions && activeDataset && (
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
          onClick={() => setParseSuggestions(null)}
        >
          <div
            style={{
              width: '70vw',
              maxWidth: 800,
              maxHeight: '80vh',
              background: colors.panelBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div
              style={{
                padding: '12px 16px',
                borderBottom: `1px solid ${colors.border}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ fontWeight: 600, color: colors.text }}>Suggested Cleanup</span>
              <button
                onClick={() => setParseSuggestions(null)}
                style={{ background: 'transparent', border: 'none', color: colors.textDim, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {parseSuggestions.length === 0 ? (
                <div style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', padding: 24 }}>
                  No column looked confidently like a number, percent, or date. Everything stays text.
                </div>
              ) : (
                parseSuggestions.map(s => (
                  <div
                    key={s.column}
                    style={{
                      border: `1px solid ${colors.border}`,
                      borderRadius: 8,
                      padding: 14,
                      background: colors.cardBg,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, color: colors.text, fontFamily: fonts.mono }}>{s.column}</span>
                        <span style={{ marginLeft: 10, fontSize: 12, color: colors.primaryLight }}>{s.label}</span>
                        <span style={{ marginLeft: 8, fontSize: 11, color: colors.textDim }}>
                          {Math.round(s.confidence * 100)}% of values match
                        </span>
                      </div>
                      {!s.alternatives && (
                        <button
                          onClick={() => handleApplySuggestion(activeDataset, s)}
                          style={{
                            background: 'linear-gradient(135deg, #0284c7, #2563eb)',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: 6,
                            padding: '6px 14px',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Apply
                        </button>
                      )}
                    </div>

                    {s.alternatives ? (
                      <>
                        <div style={{ fontSize: 12, color: colors.warning, marginBottom: 8 }}>
                          ⚠ Ambiguous — every value fits more than one date format, and they disagree. Pick one:
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {s.alternatives.map(alt => (
                            <div
                              key={alt.label}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                background: colors.panelBg,
                                borderRadius: 6,
                                padding: '8px 10px',
                              }}
                            >
                              <div style={{ fontSize: 12, fontFamily: fonts.mono, color: colors.textMuted }}>
                                {alt.label}: {alt.sampleBefore[0]} → {String(alt.sampleAfter[0])}
                              </div>
                              <button
                                onClick={() => handleApplySuggestion(activeDataset, alt)}
                                style={{
                                  background: colors.cardBg,
                                  color: colors.primaryLight,
                                  border: `1px solid ${colors.primary}66`,
                                  borderRadius: 6,
                                  padding: '4px 10px',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                              >
                                Use this
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, fontFamily: fonts.mono, color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {s.sampleBefore.slice(0, 3).map((before, i) => (
                          <div key={i}>
                            {before} → <span style={{ color: colors.success }}>{String(s.sampleAfter[i])}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Interactive TypeScript & JSON Schema Modal */}
      {typeModalData && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
            padding: 24,
          }}
          onClick={() => setTypeModalData(null)}
        >
          <div
            style={{
              background: colors.cardBg,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              maxWidth: 700,
              height: '80vh',
              maxHeight: 600,
              overflow: 'hidden',
              boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <strong style={{ fontSize: 16, color: colors.primaryLight, fontFamily: fonts.mono }}>
                  {typeModalData.title}
                </strong>
                <span style={{ fontSize: 12, color: colors.textDim, marginLeft: 10 }}>
                  Generated Schema & Interface
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => {
                    const text = typeModalTab === 'ts' ? typeModalData.tsInterface : typeModalData.jsonSchema;
                    navigator.clipboard.writeText(text);
                    setCopiedTypeBadge('modal');
                    setTimeout(() => setCopiedTypeBadge(null), 2000);
                  }}
                  style={{
                    background: 'linear-gradient(135deg, #0284c7, #2563eb)',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {copiedTypeBadge === 'modal' ? '✓ Copied to Clipboard!' : '📋 Copy to Clipboard'}
                </button>
                <button
                  onClick={() => setTypeModalData(null)}
                  style={{
                    background: colors.panelBg,
                    border: `1px solid ${colors.borderLight}`,
                    color: colors.text,
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', background: colors.panelBg, borderBottom: `1px solid ${colors.border}`, padding: '6px 16px', gap: 6 }}>
              <button
                onClick={() => setTypeModalTab('ts')}
                style={{
                  background: typeModalTab === 'ts' ? colors.cardBg : 'transparent',
                  color: typeModalTab === 'ts' ? colors.primaryLight : colors.textMuted,
                  border: `1px solid ${typeModalTab === 'ts' ? colors.borderLight : 'transparent'}`,
                  borderRadius: 6,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                📄 TypeScript Interface
              </button>
              <button
                onClick={() => setTypeModalTab('schema')}
                style={{
                  background: typeModalTab === 'schema' ? colors.cardBg : 'transparent',
                  color: typeModalTab === 'schema' ? colors.accent : colors.textMuted,
                  border: `1px solid ${typeModalTab === 'schema' ? colors.borderLight : 'transparent'}`,
                  borderRadius: 6,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                📋 JSON Schema
              </button>
            </div>

            <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
              <pre style={{ margin: 0, background: colors.panelBg, border: `1px solid ${colors.borderLight}`, borderRadius: 8, padding: 16, fontSize: 12, fontFamily: fonts.mono, color: typeModalTab === 'ts' ? colors.primaryLight : colors.accent, overflow: 'auto' }}>
                {typeModalTab === 'ts' ? typeModalData.tsInterface : typeModalData.jsonSchema}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Footer Status Bar */}
      <StatusBar
        isCapturing={isCapturing}
        captureCount={captures.length}
        datasetCount={definitions.length}
        totalBytes={totalBodyBytes}
      />
    </div>
  );
}
