import { readFile, writeFile, mkdir, rm, stat, readdir, rename as fsRename } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { type C4ID, identifyBytes, parse as parseC4ID } from '../../core/src/id.js'
import { bytesToStream, streamToBytes } from '../../core/src/filesystem.js'
import type { Store } from '../../core/src/store.js'
import { ContentNotFoundError } from '../../core/src/store.js'

/** The leaf size Go's TreeStore splits at (store.DefaultSplitThreshold). */
export const DEFAULT_SPLIT_THRESHOLD = 4096

/**
 * Filesystem content store in Go's store.TreeStore layout (c4 store/
 * treestore.go, as landed in c4 f2b05d3), which c4py's FSStore shares.
 *
 * An object's file is named by its full 90-character C4 ID. A store starts
 * flat (`<root>/<ID>`); a leaf directory holding more than the threshold
 * splits, moving its objects one level down into two-character
 * directories named by the ID's next segment: `<root>/c4/<ID>`, then
 * `<root>/c4/XX/<ID>`. Only files whose names are C4 IDs move; anything
 * else in a leaf stays where it is.
 *
 * Through 1.0.27 c4ts wrote `<root>/c4/<the ID's last 88 characters>` and
 * looked nowhere else, so c4ts and the c4 CLI never saw each other's
 * content in a shared store, and a Go split moved c4ts's files where c4ts
 * did not look. Those stores stay readable: a lookup that finds nothing in
 * Go's layout reads `c4/<88>` and `c4/<88[0:2]>/<88>` where they lie, and
 * never moves, renames or deletes them. New objects go to Go's layout.
 */
export class TreeStore implements Store {
  readonly path: string
  splitThreshold = DEFAULT_SPLIT_THRESHOLD
  /** Test seams: every lookup stat, object read and publishing rename. */
  stat: (p: string) => Promise<Stats> = p => stat(p)
  read: (p: string) => Promise<Uint8Array> = async p => new Uint8Array(await readFile(p))
  rename: (from: string, to: string) => Promise<void> = (from, to) => fsRename(from, to)
  private counts = new Map<string, number>()
  private lock: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  /**
   * True when a copy exists. A lookup that meets an error other than
   * not-found cannot say, and has says no, as Go's Has; get, put and
   * remove raise that error instead.
   */
  async has(id: C4ID): Promise<boolean> {
    try {
      await this.locate(id)
      return true
    } catch {
      return false
    }
  }

  /**
   * The object's bytes. ContentNotFoundError when no level holds a copy;
   * any other error a lookup or read met, since whether the object exists
   * is then unknown (Go's TreeStore.Open).
   */
  async get(id: C4ID): Promise<ReadableStream<Uint8Array>> {
    return bytesToStream(await this.getBytes(id))
  }

  private async getBytes(id: C4ID): Promise<Uint8Array> {
    let first: unknown
    try {
      return await this.read(await this.goPath(id))
    } catch (err) {
      first = err
    }
    // Not at its place, or its place could not be read: search every
    // level. Another process's split can move the file down between
    // finding it and reading it, so search again. The bound is the ID's
    // length in passes, as Go's openFollows: a file only moves deeper, so
    // a file that is only being moved is followed well within it. On
    // Windows a read can meet the split's rename itself (a sharing
    // violation, EBUSY): wait and search again, within the same bound,
    // and if it is still held at the end, raise that, never not-found.
    let held: unknown
    for (let i = 0; i < id.toString().length; i++) {
      let p: string
      try {
        p = await this.locate(id)
      } catch (err) {
        if (!notFound(err)) throw err
        if (notFound(first) || moving(first)) throw new ContentNotFoundError(id)
        throw first
      }
      try {
        return await this.read(p)
      } catch (err) {
        if (moving(err)) {
          held = err
          await new Promise(r => setTimeout(r, 1))
          continue
        }
        if (!notFound(err)) throw err
        held = undefined
      }
    }
    if (held !== undefined) throw held
    throw new ContentNotFoundError(id)
  }

