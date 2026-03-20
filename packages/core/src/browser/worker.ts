import { C4ID, identifyBytes } from '../id.js'

/**
 * Web Worker-based hash pool for parallel SHA-512 computation.
 * Distributes hashing across multiple workers to prevent UI blocking.
 *
 * Each worker uses WebCrypto (hardware-accelerated in all modern browsers).
 *
 * Usage:
 *   const pool = createHashPool(4)
 *   const id = await pool.identify(largeFileBytes)
 *   const ids = await pool.identifyAll(fileList, { progress })
 *   pool.terminate()
 */
export interface HashPool {
  /** Hash a single byte array. */
  identify(data: Uint8Array): Promise<C4ID>

  /** Hash a File object (browser File API). */
  identifyFile(file: File): Promise<C4ID>

  /** Hash multiple items in parallel with progress reporting. */
  identifyAll(
    items: Array<Uint8Array | File>,
    options?: { progress?: (index: number, total: number) => void },
  ): Promise<C4ID[]>

  /** Terminate all workers. */
  terminate(): void

  /** Number of workers in the pool. */
  readonly size: number
}

/** Worker message types. */
interface WorkerRequest {
  id: number
  data: ArrayBuffer
}

interface WorkerResponse {
  id: number
  digest: ArrayBuffer
}

/**
 * Create a hash worker pool.
 *
 * @param workerCount Number of Web Workers (default: navigator.hardwareConcurrency or 4)
 */
export function createHashPool(workerCount?: number): HashPool {
  const count = workerCount ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4

  // Worker script as a blob URL (no separate file needed)
  const workerScript = `
    self.onmessage = async function(e) {
      const { id, data } = e.data;
      const digest = await crypto.subtle.digest('SHA-512', data);
      self.postMessage({ id, digest: digest }, [digest]);
    };
  `
  const blob = new Blob([workerScript], { type: 'application/javascript' })
  const workerUrl = URL.createObjectURL(blob)

  const workers: Worker[] = []
  const pending = new Map<number, { resolve: (digest: ArrayBuffer) => void; reject: (err: Error) => void }>()
  let nextId = 0
  let nextWorker = 0

  // Create workers
  for (let i = 0; i < count; i++) {
    const worker = new Worker(workerUrl)
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, digest } = e.data
      const cb = pending.get(id)
      if (cb) {
        pending.delete(id)
        cb.resolve(digest)
      }
    }
    worker.onerror = (e) => {
      // Reject all pending requests for this worker
      // In practice this shouldn't happen with simple SHA-512
      console.error('Hash worker error:', e)
    }
    workers.push(worker)
  }

  function dispatch(data: ArrayBuffer): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })

      const worker = workers[nextWorker % workers.length]
      nextWorker++

      // Transfer the buffer to avoid copying
      worker.postMessage({ id, data } as WorkerRequest, [data])
    })
  }

  return {
    get size() { return count },

    async identify(data: Uint8Array): Promise<C4ID> {
      // Copy to transferable ArrayBuffer
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      const digest = await dispatch(buffer)
      return new C4ID(new Uint8Array(digest))
    },

    async identifyFile(file: File): Promise<C4ID> {
      const buffer = await file.arrayBuffer() as ArrayBuffer
      const digest = await dispatch(buffer)
      return new C4ID(new Uint8Array(digest))
    },

    async identifyAll(
      items: Array<Uint8Array | File>,
      options?: { progress?: (index: number, total: number) => void },
    ): Promise<C4ID[]> {
      const total = items.length
      let completed = 0

      const promises = items.map(async (item, _index) => {
        let buffer: ArrayBuffer
        if (item instanceof Uint8Array) {
          buffer = item.buffer.slice(item.byteOffset, item.byteOffset + item.byteLength) as ArrayBuffer
        } else {
          buffer = await item.arrayBuffer() as ArrayBuffer
        }
        const digest = await dispatch(buffer)
        completed++
        options?.progress?.(completed, total)
        return new C4ID(new Uint8Array(digest))
      })

      return Promise.all(promises)
    },

    terminate(): void {
      for (const worker of workers) {
        worker.terminate()
      }
      workers.length = 0
      URL.revokeObjectURL(workerUrl)

      // Reject any pending requests
      for (const [, cb] of pending) {
        cb.reject(new Error('worker pool terminated'))
      }
      pending.clear()
    },
  }
}
