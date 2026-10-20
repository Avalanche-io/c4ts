import { describe, it, expect } from 'vitest'
import { naturalLess } from '../src/index.js'

describe('naturalLess', () => {
  describe('numeric segment sorting', () => {
    it('file1 < file2 < file10', () => {
      expect(naturalLess('file1', 'file2')).toBe(true)
      expect(naturalLess('file2', 'file10')).toBe(true)
      expect(naturalLess('file10', 'file1')).toBe(false)
    })

    it('sorts multi-digit numbers correctly', () => {
      expect(naturalLess('item3', 'item20')).toBe(true)
      expect(naturalLess('item20', 'item100')).toBe(true)
      expect(naturalLess('item100', 'item3')).toBe(false)
    })

    it('render.1.exr < render.01.exr (equal value, shorter first)', () => {
      expect(naturalLess('render.1.exr', 'render.01.exr')).toBe(true)
      expect(naturalLess('render.01.exr', 'render.1.exr')).toBe(false)
    })

    it('001 < 01 (shorter representation of equal value comes first)', () => {
      // 1 (length 1) vs 01 (length 2) vs 001 (length 3) — all equal value 1
      expect(naturalLess('a1b', 'a01b')).toBe(true)
      expect(naturalLess('a01b', 'a001b')).toBe(true)
      expect(naturalLess('a001b', 'a1b')).toBe(false)
    })
  })

  describe('text before numeric when mixed', () => {
    it('text segment sorts before numeric segment', () => {
      // When one segment is text and the other is numeric at the same
      // position, text sorts before numeric.
      expect(naturalLess('abc', '123')).toBe(true)
      expect(naturalLess('123', 'abc')).toBe(false)
    })

    it('leading letter vs leading digit', () => {
      expect(naturalLess('a1', '1a')).toBe(true)
      expect(naturalLess('1a', 'a1')).toBe(false)
    })
  })

  describe('unicode handling', () => {
    it('sorts unicode text by codepoint comparison', () => {
      // Standard JS string comparison for text segments
      expect(naturalLess('alpha', 'beta')).toBe(true)
      expect(naturalLess('beta', 'alpha')).toBe(false)
    })

    it('handles unicode characters beyond ASCII', () => {
      // Unicode digits (e.g. Arabic-Indic) are treated as text, not numeric
      expect(naturalLess('\u0660', 'a')).toBe(false) // U+0660 > 'a'
      expect(naturalLess('a', '\u0660')).toBe(true)
    })

    it('handles emoji as text', () => {
      // Emoji are text segments
      const result1 = naturalLess('file\u{1F600}', 'file\u{1F601}')
      const result2 = naturalLess('file\u{1F601}', 'file\u{1F600}')
      // One must be true and the other false (they are not equal)
      expect(result1).not.toBe(result2)
    })
  })

  describe('empty strings', () => {
    it('empty string is less than any non-empty string', () => {
      expect(naturalLess('', 'a')).toBe(true)
      expect(naturalLess('', '1')).toBe(true)
    })

    it('non-empty string is not less than empty string', () => {
      expect(naturalLess('a', '')).toBe(false)
      expect(naturalLess('1', '')).toBe(false)
    })

    it('empty vs empty returns false (not strictly less)', () => {
      expect(naturalLess('', '')).toBe(false)
    })
  })

  describe('equal strings', () => {
    it('equal strings return false', () => {
      expect(naturalLess('abc', 'abc')).toBe(false)
      expect(naturalLess('file10', 'file10')).toBe(false)
      expect(naturalLess('123', '123')).toBe(false)
    })
  })

  describe('prefix ordering', () => {
    it('shorter string is less when it is a prefix', () => {
      expect(naturalLess('file', 'file1')).toBe(true)
      expect(naturalLess('file1', 'file')).toBe(false)
    })

    it('common prefix with different suffixes', () => {
      expect(naturalLess('abc1', 'abc2')).toBe(true)
      expect(naturalLess('abc2', 'abc1')).toBe(false)
    })
  })

  describe('real-world filenames', () => {
    it('sorts VFX frame sequences naturally', () => {
      const frames = ['render.10.exr', 'render.2.exr', 'render.1.exr', 'render.100.exr']
      frames.sort((a, b) => naturalLess(a, b) ? -1 : naturalLess(b, a) ? 1 : 0)
      expect(frames).toEqual([
        'render.1.exr',
        'render.2.exr',
        'render.10.exr',
        'render.100.exr',
      ])
    })

    it('sorts version numbers naturally', () => {
      const versions = ['v2.10.1', 'v2.2.1', 'v2.1.0', 'v10.0.0']
      versions.sort((a, b) => naturalLess(a, b) ? -1 : naturalLess(b, a) ? 1 : 0)
      expect(versions).toEqual(['v2.1.0', 'v2.2.1', 'v2.10.1', 'v10.0.0'])
    })
  })
})

// The conformance vectors shared with c4 (Go) and c4py: digit runs of 17,
// 20, 21 and 39 digits. A double keeps 15-16 digits, so parsing runs into
// numbers made two different 17-digit runs compare equal and the sorted
// order depend on the input order (one tree, more than one ID).
import { readFileSync } from 'node:fs'

describe('natural sort conformance vectors', () => {
  const vectors = JSON.parse(
    readFileSync(new URL('./vectors/natural_sort_vectors.json', import.meta.url), 'utf8'),
  ).sorted as string[]

  it('orders every pair as the vectors say', () => {
    for (let i = 0; i < vectors.length; i++) {
      expect(naturalLess(vectors[i], vectors[i])).toBe(false)
      for (let j = i + 1; j < vectors.length; j++) {
        expect(naturalLess(vectors[i], vectors[j]), `${vectors[i]} < ${vectors[j]}`).toBe(true)
        expect(naturalLess(vectors[j], vectors[i]), `!(${vectors[j]} < ${vectors[i]})`).toBe(false)
      }
    }
  })

  it('sorts every permutation to the same order', () => {
    let seed = 1
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 200; round++) {
      const names = [...vectors]
      for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[names[i], names[j]] = [names[j], names[i]]
      }
      names.sort((a, b) => (naturalLess(a, b) ? -1 : naturalLess(b, a) ? 1 : 0))
      expect(names).toEqual(vectors)
    }
  })
})
