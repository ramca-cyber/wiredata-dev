/**
 * Write-Ahead Log (WAL) Queue for Active Network Captures
 * Backed by IndexedDB/OPFS with crash recovery support
 */

import { generateULID, ULID } from '@wiredata/core';
import { WALQueueItem } from '../types.js';

const DB_NAME = 'wiredata_wal_db';
const STORE_NAME = 'wal_entries';
const DB_VERSION = 1;

export class WALQueue {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor() {
    if (typeof indexedDB !== 'undefined') {
      this.dbPromise = this.openDatabase();
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('session_id', 'session_id', { unique: false });
          store.createIndex('created_at', 'created_at', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Enqueues a captured item to WAL before flushing to filesystem
   */
  async enqueue(sessionId: ULID, type: 'capture' | 'session_update' | 'body_object', payload: any): Promise<ULID> {
    const entry: WALQueueItem = {
      id: generateULID(),
      session_id: sessionId,
      type,
      payload,
      created_at: new Date().toISOString(),
    };

    if (!this.dbPromise) {
      return entry.id;
    }

    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.add(entry);
      req.onsuccess = () => resolve(entry.id);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves all unfinalized WAL entries (for crash recovery)
   */
  async getUnfinalizedEntries(): Promise<WALQueueItem[]> {
    if (!this.dbPromise) return [];
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Removes processed WAL entries
   */
  async removeEntries(entryIds: ULID[]): Promise<void> {
    if (!this.dbPromise || entryIds.length === 0) return;
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of entryIds) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clears entire WAL store for a specific session
   */
  async clearSession(sessionId: ULID): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    const entries = await this.getUnfinalizedEntries();
    const sessionEntries = entries.filter(e => e.session_id === sessionId);
    await this.removeEntries(sessionEntries.map(e => e.id));
  }
}
