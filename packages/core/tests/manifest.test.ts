import { describe, it, expect } from 'vitest'
import {
  Manifest,
  createEntry,
  isDir,
  parse as parseC4ID,
  type Entry,
} from '../src/index.js'
import knownIDs from './vectors/known_ids.json'

const vector = knownIDs.manifest_vectors[0]

describe('Manifest.parse', () => {
  it('parses the canonical vector text', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(m.entries.length).toBe(3)
  })

  it('has the correct entry names', async () => {
    const m = await Manifest.parse(vector.canonical)
    const names = m.entries.map(e => e.name)
    expect(names).toEqual(['README.md', 'src/', 'main.go'])
  })

  it('has correct mode for README.md', async () => {
    const m = await Manifest.parse(vector.canonical)
    const readme = m.entries[0]
    // -rw-r--r-- = 0o644
    expect(readme.mode).toBe(0o644)
    expect(readme.modeType).toBe('-')
  })

  it('has correct mode for src/', async () => {
    const m = await Manifest.parse(vector.canonical)
    const src = m.entries[1]
    // -rwxr-xr-x = 0o755
    expect(src.mode).toBe(0o755)
    expect(src.modeType).toBe('-')
  })

  it('has correct size for all entries', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(m.entries[0].size).toBe(3)
    expect(m.entries[1].size).toBe(3)
    expect(m.entries[2].size).toBe(3)
  })

  it('has correct depth values', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(m.entries[0].depth).toBe(0) // README.md
    expect(m.entries[1].depth).toBe(0) // src/
    expect(m.entries[2].depth).toBe(1) // main.go (child of src/)
  })

  it('has correct c4id strings', async () => {
    const m = await Manifest.parse(vector.canonical)
    const fooID = knownIDs.single_ids.find(v => v.input_repr === 'foo')!.c4id
    const barID = knownIDs.single_ids.find(v => v.input_repr === 'bar')!.c4id

    expect(m.entries[0].c4id!.toString()).toBe(fooID) // README.md -> foo
    expect(m.entries[1].c4id).toBeNull() // src/ -> null (-)
    expect(m.entries[2].c4id!.toString()).toBe(barID) // main.go -> bar
  })
})

describe('Manifest.computeC4ID', () => {
  it('matches the expected manifest c4id from known_ids.json', async () => {
    const m = await Manifest.parse(vector.canonical)
    const id = await m.computeC4ID()
    expect(id.toString()).toBe(vector.manifest_c4id)
  })
})

describe('Manifest.sortEntries', () => {
  it('sorts files before directories at the same depth', async () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'zdir/', modeType: 'd', depth: 0 }))
    m.addEntry(createEntry({ name: 'afile.txt', depth: 0 }))
    m.addEntry(createEntry({ name: 'bfile.txt', depth: 0 }))
    m.sortEntries()

    const names = m.entries.map(e => e.name)
    expect(names).toEqual(['afile.txt', 'bfile.txt', 'zdir/'])
  })

  it('sorts naturally within file groups', async () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'file10.txt', depth: 0 }))
    m.addEntry(createEntry({ name: 'file2.txt', depth: 0 }))
    m.addEntry(createEntry({ name: 'file1.txt', depth: 0 }))
    m.sortEntries()

    const names = m.entries.map(e => e.name)
    expect(names).toEqual(['file1.txt', 'file2.txt', 'file10.txt'])
  })

  it('places directory children after their parent', async () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'src/', modeType: 'd', depth: 0 }))
    m.addEntry(createEntry({ name: 'main.go', depth: 1 }))
    m.addEntry(createEntry({ name: 'README.md', depth: 0 }))
    m.sortEntries()

    const names = m.entries.map(e => e.name)
    expect(names).toEqual(['README.md', 'src/', 'main.go'])
  })
})

