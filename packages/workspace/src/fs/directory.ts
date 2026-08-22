/**
 * File System Access API Handle Management & IndexedDB Persistence
 */

const FS_HANDLE_DB = 'wiredata_fs_db';
const FS_HANDLE_STORE = 'fs_handles';

export class DirectoryHandleManager {
  private static async getDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(FS_HANDLE_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FS_HANDLE_STORE)) {
          db.createObjectStore(FS_HANDLE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Prompts user for a directory picker (Chromium File System Access API)
   */
  static async pickDirectory(): Promise<FileSystemDirectoryHandle> {
    if (typeof (window as any).showDirectoryPicker !== 'function') {
      throw new Error('File System Access API (showDirectoryPicker) is not supported in this environment.');
    }
    const handle = await (window as any).showDirectoryPicker({
      mode: 'readwrite',
    });
    await this.persistHandle('active_workspace', handle);
    return handle;
  }

  /**
   * Persists handle in IndexedDB
   */
  static async persistHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(FS_HANDLE_STORE);
      const req = store.put(handle, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Loads previously persisted directory handle from IndexedDB
   */
  static async loadHandle(key: string = 'active_workspace'): Promise<FileSystemDirectoryHandle | null> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(FS_HANDLE_STORE, 'readonly');
        const store = tx.objectStore(FS_HANDLE_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  /**
   * Checks or requests permission for a persisted handle
   */
  static async verifyPermission(
    handle: any,
    mode: 'read' | 'readwrite' = 'readwrite'
  ): Promise<boolean> {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === 'granted') {
      return true;
    }
    if (typeof handle.requestPermission === 'function') {
      if ((await handle.requestPermission(opts)) === 'granted') {
        return true;
      }
    }
    return false;
  }
}
