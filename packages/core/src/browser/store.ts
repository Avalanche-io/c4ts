import type { C4ID } from '../id.js'
import { identifyBytes } from '../id.js'
import type { Store } from '../store.js'
import { ContentNotFoundError } from '../store.js'
import { streamToBytes, bytesToStream } from '../filesystem.js'

const DB_VERSION = 1
const OBJECTS_STORE = 'objects'

/**
 * Browser-persistent content store backed by IndexedDB.
 * Content survives tab close, page reload, and browser restart.
 *
 * Each store is identified by a database name (e.g., project name).
 * Blobs are stored directly in IndexedDB (no base64 overhead).
 */
export class IndexedDBStore implements Store {
  private dbName: string
  private db: IDBDatabase | null = null

  constructor(dbName: string) {
    this.dbName = `c4-store-${dbName}`
  }

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION)

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(OBJECTS_STORE)) {
          db.createObjectStore(OBJECTS_STORE)
        }
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }

      request.onerror = () => reject(request.error)
    })
  }

  async has(id: C4ID): Promise<boolean> {
    const db = await this.open()
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(OBJECTS_STORE, 'readonly')
      const store = tx.objectStore(OBJECTS_STORE)
      const request = store.getKey(id.toString())
      request.onsuccess = () => resolve(request.result !== undefined)
      request.onerror = () => reject(request.error)
    })
  }

  async get(id: C4ID): Promise<ReadableStream<Uint8Array>> {
    const db = await this.open()
    const key = id.toString()

    return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      const tx = db.transaction(OBJECTS_STORE, 'readonly')
      const store = tx.objectStore(OBJECTS_STORE)
      const request = store.get(key)

      request.onsuccess = () => {
        if (request.result === undefined) {
          reject(new ContentNotFoundError(id))
          return
        }
        const bytes = new Uint8Array(request.result as ArrayBuffer)
        resolve(bytesToStream(bytes))
      }

      request.onerror = () => reject(request.error)
    })
  }

  async put(data: ReadableStream<Uint8Array> | Uint8Array): Promise<C4ID> {
    const bytes = data instanceof Uint8Array ? data : await streamToBytes(data)
    const id = await identifyBytes(bytes)
    const key = id.toString()

    const db = await this.open()
    return new Promise<C4ID>((resolve, reject) => {
      const tx = db.transaction(OBJECTS_STORE, 'readwrite')
      const store = tx.objectStore(OBJECTS_STORE)
      // Store as ArrayBuffer for efficiency
      const request = store.put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key)
      request.onsuccess = () => resolve(id)
      request.onerror = () => reject(request.error)
    })
  }

  async remove(id: C4ID): Promise<void> {
    const db = await this.open()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OBJECTS_STORE, 'readwrite')
      const store = tx.objectStore(OBJECTS_STORE)
      const request = store.delete(id.toString())
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  /** Count stored objects. */
  async count(): Promise<number> {
    const db = await this.open()
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(OBJECTS_STORE, 'readonly')
      const store = tx.objectStore(OBJECTS_STORE)
      const request = store.count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  /** Iterate all stored C4 ID keys. */
  async *keys(): AsyncIterable<string> {
    const db = await this.open()
    const tx = db.transaction(OBJECTS_STORE, 'readonly')
    const store = tx.objectStore(OBJECTS_STORE)
    const request = store.openKeyCursor()

    while (true) {
      const cursor = await new Promise<IDBCursor | null>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (!cursor) break
      yield cursor.key as string
      cursor.continue()
    }
  }

  /** Delete the entire database. */
  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}
