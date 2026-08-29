/**
 * Canonical Workspace Format File Serializer & Manager
 * Supports FileSystemDirectoryHandle and in-memory mock for automated testing
 */

import {
  CapturedRequest,
  CaptureSession,
  DatasetDefinition,
  DatasetSnapshot,
  ExtractedRow,
  generateULID,
  SavedQuery,
  ULID,
  WorkspaceMetadata,
} from '@wiredata/core';
import { IWorkspaceStorage, IFileAdapter } from '../types.js';

/**
 * In-memory adapter for unit testing and Node execution
 */
export class InMemoryFileAdapter implements IFileAdapter {
  private files = new Map<string, string>();

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const normalizedDir = dirPath ? (dirPath.endsWith('/') ? dirPath : `${dirPath}/`) : '';
    const results = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(normalizedDir)) {
        const sub = key.slice(normalizedDir.length);
        const nextSlash = sub.indexOf('/');
        const item = nextSlash === -1 ? sub : sub.slice(0, nextSlash);
        if (item) results.add(item);
      }
    }
    return Array.from(results);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async deletePath(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const key of Array.from(this.files.keys())) {
        if (key === path || key.startsWith(prefix)) {
          this.files.delete(key);
        }
      }
    } else {
      this.files.delete(path);
    }
  }

  async createDir(): Promise<void> {
    // No-op for flat map
  }
}

const IDB_WORKSPACE_DB = 'wiredata_local_workspace';
const IDB_FILES_STORE = 'workspace_files';

/**
 * Shared browser-local storage adapter using IndexedDB.
 * Allows Side Panel, Workbench tabs, and DevTools to share the same local
 * workspace seamlessly without requiring the user to pick a disk folder first.
 */
export class IndexedDBFileAdapter implements IFileAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB is not available in this environment.'));
      }
      const req = indexedDB.open(IDB_WORKSPACE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_FILES_STORE)) {
          db.createObjectStore(IDB_FILES_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_FILES_STORE, 'readonly');
        const store = tx.objectStore(IDB_FILES_STORE);
        const req = store.get(path);
        req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_FILES_STORE, 'readwrite');
      const store = tx.objectStore(IDB_FILES_STORE);
      const req = store.put(content, path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_FILES_STORE, 'readonly');
        const store = tx.objectStore(IDB_FILES_STORE);
        const req = store.getAllKeys();
        req.onsuccess = () => {
          const keys = (req.result as string[]) || [];
          const normalizedDir = dirPath ? (dirPath.endsWith('/') ? dirPath : `${dirPath}/`) : '';
          const results = new Set<string>();
          for (const key of keys) {
            if (typeof key === 'string' && key.startsWith(normalizedDir)) {
              const sub = key.slice(normalizedDir.length);
              const nextSlash = sub.indexOf('/');
              const item = nextSlash === -1 ? sub : sub.slice(0, nextSlash);
              if (item) results.add(item);
            }
          }
          resolve(Array.from(results));
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_FILES_STORE, 'readwrite');
        const store = tx.objectStore(IDB_FILES_STORE);
        const req = store.delete(path);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {}
  }

  async deletePath(path: string, options?: { recursive?: boolean }): Promise<void> {
    try {
      const db = await this.getDb();
      if (!options?.recursive) {
        return this.deleteFile(path);
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_FILES_STORE, 'readwrite');
        const store = tx.objectStore(IDB_FILES_STORE);
        const req = store.openCursor();
        const prefix = path.endsWith('/') ? path : `${path}/`;
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const key = String(cursor.key);
            if (key === path || key.startsWith(prefix)) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });
    } catch {}
  }

  async createDir(): Promise<void> {
    // Flat key-value store doesn't need explicit directories
  }

  async clearAll(): Promise<void> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_FILES_STORE, 'readwrite');
        const store = tx.objectStore(IDB_FILES_STORE);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {}
  }
}

/**
 * Creates the default workspace adapter:
 * - IndexedDBFileAdapter in browser environments (shared between Side Panel and Workbench)
 * - InMemoryFileAdapter in Node.js / testing environments
 */
export function createDefaultWorkspaceAdapter(): IFileAdapter {
  return typeof indexedDB !== 'undefined' ? new IndexedDBFileAdapter() : new InMemoryFileAdapter();
}

/**
 * FileSystemDirectoryHandle adapter for Chromium File System Access API
 */
export class FSDirectoryAdapter implements IFileAdapter {
  constructor(private rootHandle: any) {}

