import { describe, it, expect } from 'vitest'
import { decode } from '../src/decoder.js'
import { parse } from '../src/id.js'
import {
  InvalidEntryError,
  BadIDLengthError,
  BadIDCharError,
} from '../src/errors.js'

describe('decoder error paths', () => {
  it('rejects lines containing CR (0x0D)', async () => {
    const text = '-rw-r--r-- 2025-01-01T00:00:00Z 3 file.txt -\r\n'
    await expect(decode(text)).rejects.toThrow(InvalidEntryError)
    await expect(decode(text)).rejects.toThrow(/CR/)
  })

  it('rejects @ directives', async () => {
    const text = '@version 2.0\n'
    await expect(decode(text)).rejects.toThrow(InvalidEntryError)
    await expect(decode(text)).rejects.toThrow(/directives not supported/)
  })

  it('rejects @ directive after entries', async () => {
    const text = '-rw-r--r-- 2025-01-01T00:00:00Z 3 file.txt -\n@meta foo\n'
    await expect(decode(text)).rejects.toThrow(InvalidEntryError)
    await expect(decode(text)).rejects.toThrow(/directives not supported/)
  })
})

describe('id.parse typed errors', () => {
  it('throws BadIDLengthError on too-short input', () => {
    expect(() => parse('c4abc')).toThrow(BadIDLengthError)
  })

  it('throws BadIDLengthError on empty string', () => {
    expect(() => parse('')).toThrow(BadIDLengthError)
  })

  it('throws BadIDLengthError on too-long input', () => {
    const tooLong = 'c4' + '1'.repeat(89)
    expect(() => parse(tooLong)).toThrow(BadIDLengthError)
  })

  it('throws BadIDCharError on wrong prefix', () => {
    const bad = 'x4' + '1'.repeat(88)
    expect(() => parse(bad)).toThrow(BadIDCharError)
  })

  it('throws BadIDCharError on "c5" prefix', () => {
    const bad = 'c5' + '1'.repeat(88)
    expect(() => parse(bad)).toThrow(BadIDCharError)
  })

  it('BadIDLengthError has correct length in message', () => {
    try {
      parse('c4short')
    } catch (e) {
      expect(e).toBeInstanceOf(BadIDLengthError)
      expect((e as BadIDLengthError).message).toContain('7')
    }
  })
})
