import { describe, it, expect } from 'vitest'
import {
  safeName,
  unsafeName,
  escapeC4MName,
  unescapeC4MName,
  formatName,
  formatTarget,
} from '../src/index.js'

describe('safeName', () => {
  describe('passthrough for safe names', () => {
    it('passes through plain ASCII names', () => {
      expect(safeName('hello.txt')).toBe('hello.txt')
    })

    it('passes through names with unicode letters', () => {
      expect(safeName('\u00e9l\u00e8ve')).toBe('\u00e9l\u00e8ve') // eleve with accents
    })

    it('passes through names with spaces', () => {
      // Spaces are printable, not backslash/currency-sign
      expect(safeName('my file.txt')).toBe('my file.txt')
    })

    it('passes through digits and punctuation', () => {
      expect(safeName('file-2024_v3.tar.gz')).toBe('file-2024_v3.tar.gz')
    })
  })

  describe('tier 2: backslash escapes', () => {
    it('encodes tab as \\t', () => {
      expect(safeName('a\tb')).toBe('a\\tb')
    })

    it('encodes newline as \\n', () => {
      expect(safeName('a\nb')).toBe('a\\nb')
    })

    it('encodes carriage return as \\r', () => {
      expect(safeName('a\rb')).toBe('a\\rb')
    })

    it('encodes backslash as \\\\', () => {
      expect(safeName('a\\b')).toBe('a\\\\b')
    })

    it('encodes null as \\0', () => {
      expect(safeName('a\0b')).toBe('a\\0b')
    })
  })

  describe('tier 3: braille encoding for non-printable bytes', () => {
    it('encodes DEL (0x7F) as braille', () => {
      // DEL = 0x7F, not printable
      // In UTF-8 it is a single byte: 0x7F
      // Braille: U+2800 + 0x7F = U+287F, wrapped in currency signs
      const input = String.fromCodePoint(0x7f)
      const result = safeName(input)
      expect(result).toBe('\u00a4\u287f\u00a4')
    })

    it('encodes C1 control characters as braille', () => {
      // 0x80 is a C1 control in Unicode but in UTF-8 it encodes as 0xC2 0x80
      // The safeName function works on the UTF-8 bytes
      const input = String.fromCodePoint(0x80)
      const result = safeName(input)
      expect(result).toContain('\u00a4') // contains currency sign delimiters
    })
  })

  describe('currency sign encoding', () => {
    it('encodes literal currency sign in braille', () => {
      // The currency sign U+00A4 itself needs encoding
      const input = '\u00a4'
      const result = safeName(input)
      expect(result).not.toBe('\u00a4') // should not pass through
      expect(result).toContain('\u00a4') // contains braille delimiters with ¤
    })
  })
})

describe('unsafeName', () => {
  describe('passthrough', () => {
    it('passes through plain strings without escapes', () => {
      expect(unsafeName('hello.txt')).toBe('hello.txt')
    })
  })

  describe('tier 2 reversal', () => {
    it('decodes \\t back to tab', () => {
      expect(unsafeName('a\\tb')).toBe('a\tb')
    })

    it('decodes \\n back to newline', () => {
      expect(unsafeName('a\\nb')).toBe('a\nb')
    })

    it('decodes \\r back to carriage return', () => {
      expect(unsafeName('a\\rb')).toBe('a\rb')
    })

    it('decodes \\\\ back to backslash', () => {
      expect(unsafeName('a\\\\b')).toBe('a\\b')
    })

    it('decodes \\0 back to null byte', () => {
      expect(unsafeName('a\\0b')).toBe('a\0b')
    })
  })
})

describe('round-trip: unsafeName(safeName(s)) === s', () => {
  const cases = [
    'hello.txt',
    'a\tb',
    'a\nb',
    'a\rb',
    'a\\b',
    'a\0b',
    '\u00a4file\u00a4',  // currency signs
    'normal name',
    '',
    String.fromCodePoint(0x7f),  // DEL
  ]

  for (const input of cases) {
    it(`round-trips: ${JSON.stringify(input)}`, () => {
      const encoded = safeName(input)
      const decoded = unsafeName(encoded)
      expect(decoded).toBe(input)
    })
  }
})

describe('escapeC4MName', () => {
  it('passes through names without special chars', () => {
    expect(escapeC4MName('hello.txt', false)).toBe('hello.txt')
  })

  it('escapes spaces', () => {
    expect(escapeC4MName('my file.txt', false)).toBe('my\\ file.txt')
  })

  it('escapes double quotes', () => {
    expect(escapeC4MName('file"name', false)).toBe('file\\"name')
  })

  it('escapes brackets for non-sequence names', () => {
    expect(escapeC4MName('file[1].txt', false)).toBe('file\\[1\\].txt')
  })

  it('does not escape brackets for sequence names', () => {
    expect(escapeC4MName('render.[1-100].exr', true)).toBe('render.[1-100].exr')
  })

  it('escapes spaces and quotes together', () => {
    expect(escapeC4MName('my "file"', false)).toBe('my\\ \\"file\\"')
  })
})

describe('unescapeC4MName', () => {
  it('passes through names without backslashes', () => {
    expect(unescapeC4MName('hello.txt')).toBe('hello.txt')
  })

  it('unescapes spaces', () => {
    expect(unescapeC4MName('my\\ file.txt')).toBe('my file.txt')
  })

  it('unescapes double quotes', () => {
    expect(unescapeC4MName('file\\"name')).toBe('file"name')
  })

  it('unescapes brackets', () => {
    expect(unescapeC4MName('file\\[1\\].txt')).toBe('file[1].txt')
  })

  it('round-trips with escapeC4MName', () => {
    const input = 'my "file" [1].txt'
    expect(unescapeC4MName(escapeC4MName(input, false))).toBe(input)
  })
})

describe('formatName', () => {
  it('formats a simple filename', () => {
    expect(formatName('hello.txt', false)).toBe('hello.txt')
  })

  it('formats a directory name (trailing /)', () => {
    expect(formatName('mydir/', false)).toBe('mydir/')
  })

  it('escapes spaces in directory base name', () => {
    expect(formatName('my dir/', false)).toBe('my\\ dir/')
  })

  it('escapes special chars in filenames', () => {
    expect(formatName('file name.txt', false)).toBe('file\\ name.txt')
  })

  it('applies safeName encoding before c4m escaping', () => {
    // Tab in name -> safeName encodes it to \t, then escapeC4MName passes through
    expect(formatName('a\tb', false)).toBe('a\\tb')
  })
})

describe('formatTarget', () => {
  it('formats a simple target', () => {
    expect(formatTarget('/usr/local/bin')).toBe('/usr/local/bin')
  })

  it('escapes spaces in target', () => {
    expect(formatTarget('path with spaces')).toBe('path\\ with\\ spaces')
  })

  it('escapes double quotes in target', () => {
    expect(formatTarget('path"quote')).toBe('path\\"quote')
  })

  it('does not escape brackets in target', () => {
    // formatTarget only escapes spaces and quotes, not brackets
    expect(formatTarget('path[0]')).toBe('path[0]')
  })
})