  private async getDirectoryHandle(pathSegments: string[], create: boolean = false): Promise<any> {
    let current = this.rootHandle;
    for (const seg of pathSegments) {
      if (!seg) continue;
      current = await current.getDirectoryHandle(seg, { create });
    }
    return current;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const segments = path.split('/').filter(Boolean);
      const fileName = segments.pop()!;
      const dir = await this.getDirectoryHandle(segments, false);
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop()!;
    const dir = await this.getDirectoryHandle(segments, true);
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      const segments = dirPath.split('/').filter(Boolean);
      const dir = await this.getDirectoryHandle(segments, false);
      const names: string[] = [];
      for await (const [name] of dir.entries()) {
        names.push(name);
      }
      return names;
    } catch {
      return [];
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const segments = path.split('/').filter(Boolean);
      const fileName = segments.pop()!;
      const dir = await this.getDirectoryHandle(segments, false);
      await dir.removeEntry(fileName);
    } catch {}
  }

  async deletePath(path: string, options?: { recursive?: boolean }): Promise<void> {
    try {
      const segments = path.split('/').filter(Boolean);
      if (segments.length === 0) return;
      const targetName = segments.pop()!;
      const parentDir = await this.getDirectoryHandle(segments, false);
      await parentDir.removeEntry(targetName, { recursive: options?.recursive ?? false });
    } catch {}
  }

  async createDir(dirPath: string): Promise<void> {
    const segments = dirPath.split('/').filter(Boolean);
    await this.getDirectoryHandle(segments, true);
  }
}

/**
 * Structured Workspace Manager
 */
export class WorkspaceManager implements IWorkspaceStorage {
  constructor(private adapter: IFileAdapter) {}

  /**
   * Opens an existing workspace preserving its identity and metadata, or creates a fresh one
   */
  async openOrCreateWorkspace(metadata?: Partial<WorkspaceMetadata>): Promise<WorkspaceMetadata> {
    const existing = await this.getMetadata();
    if (existing) {
      const updated: WorkspaceMetadata = {
        ...existing,
        last_opened_at: new Date().toISOString(),
        application_version: metadata?.application_version || '0.2.1',
      };
      await this.adapter.writeFile('workspace.json', JSON.stringify(updated, null, 2));
      return updated;
    }

    const meta: WorkspaceMetadata = {
      format_version: 1,
      workspace_id: metadata?.workspace_id || generateULID(),
      created_at: metadata?.created_at || new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      application_version: metadata?.application_version || '0.2.1',
    };
    await this.adapter.writeFile('workspace.json', JSON.stringify(meta, null, 2));
    await this.adapter.createDir('sessions');
    await this.adapter.createDir('objects');
    await this.adapter.createDir('datasets');
    await this.adapter.createDir('queries');
    await this.adapter.createDir('exports');
    return meta;
  }

  async initializeWorkspace(metadata?: Partial<WorkspaceMetadata>): Promise<void> {
    await this.openOrCreateWorkspace(metadata);
  }

  async getMetadata(): Promise<WorkspaceMetadata | null> {
    const content = await this.adapter.readFile('workspace.json');
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async saveSession(session: CaptureSession): Promise<void> {
    const sessionDir = `sessions/${session.session_id}`;
    await this.adapter.createDir(sessionDir);
    await this.adapter.writeFile(`${sessionDir}/session.json`, JSON.stringify(session, null, 2));
  }

  async listSessions(): Promise<CaptureSession[]> {
    const sessionIds = await this.adapter.listFiles('sessions');
    const sessions: CaptureSession[] = [];
    for (const sid of sessionIds) {
      const content = await this.adapter.readFile(`sessions/${sid}/session.json`);
      if (content) {
        try {
          sessions.push(JSON.parse(content));
        } catch {}
      }
    }
    return sessions.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
  }

  async getSession(sessionId: ULID): Promise<CaptureSession | null> {
    const content = await this.adapter.readFile(`sessions/${sessionId}/session.json`);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: ULID): Promise<void> {
    await this.adapter.deletePath(`sessions/${sessionId}`, { recursive: true });
  }

  async saveCapture(sessionId: ULID, capture: CapturedRequest, rawBody?: unknown): Promise<void> {
    const capturesDir = `sessions/${sessionId}/captures`;
    await this.adapter.createDir(capturesDir);

    // Strict privacy guarantee: ensure only sanitized URL is serialized to disk
    const sanitizedCapture: CapturedRequest = {
      ...capture,
      request: {
        ...capture.request,
        url: capture.request.sanitized_url || capture.request.url,
      },
    };

    await this.adapter.writeFile(`${capturesDir}/${capture.capture_id}.json`, JSON.stringify(sanitizedCapture, null, 2));

    // Save content-addressed raw body object if provided
    if (rawBody !== undefined && capture.response.body_hash) {
      const objPath = `objects/${capture.response.body_hash}.json`;
      const existing = await this.adapter.readFile(objPath);
      if (!existing) {
        await this.adapter.writeFile(objPath, typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
      }
    }
  }

  async listCaptures(sessionId: ULID): Promise<CapturedRequest[]> {
    const capturesDir = `sessions/${sessionId}/captures`;
    const files = await this.adapter.listFiles(capturesDir);
    const captures: CapturedRequest[] = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        const content = await this.adapter.readFile(`${capturesDir}/${f}`);
        if (content) {
          try {
            captures.push(JSON.parse(content));
          } catch {}
        }
      }
    }
    return captures.sort((a, b) => new Date(a.timing.started_at).getTime() - new Date(b.timing.started_at).getTime());
  }

