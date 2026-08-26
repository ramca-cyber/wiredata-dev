/**
 * Storage and Workspace interfaces for @wiredata/workspace
 */

import {
  CapturedRequest,
  CaptureSession,
  DatasetDefinition,
  DatasetSnapshot,
  ExtractedRow,
  SavedQuery,
  ULID,
  WorkspaceMetadata,
} from '@wiredata/core';

export interface WALQueueItem {
  id: ULID;
  session_id: ULID;
  type: 'capture' | 'session_update' | 'body_object';
  payload: any;
  created_at: string;
}

export interface IWorkspaceStorage {
  initializeWorkspace(metadata: WorkspaceMetadata): Promise<void>;
  getMetadata(): Promise<WorkspaceMetadata | null>;
  saveSession(session: CaptureSession): Promise<void>;
  listSessions(): Promise<CaptureSession[]>;
  getSession(sessionId: ULID): Promise<CaptureSession | null>;
  deleteSession(sessionId: ULID): Promise<void>;

  saveCapture(sessionId: ULID, capture: CapturedRequest, rawBody?: unknown): Promise<void>;
  listCaptures(sessionId: ULID): Promise<CapturedRequest[]>;
  deleteCapture(sessionId: ULID, captureId: ULID): Promise<void>;
  getBodyObject(bodyHash: string): Promise<unknown | null>;

  saveDatasetDefinition(definition: DatasetDefinition): Promise<void>;
  listDatasetDefinitions(): Promise<DatasetDefinition[]>;
  getDatasetDefinition(datasetId: string): Promise<DatasetDefinition | null>;
  saveDatasetSnapshot(snapshot: DatasetSnapshot, rows: ExtractedRow[]): Promise<void>;
  getDatasetSnapshot(datasetId: string, snapshotId: ULID): Promise<{ snapshot: DatasetSnapshot; rows: ExtractedRow[] } | null>;

  saveQuery(query: SavedQuery): Promise<void>;
  listQueries(): Promise<SavedQuery[]>;
  deleteQuery(queryId: ULID): Promise<void>;
}