  /**
   * Store the bytes given, exactly, under their own C4 ID, so get(put(x))
   * is x. c4m text is no exception. An object already in Go's layout is
   * not published again; one held only at a legacy c4ts place is
   * published in Go's layout too, so the c4 CLI sees it, and the legacy
   * file is left where it is.
   */
  async put(data: ReadableStream<Uint8Array> | Uint8Array): Promise<C4ID> {
    const bytes = data instanceof Uint8Array ? data : await streamToBytes(data)
    const id = await identifyBytes(bytes)
    await mkdir(this.path, { recursive: true })
    const tmpPath = join(this.path, `.ingest.${randomBytes(8).toString('hex')}`)
    await writeFile(tmpPath, bytes)
    try {
      await this.locked(async () => {
        // Present in Go's layout: skip the rename, so an object never gets
        // a second copy deeper down. A lookup that cannot say raises.
        try {
          await this.goLocate(id)
          return
        } catch (err) {
          if (!notFound(err)) throw err
        }
        const p = await this.goPath(id)
        const dir = p.slice(0, p.length - id.toString().length - 1)
        await mkdir(dir, { recursive: true })
        if (await this.publish(tmpPath, p, id)) await this.noteAdd(dir)
      })
    } finally {
      await rm(tmpPath, { force: true })
    }
    return id
  }

  /**
   * Delete every copy of the object in Go's layout, as Go's Remove. A
   * legacy c4ts copy (`c4/<88>`) is read-only and stays, so has may still
   * report the object after a remove in such a store.
   */
  async remove(id: C4ID): Promise<void> {
    let removed = false
    let first: unknown
    try {
      await rm(await this.goPath(id))
      removed = true
    } catch (err) {
      if (!notFound(err)) throw err
      first = err
    }
    for (let i = 0; i < id.toString().length; i++) {
      let p: string
      try {
        p = await this.foldFind(id)
      } catch (err) {
        if (notFound(err)) break
        throw err
      }
      try {
        await rm(p)
        removed = true
      } catch (err) {
        if (!notFound(err)) throw err
      }
    }
    if (!removed && first !== undefined && !notFound(first)) throw first
  }

  /**
   * The path of id's object file: Go's layout first (Go's locate), then
   * the legacy c4ts places. Rejects with a not-found error (code ENOENT)
   * when no place holds a copy, and with any other error a stat met when
   * none was found: whether the object exists is then unknown.
   */
  private async locate(id: C4ID): Promise<string> {
    let goErr: unknown
    try {
      return await this.goLocate(id)
    } catch (err) {
      goErr = err
    }
    const rest = id.toString().slice(2)
    for (const p of [join(this.path, 'c4', rest), join(this.path, 'c4', rest.slice(0, 2), rest)]) {
      try {
        await this.stat(p)
        return p
      } catch (err) {
        if (!notFound(err) && notFound(goErr)) goErr = err
      }
    }
    throw goErr
  }

  /** Go's locate: the exact trie path with one stat, then foldFind. */
  private async goLocate(id: C4ID): Promise<string> {
    const p = await this.goPath(id)
    let exact: unknown
    try {
      await this.stat(p)
      return p
    } catch (err) {
      exact = err
    }
    try {
      return await this.foldFind(id)
    } catch (err) {
      if (!notFound(err)) throw err
    }
    if (!notFound(exact)) throw exact
    throw noCopy(this.path, id)
  }

  /**
   * Go's path: follow two-character directories down the trie, the ID's
   * segments in order, to the deepest that exists; the object is there,
   * under its full ID.
   */
  private async goPath(id: C4ID): Promise<string> {
    const s = id.toString()
    let dir = this.path
    for (let i = 0; i + 2 <= s.length; i += 2) {
      const sub = join(dir, s.slice(i, i + 2))
      try {
        if (!(await this.stat(sub)).isDirectory()) break
      } catch {
        break
      }
      dir = sub
    }
    return join(dir, s)
  }

  /**
   * Go's foldFind: search from the root down, looking for the file at
   * every level before descending, through shard directories named by the
   * ID's segments exactly or under ASCII case folding. A split moves a
   * leaf's files one level down one rename at a time, and another process
   * may be splitting now; a file only ever moves deeper and shard
   * directories are never removed, so looking top down finds every file
   * that exists, with no lock across processes.
   */
  private async foldFind(id: C4ID): Promise<string> {
    const { path, err } = await this.foldSearch(this.path, id.toString(), 0)
    if (path !== undefined) return path
    if (err !== undefined) throw err
    throw noCopy(this.path, id)
  }

