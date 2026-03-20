import type { C4ID } from './id.js'
import type { FileSystem } from './filesystem.js'
import { streamToBytes, bytesToStream, joinPath } from './filesystem.js'
import type { Store } from './store.js'
import { Manifest } from './manifest.js'
import { type Entry } from './entry.js'
import { diff, type DiffResult } from './diff.js'
import { scan, type ScanOptions } from './scanner.js'
import { plan, apply, type ReconcileResult, type ReconcilePlan } from './reconcile.js'

const STATE_FILE = '.c4-workspace.json'
const MANIFEST_FILE = '.c4-workspace-manifest.c4m'

/** Persisted workspace state. */
interface WorkspaceState {
  manifestC4ID: string | null
  created: string
  lastCheckout: string | null
}

/** Workspace status information. */
export interface WorkspaceStatus {
  path: string
  exists: boolean
  hasManifest: boolean
  manifestC4ID: string | null
  created: string | null
  lastCheckout: string | null
}

export interface CheckoutOptions {
  progress?: (op: string, path: string, index: number, total: number) => void
  dryRun?: boolean
}

export interface SnapshotOptions {
  storeContent?: boolean
  progress?: (path: string, filesProcessed: number) => void
  skipHidden?: boolean
}

/**
 * Declarative directory management backed by a content store.
 *
 * A workspace ties a directory (via FileSystem) to a Store, enabling
 * checkout (materialize a manifest), snapshot (capture current state),
 * reset (revert to last checkout), and diff.
 *
 * Generic over FileSystem and Store — works in browser, Node, or memory.
 */
export class Workspace {
  readonly rootPath: string
  readonly fs: FileSystem
  readonly store: Store

  private state: WorkspaceState | null = null
  private currentManifest: Manifest | null = null

  constructor(rootPath: string, fs: FileSystem, store: Store) {
    this.rootPath = rootPath
    this.fs = fs
    this.store = store
  }

  /**
   * Load persisted workspace state from disk.
   * Call this after construction to restore previous session state.
   */
  async load(): Promise<void> {
    try {
      const stateStream = await this.fs.readFile(joinPath(this.rootPath, STATE_FILE))
      const stateBytes = await streamToBytes(stateStream)
      const stateText = new TextDecoder().decode(stateBytes)
      this.state = JSON.parse(stateText)
    } catch {
      this.state = null
    }

    try {
      const manifestStream = await this.fs.readFile(joinPath(this.rootPath, MANIFEST_FILE))
      const manifestBytes = await streamToBytes(manifestStream)
      const manifestText = new TextDecoder().decode(manifestBytes)
      this.currentManifest = await Manifest.parse(manifestText)
    } catch {
      this.currentManifest = null
    }
  }

  /**
   * Make the directory match a manifest.
   * Only transfers content that differs from what's on disk.
   */
  async checkout(manifest: Manifest, options?: CheckoutOptions): Promise<ReconcileResult | ReconcilePlan> {
    const p = await plan(manifest, this.fs, this.rootPath, this.store)

    if (options?.dryRun) return p

    const result = await apply(p, this.fs, this.rootPath, this.store, {
      progress: options?.progress,
    })

    // Persist state
    this.currentManifest = manifest
    const c4id = await manifest.computeC4ID()
    this.state = {
      manifestC4ID: c4id.toString(),
      created: this.state?.created ?? new Date().toISOString(),
      lastCheckout: new Date().toISOString(),
    }
    await this.saveState()

    return result
  }

  /**
   * Capture the current directory state as a manifest.
   */
  async snapshot(options?: SnapshotOptions): Promise<Manifest> {
    const scanOpts: ScanOptions = {
      store: options?.storeContent ? this.store : undefined,
      progress: options?.progress,
      skipHidden: options?.skipHidden ?? true,
      computeIds: true,
    }
    return scan(this.fs, this.rootPath, scanOpts)
  }

  /**
   * Restore the directory to the last checked-out manifest.
   */
  async reset(options?: { progress?: CheckoutOptions['progress'] }): Promise<ReconcileResult> {
    if (!this.currentManifest) {
      throw new Error('no manifest checked out — cannot reset')
    }
    const p = await plan(this.currentManifest, this.fs, this.rootPath, this.store)
    return apply(p, this.fs, this.rootPath, this.store, {
      progress: options?.progress,
    })
  }

  /**
   * Compare current directory state against the checked-out manifest.
   */
  async diffFromCurrent(options?: { progress?: SnapshotOptions['progress'] }): Promise<DiffResult> {
    if (!this.currentManifest) {
      throw new Error('no manifest checked out — cannot diff')
    }
    const current = await this.snapshot({ progress: options?.progress })
    return diff(this.currentManifest, current)
  }

  /** Get workspace status. */
  status(): WorkspaceStatus {
    return {
      path: this.rootPath,
      exists: this.state !== null,
      hasManifest: this.currentManifest !== null,
      manifestC4ID: this.state?.manifestC4ID ?? null,
      created: this.state?.created ?? null,
      lastCheckout: this.state?.lastCheckout ?? null,
    }
  }

  /** The currently checked-out manifest, or null. */
  get manifest(): Manifest | null {
    return this.currentManifest
  }

  private async saveState(): Promise<void> {
    if (!this.state) return

    // Save state JSON
    const stateJson = JSON.stringify(this.state, null, 2)
    const stateBytes = new TextEncoder().encode(stateJson)
    await this.fs.writeFile(joinPath(this.rootPath, STATE_FILE), stateBytes)

    // Save manifest c4m
    if (this.currentManifest) {
      const c4mText = this.currentManifest.encode()
      const c4mBytes = new TextEncoder().encode(c4mText)
      await this.fs.writeFile(joinPath(this.rootPath, MANIFEST_FILE), c4mBytes)
    }
  }
}