describe('Manifest.get / has', () => {
  it('looks up entries by full path', async () => {
    const m = await Manifest.parse(vector.canonical)
    const readme = m.get('README.md')
    expect(readme).toBeDefined()
    expect(readme!.name).toBe('README.md')
  })

  it('looks up nested entries by full path', async () => {
    const m = await Manifest.parse(vector.canonical)
    const mainGo = m.get('src/main.go')
    expect(mainGo).toBeDefined()
    expect(mainGo!.name).toBe('main.go')
  })

  it('returns undefined for missing paths', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(m.get('nonexistent.txt')).toBeUndefined()
  })

  it('has returns true for existing paths', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(m.has('README.md')).toBe(true)
    expect(m.has('src/')).toBe(true)
    expect(m.has('src/main.go')).toBe(true)
  })

  it('has returns false for missing paths', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(m.has('missing.txt')).toBe(false)
  })
})

describe('Manifest.copy', () => {
  it('produces a deep copy', async () => {
    const m = await Manifest.parse(vector.canonical)
    const cp = m.copy()

    expect(cp.entries.length).toBe(m.entries.length)
    expect(cp.version).toBe(m.version)

    // Entries are distinct objects
    for (let i = 0; i < m.entries.length; i++) {
      expect(cp.entries[i]).not.toBe(m.entries[i])
      expect(cp.entries[i].name).toBe(m.entries[i].name)
    }
  })

  it('mutations to copy do not affect original', async () => {
    const m = await Manifest.parse(vector.canonical)
    const cp = m.copy()
    cp.entries[0].name = 'modified.txt'
    expect(m.entries[0].name).toBe('README.md')
  })
})

describe('Manifest.validate', () => {
  it('succeeds on a valid manifest', async () => {
    const m = await Manifest.parse(vector.canonical)
    expect(() => m.validate()).not.toThrow()
  })

  it('throws on empty name', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: '' }))
    expect(() => m.validate()).toThrow(/invalid entry/)
  })

  it('throws on path traversal (..)', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: '..' }))
    expect(() => m.validate()).toThrow(/path traversal/)
  })

  it('throws on path traversal (.)', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: '.' }))
    expect(() => m.validate()).toThrow(/path traversal/)
  })

  it('throws on name containing slash', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'a/b' }))
    expect(() => m.validate()).toThrow(/path traversal/)
  })

  it('throws on duplicate paths', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'file.txt', depth: 0 }))
    m.addEntry(createEntry({ name: 'file.txt', depth: 0 }))
    expect(() => m.validate()).toThrow(/duplicate path/)
  })
})

describe('Manifest.filter', () => {
  it('filters by predicate', async () => {
    const m = await Manifest.parse(vector.canonical)
    const filesOnly = m.filter((_path, entry) => !isDir(entry))
    expect(filesOnly.entries.length).toBe(2)
    for (const e of filesOnly.entries) {
      expect(isDir(e)).toBe(false)
    }
  })

  it('filters by path pattern', async () => {
    const m = await Manifest.parse(vector.canonical)
    const goFiles = m.filter((path) => path.endsWith('.go'))
    expect(goFiles.entries.length).toBe(1)
    expect(goFiles.entries[0].name).toBe('main.go')
  })
})

describe('Manifest.files', () => {
  it('iterates only file entries with full paths', async () => {
    const m = await Manifest.parse(vector.canonical)
    const files = [...m.files()]
    expect(files.length).toBe(2)
    const paths = files.map(([p]) => p)
    expect(paths).toContain('README.md')
    expect(paths).toContain('src/main.go')
  })
})

describe('Manifest.directories', () => {
  it('iterates only directory entries with full paths', async () => {
    const m = await Manifest.parse(vector.canonical)
    const dirs = [...m.directories()]
    expect(dirs.length).toBe(1)
    expect(dirs[0][0]).toBe('src/')
  })
})

describe('Manifest.summary', () => {
  it('reports correct counts and size', async () => {
    const m = await Manifest.parse(vector.canonical)
    const s = m.summary()
    expect(s).toContain('2 files')
    expect(s).toContain('1 dirs')
  })

  it('reports unknown size when entries have null sizes', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'a.txt', size: -1 }))
    const s = m.summary()
    expect(s).toContain('unknown')
  })
})