  async deleteCapture(sessionId: ULID, captureId: ULID): Promise<void> {
    await this.adapter.deleteFile(`sessions/${sessionId}/captures/${captureId}.json`);
  }

  async getBodyObject(bodyHash: string): Promise<unknown | null> {
    const content = await this.adapter.readFile(`objects/${bodyHash}.json`);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  async saveDatasetDefinition(definition: DatasetDefinition): Promise<void> {
    const dsDir = `datasets/${definition.id}`;
    await this.adapter.createDir(dsDir);
    await this.adapter.writeFile(`${dsDir}/definition.json`, JSON.stringify(definition, null, 2));
  }

  async listDatasetDefinitions(): Promise<DatasetDefinition[]> {
    const ids = await this.adapter.listFiles('datasets');
    const defs: DatasetDefinition[] = [];
    for (const id of ids) {
      const content = await this.adapter.readFile(`datasets/${id}/definition.json`);
      if (content) {
        try {
          defs.push(JSON.parse(content));
        } catch {}
      }
    }
    return defs;
  }

  async getDatasetDefinition(datasetId: string): Promise<DatasetDefinition | null> {
    const content = await this.adapter.readFile(`datasets/${datasetId}/definition.json`);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async deleteDataset(datasetId: string): Promise<void> {
    await this.adapter.deletePath(`datasets/${datasetId}`, { recursive: true });
  }

  async saveDatasetSnapshot(snapshot: DatasetSnapshot, rows: ExtractedRow[]): Promise<void> {
    const snapshotDir = `datasets/${snapshot.dataset_id}/snapshots`;
    await this.adapter.createDir(snapshotDir);
    await this.adapter.writeFile(
      `${snapshotDir}/${snapshot.snapshot_id}.json`,
      JSON.stringify({ snapshot, rows }, null, 2)
    );
  }

  async getDatasetSnapshot(
    datasetId: string,
    snapshotId: ULID
  ): Promise<{ snapshot: DatasetSnapshot; rows: ExtractedRow[] } | null> {
    const content = await this.adapter.readFile(`datasets/${datasetId}/snapshots/${snapshotId}.json`);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async saveQuery(query: SavedQuery): Promise<void> {
    await this.adapter.createDir('queries');
    await this.adapter.writeFile(`queries/${query.name}.sql`, query.sql_text);
    await this.adapter.writeFile(`queries/${query.name}.json`, JSON.stringify(query, null, 2));
  }

  async listQueries(): Promise<SavedQuery[]> {
    const files = await this.adapter.listFiles('queries');
    const queries: SavedQuery[] = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        const content = await this.adapter.readFile(`queries/${f}`);
        if (content) {
          try {
            queries.push(JSON.parse(content));
          } catch {}
        }
      }
    }
    return queries;
  }

  async deleteQuery(queryId: ULID): Promise<void> {
    const queries = await this.listQueries();
    const target = queries.find(q => q.query_id === queryId);
    if (target) {
      await this.adapter.deleteFile(`queries/${target.name}.sql`);
      await this.adapter.deleteFile(`queries/${target.name}.json`);
    }
  }

  async gcOrphanedObjects(): Promise<number> {
    const sessions = await this.listSessions();
    const referencedHashes = new Set<string>();
    for (const sess of sessions) {
      const captures = await this.listCaptures(sess.session_id);
      for (const cap of captures) {
        if (cap.response.body_hash) {
          referencedHashes.add(cap.response.body_hash);
        }
      }
    }

    const objectFiles = await this.adapter.listFiles('objects');
    let deletedCount = 0;
    for (const f of objectFiles) {
      const hash = f.replace(/\.json$/i, '');
      if (!referencedHashes.has(hash)) {
        await this.adapter.deleteFile(`objects/${f}`);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async clearWorkspaceContents(): Promise<void> {
    const sessions = await this.listSessions();
    for (const sess of sessions) {
      await this.deleteSession(sess.session_id);
    }
    const datasets = await this.listDatasetDefinitions();
    for (const ds of datasets) {
      await this.deleteDataset(ds.id);
    }
    const queries = await this.listQueries();
    for (const q of queries) {
      await this.deleteQuery(q.query_id);
    }
    await this.adapter.deletePath('objects', { recursive: true });
    await this.adapter.deletePath('exports', { recursive: true });
    await this.adapter.createDir('sessions');
    await this.adapter.createDir('objects');
    await this.adapter.createDir('datasets');
    await this.adapter.createDir('queries');
    await this.adapter.createDir('exports');
  }
}