  private async foldSearch(dir: string, s: string, i: number): Promise<{ path?: string; err?: unknown }> {
    let first: unknown
    const note = (err: unknown) => {
      if (first === undefined && !notFound(err)) first = err
    }
    const here = join(dir, s)
    try {
      await this.stat(here)
      return { path: here }
    } catch (err) {
      note(err)
    }
    if (i + 2 > s.length) return { err: first }
    const seen: Stats[] = []
    for (const seg of foldVariants(s.slice(i, i + 2))) {
      const sub = join(dir, seg)
      let info: Stats
      try {
        info = await this.stat(sub)
      } catch (err) {
        note(err)
        continue
      }
      if (!info.isDirectory() || seen.some(o => o.dev === info.dev && o.ino === info.ino)) continue
      seen.push(info)
      const r = await this.foldSearch(sub, s, i + 2)
      if (r.path !== undefined) return r
      note(r.err)
    }
    return { err: first }
  }

  /**
   * Go's publish: rename the complete temp file to the object's name, and
   * report whether this rename published it. The same name means the same
   * bytes, so a rename that fails while the object is now present lost a
   * race to another writer of the same bytes and is not a failure (on
   * Windows a rename onto a name another writer holds is refused).
   */
  private async publish(tmpPath: string, p: string, id: C4ID): Promise<boolean> {
    try {
      await this.rename(tmpPath, p)
      return true
    } catch (err) {
      try {
        await this.goLocate(id)
        return false
      } catch {
        throw err
      }
    }
  }

  /** Go's noteAdd: count one new file in a leaf; split it past the threshold. */
  private async noteAdd(dir: string): Promise<void> {
    let n = this.counts.get(dir)
    n = n === undefined ? await countFiles(dir) : n + 1
    this.counts.set(dir, n)
    if (n <= this.splitThreshold) return
    await this.split(dir)
    this.counts.delete(dir)
  }

  /**
   * Go's split: move the leaf's objects, the files whose names are C4 IDs,
   * one level down by the ID's next segment. Anything else stays, Go's
   * journal and config and a legacy c4ts `c4/<88>` file included.
   */
  private async split(dir: string): Promise<void> {
    let names: string[]
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter(e => !e.isDirectory()).map(e => e.name)
    } catch {
      return
    }
    const rel = relative(this.path, dir)
    const depth = rel === '' ? 0 : rel.split(sep).length * 2
    for (const name of names) {
      if (isTemp(name) || !isID(name) || name.length <= depth + 2) continue
      const sub = join(dir, name.slice(depth, depth + 2))
      await mkdir(sub, { recursive: true })
      await fsRename(join(dir, name), join(sub, name)).catch(() => {})
    }
  }

  /** Run fn with this store's publish lock held (Go's s.mu). */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock
    let release!: () => void
    this.lock = new Promise(r => { release = r })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Every ASCII case variant of seg, seg itself first (Go's foldVariants). */
export function foldVariants(seg: string): string[] {
  let out = [seg]
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (!/[A-Za-z]/.test(c)) continue
    out = out.concat(out.map(v => v.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + v.slice(i + 1)))
  }
  return out
}

function notFound(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ENOENT'
}

/** A read that met another process's rename holding the file: Windows only. */
function moving(err: unknown): boolean {
  return process.platform === 'win32' && (err as { code?: string } | undefined)?.code === 'EBUSY'
}

function noCopy(root: string, id: C4ID): Error {
  return Object.assign(new Error(`no copy of ${id} at any level of ${root}`), { code: 'ENOENT' })
}

function isTemp(name: string): boolean {
  return name.startsWith('.')
}

function isID(name: string): boolean {
  try {
    parseC4ID(name)
    return true
  } catch {
    return false
  }
}

/** Go's countFiles: the non-temp files in dir. */
async function countFiles(dir: string): Promise<number> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(e => !e.isDirectory() && !isTemp(e.name)).length
  } catch {
    return 0
  }
}

/** Open the default content store (C4_STORE env or ~/.c4/store). */
export async function openStore(path?: string): Promise<TreeStore> {
  if (path) return new TreeStore(path)
  const envStore = process.env.C4_STORE
  if (envStore) return new TreeStore(envStore)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const defaultPath = join(home, '.c4', 'store')
  await mkdir(defaultPath, { recursive: true })
  return new TreeStore(defaultPath)
}
