import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryFileAdapter,
  WorkspaceManager,
} from '../src/format/workspace.js';
import {
  CapturedRequest,
  CaptureSession,
  DatasetDefinition,
  DatasetSnapshot,
  ExtractedRow,
  generateULID,
} from '@wiredata/core';

describe('Workspace Storage & Serialization', () => {
  let adapter: InMemoryFileAdapter;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    adapter = new InMemoryFileAdapter();
    manager = new WorkspaceManager(adapter);
    await manager.initializeWorkspace();
  });

  it('initializes workspace with versioned metadata', async () => {
    const metadata = await manager.getMetadata();
    expect(metadata).not.toBeNull();
    expect(metadata?.format_version).toBe(1);
    expect(metadata?.application_version).toBe('0.2.0');
  });

  it('saves and lists capture sessions', async () => {
    const sessionId = generateULID();
    const session: CaptureSession = {
      session_id: sessionId,
      name: 'Test Session',
      started_at: new Date().toISOString(),
      initial_page_url: 'https://example.com/app',
      navigation_history: [],
      capture_count: 5,
      body_bytes: 1024,
      application_version: '0.1.0',
      status: 'complete',
    };

    await manager.saveSession(session);
    const list = await manager.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].session_id).toBe(sessionId);
    expect(list[0].name).toBe('Test Session');
  });

  it('saves and retrieves captures with content-addressed body deduplication', async () => {
    const sessionId = generateULID();
    const captureId = generateULID();
    const bodyHash = 'sha256_mock_hash_123';
    const rawBody = { data: [{ id: 1, name: 'Alice' }] };

    const capture: CapturedRequest = {
      capture_id: captureId,
      session_id: sessionId,
      request: {
        url: 'https://example.com/api/test',
        sanitized_url: 'https://example.com/api/test',
        method: 'GET',
        query_parameters: [],
        headers: [],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        headers: [],
        body_size: 100,
        body_hash: bodyHash,
        body_object_ref: bodyHash,
      },
      timing: {
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 50,
      },
      classification: {
        json_candidate: true,
        parse_status: 'parsed',
      },
    };

    await manager.saveCapture(sessionId, capture, rawBody);
    const captures = await manager.listCaptures(sessionId);
    expect(captures).toHaveLength(1);
    expect(captures[0].capture_id).toBe(captureId);

    const retrievedBody = await manager.getBodyObject(bodyHash);
    expect(retrievedBody).toEqual(rawBody);
  });

  it('saves and retrieves dataset definitions and snapshots', async () => {
    const datasetId = 'ds_orders';
    const snapshotId = generateULID();

    const definition: DatasetDefinition = {
      id: datasetId,
      name: 'orders',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [],
      extraction: {
        record_pointer: '/data',
        nested_object_policy: 'flatten',
        nested_array_policy: 'json',
        flatten_delimiter: '__',
      },
      identity_columns: ['id'],
      deduplication: 'keep_latest',
      columns: {},
    };

    const snapshot: DatasetSnapshot = {
      snapshot_id: snapshotId,
      dataset_id: datasetId,
      definition_version: 1,
      created_at: new Date().toISOString(),
      row_count: 1,
      column_count: 1,
      contributing_capture_ids: [],
      schema: {},
      coverage: { observed_unique_rows: 1, status: 'complete' },
      duplicate_count: 0,
      type_anomalies: [],
    };

    const rows: ExtractedRow[] = [
      {
        row_id: generateULID(),
        values: { id: 1 },
        lineage: {
          row_id: generateULID(),
          session_id: generateULID(),
          capture_id: generateULID(),
          response_hash: 'h',
          record_pointer: '/',
          request_url: 'u',
          captured_at: new Date().toISOString(),
        },
        field_lineage: {},
      },
    ];

    await manager.saveDatasetDefinition(definition);
    await manager.saveDatasetSnapshot(snapshot, rows);

    const savedDef = await manager.getDatasetDefinition(datasetId);
    expect(savedDef?.name).toBe('orders');

    const savedSnapshot = await manager.getDatasetSnapshot(datasetId, snapshotId);
    expect(savedSnapshot?.snapshot.snapshot_id).toBe(snapshotId);
    expect(savedSnapshot?.rows).toHaveLength(1);
  });

  it('openOrCreateWorkspace preserves workspace identity and metadata when reopened', async () => {
    const initialMeta = await manager.getMetadata();
    expect(initialMeta).not.toBeNull();
    const originalWorkspaceId = initialMeta!.workspace_id;
    const originalCreatedAt = initialMeta!.created_at;

    // Simulate another surface (e.g. Workbench tab) opening the exact same adapter
    const secondManager = new WorkspaceManager(adapter);
    const secondMeta = await secondManager.openOrCreateWorkspace();

    expect(secondMeta.workspace_id).toBe(originalWorkspaceId);
    expect(secondMeta.created_at).toBe(originalCreatedAt);
  });

  it('saveCapture guarantees only sanitized URL is serialized to disk', async () => {
    const sessionId = generateULID();
    const captureId = generateULID();

    const capture: CapturedRequest = {
      capture_id: captureId,
      session_id: sessionId,
      capture_mode: 'page',
      request: {
        url: 'https://api.com/checkout?token=RAW_SECRET_123',
        sanitized_url: 'https://api.com/checkout?token=[REDACTED]',
        method: 'POST',
        query_parameters: [{ name: 'token', value: '[REDACTED]', is_redacted: true }],
      },
      response: {
        status: 200,
        status_text: 'OK',
        mime_type: 'application/json',
        body_size: 20,
        body_hash: 'h_clean',
        body_object_ref: 'h_clean',
      },
      timing: { started_at: '', completed_at: '', duration_ms: 10 },
      classification: { json_candidate: true, parse_status: 'parsed' },
    };

    await manager.saveCapture(sessionId, capture);
    const rawFileContent = await adapter.readFile(`sessions/${sessionId}/captures/${captureId}.json`);
    expect(rawFileContent).not.toBeNull();
    expect(rawFileContent).not.toContain('RAW_SECRET_123');
    expect(rawFileContent).toContain('[REDACTED]');
  });

  it('deletes datasets and snapshots recursively', async () => {
    const datasetId = 'ds_to_delete';
    const snapshotId = generateULID();

    await manager.saveDatasetDefinition({
      id: datasetId,
      name: 'delete_me',
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      sources: [],
      extraction: { record_pointer: '/', nested_object_policy: 'flatten', nested_array_policy: 'json', flatten_delimiter: '__' },
      identity_columns: [],
      deduplication: 'keep_all',
      columns: {},
    });

    await manager.saveDatasetSnapshot(
      {
        snapshot_id: snapshotId,
        dataset_id: datasetId,
        definition_version: 1,
        created_at: new Date().toISOString(),
        row_count: 0,
        column_count: 0,
        contributing_capture_ids: [],
        schema: {},
        coverage: { observed_unique_rows: 0, status: 'complete' },
        duplicate_count: 0,
        type_anomalies: [],
      },
      []
    );

    expect(await manager.getDatasetDefinition(datasetId)).not.toBeNull();
    await manager.deleteDataset(datasetId);
    expect(await manager.getDatasetDefinition(datasetId)).toBeNull();
    expect(await manager.getDatasetSnapshot(datasetId, snapshotId)).toBeNull();
  });

  it('deletes sessions recursively and garbage collects orphaned objects', async () => {
    const sessionId = generateULID();
    const captureId = generateULID();
    const bodyHash = 'orphan_test_hash';
    const rawBody = { test: true };

    const capture: CapturedRequest = {
      capture_id: captureId,
      session_id: sessionId,
      request: { url: 'https://test.com', sanitized_url: 'https://test.com', method: 'GET', query_parameters: [] },
      response: { status: 200, status_text: 'OK', mime_type: 'application/json', body_size: 10, body_hash: bodyHash, body_object_ref: bodyHash },
      timing: { started_at: '', completed_at: '', duration_ms: 1 },
      classification: { json_candidate: true, parse_status: 'parsed' },
    };

    await manager.saveSession({
      session_id: sessionId,
      name: 'GC Test',
      started_at: new Date().toISOString(),
      initial_page_url: '',
      navigation_history: [],
      capture_count: 1,
      body_bytes: 10,
      application_version: '0.1.8',
      status: 'complete',
    });
    await manager.saveCapture(sessionId, capture, rawBody);

    expect(await manager.getBodyObject(bodyHash)).toEqual(rawBody);

    // Deleting session should remove captures
    await manager.deleteSession(sessionId);
    expect(await manager.getSession(sessionId)).toBeNull();
    expect(await manager.listCaptures(sessionId)).toHaveLength(0);

    // GC should now purge the unreferenced body object
    const deletedCount = await manager.gcOrphanedObjects();
    expect(deletedCount).toBe(1);
    expect(await manager.getBodyObject(bodyHash)).toBeNull();
  });

  it('clearWorkspaceContents wipes all working state while keeping workspace metadata', async () => {
    const metaBefore = await manager.getMetadata();
    expect(metaBefore).not.toBeNull();

    const sessionId = generateULID();
    await manager.saveSession({
      session_id: sessionId,
      name: 'To Clear',
      started_at: new Date().toISOString(),
      initial_page_url: '',
      navigation_history: [],
      capture_count: 0,
      body_bytes: 0,
      application_version: '0.1.8',
      status: 'new',
    });

    await manager.clearWorkspaceContents();

    const sessions = await manager.listSessions();
    expect(sessions).toHaveLength(0);

    const metaAfter = await manager.getMetadata();
    expect(metaAfter?.workspace_id).toBe(metaBefore?.workspace_id);
    expect(metaAfter?.format_version).toBe(1);
  });
});
