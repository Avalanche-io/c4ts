// Universal Filename Encoding for c4m names.

const CURRENCY_SIGN = "\u00A4" // ¤
const BRAILLE_BASE = 0x2800

// isPrintable returns true if the codepoint is a printable character.
// Matches Go's unicode.IsPrint: graphic characters plus ASCII space.
// Excludes all C0/C1 control characters and other non-graphic codepoints.
function isPrintable(cp: number): boolean {
  // C0 controls (0x00-0x1F) except we never reach here for those handled by tier2
  if (cp <= 0x1f) return false
  // DEL
  if (cp === 0x7f) return false
  // C1 controls (0x80-0x9F)
  if (cp >= 0x80 && cp <= 0x9f) return false
  // Unicode category-based non-printable ranges
  // Surrogates (shouldn't appear as codepoints but guard anyway)
  if (cp >= 0xd800 && cp <= 0xdfff) return false
  // Non-characters
  if (cp >= 0xfdd0 && cp <= 0xfdef) return false
  if ((cp & 0xfffe) === 0xfffe && cp <= 0x10ffff) return false
  return true
}

// tier2Escape returns the escape character for a Tier 2 codepoint, or empty string.
function tier2Escape(cp: number): string {
  switch (cp) {
    case 0x00: return "0"
    case 0x09: return "t"
    case 0x0a: return "n"
    case 0x0d: return "r"
    case 0x5c: return "\\" // backslash
  }
  return ""
}

// tier2Unescape returns the byte value for a Tier 2 escape character.
function tier2Unescape(ch: string): { value: number; ok: boolean } {
  switch (ch) {
    case "0": return { value: 0x00, ok: true }
    case "t": return { value: 0x09, ok: true }
    case "n": return { value: 0x0a, ok: true }
    case "r": return { value: 0x0d, ok: true }
    case "\\": return { value: 0x5c, ok: true }
  }
  return { value: 0, ok: false }
}

// safeName encodes a raw filename using Universal Filename Encoding.
// Three tiers:
//   Tier 1: printable UTF-8 passes through, except ¤ and backslash
//   Tier 2: backslash escapes for \0, \t, \n, \r, \\
//   Tier 3: non-printable bytes encoded as braille between ¤ delimiters
export function safeName(raw: string): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(raw)

  // Fast path: check if encoding is needed.
  let safe = true
  let i = 0
  while (i < bytes.length) {
    const decoded = decodeUtf8(bytes, i)
    if (decoded.error) {
      safe = false
      break
    }
    if (decoded.cp === 0xa4 || decoded.cp === 0x5c || !isPrintable(decoded.cp)) {
      safe = false
      break
    }
    i += decoded.size
  }
  if (safe) {
    return raw
  }

  let result = ""
  let pending: number[] = [] // Tier 3 byte accumulator

  function flushPending() {
    if (pending.length === 0) return
    result += CURRENCY_SIGN
    for (const b of pending) {
      result += String.fromCodePoint(BRAILLE_BASE + b)
    }
    result += CURRENCY_SIGN
    pending = []
  }

  i = 0
  while (i < bytes.length) {
    const decoded = decodeUtf8(bytes, i)

    // Tier 1: printable UTF-8, not ¤, not backslash
    if (!decoded.error && isPrintable(decoded.cp) && decoded.cp !== 0xa4 && decoded.cp !== 0x5c) {
      flushPending()
      result += String.fromCodePoint(decoded.cp)
      i += decoded.size
      continue
    }

    // Tier 2: backslash escapes for specific characters
    if (!decoded.error) {
      const esc = tier2Escape(decoded.cp)
      if (esc !== "") {
        flushPending()
        result += "\\" + esc
        i += decoded.size
        continue
      }
    }

    // Tier 3: accumulate bytes for braille range encoding
    if (decoded.error) {
      pending.push(bytes[i])
      i++
    } else {
      for (let j = 0; j < decoded.size; j++) {
        pending.push(bytes[i + j])
      }
      i += decoded.size
    }
  }
  flushPending()

  return result
}

// unsafeName reverses safeName: decodes Tier 2 backslash escapes and
// Tier 3 braille patterns back to raw bytes.
export function unsafeName(encoded: string): string {
  if (!encoded.includes(CURRENCY_SIGN) && !encoded.includes("\\")) {
    return encoded
  }

  const decoder = new TextDecoder()
  const outputBytes: number[] = []
  const encoder = new TextEncoder()

  const pushStr = (s: string) => {
    const bytes = encoder.encode(s)
    for (let k = 0; k < bytes.length; k++) {
      outputBytes.push(bytes[k])
    }
  }

  let i = 0
  outer: while (i < encoded.length) {
    const cp = encoded.codePointAt(i)!
    const charLen = cp > 0xffff ? 2 : 1

    // Tier 2: backslash escape
    if (cp === 0x5c) { // backslash
      if (i + charLen < encoded.length) {
        const next = encoded[i + charLen]
        const unesc = tier2Unescape(next)
        if (unesc.ok) {
          outputBytes.push(unesc.value)
          i += charLen + 1
          continue
        }
      }
      // Lone backslash or unknown escape: pass through
      outputBytes.push(0x5c)
      i += charLen
      continue
    }

    // Tier 3: ¤...¤ braille range
    // Matches Go behavior: braille-decoded bytes are written inline.
    if (cp === 0xa4) { // ¤
      let j = i + charLen
      let decoded = false
      while (j < encoded.length) {
        const brCp = encoded.codePointAt(j)!
        const brLen = brCp > 0xffff ? 2 : 1
        if (brCp === 0xa4) { // closing ¤
          if (decoded) {
            i = j + brLen
          } else {
            pushStr(CURRENCY_SIGN)
            i += charLen
          }
          continue outer
        }
        if (brCp >= 0x2800 && brCp <= 0x28ff) {
          outputBytes.push(brCp - 0x2800)
          decoded = true
          j += brLen
          continue
        }
        break
      }
      // No closing ¤ found (or non-braille interrupted): emit ¤ as literal.
      // Any braille-decoded bytes already written are kept (matches Go).
      pushStr(CURRENCY_SIGN)
      i += charLen
      continue
    }

    // Tier 1: passthrough
    pushStr(String.fromCodePoint(cp))
    i += charLen
  }

  return decoder.decode(new Uint8Array(outputBytes))
}

// decodeUtf8 decodes a single UTF-8 codepoint from a byte array at offset.
function decodeUtf8(bytes: Uint8Array, offset: number): { cp: number; size: number; error: boolean } {
  if (offset >= bytes.length) {
    return { cp: 0xfffd, size: 1, error: true }
  }

  const b0 = bytes[offset]

  // Single byte (ASCII)
  if (b0 < 0x80) {
    return { cp: b0, size: 1, error: false }
  }

  // Two bytes
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 1 >= bytes.length) return { cp: 0xfffd, size: 1, error: true }
    const b1 = bytes[offset + 1]
    if ((b1 & 0xc0) !== 0x80) return { cp: 0xfffd, size: 1, error: true }
    const cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f)
    if (cp < 0x80) return { cp: 0xfffd, size: 1, error: true } // overlong
    return { cp, size: 2, error: false }
  }

  // Three bytes
  if ((b0 & 0xf0) === 0xe0) {
    if (offset + 2 >= bytes.length) return { cp: 0xfffd, size: 1, error: true }
    const b1 = bytes[offset + 1]
    const b2 = bytes[offset + 2]
    if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return { cp: 0xfffd, size: 1, error: true }
    const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)
    if (cp < 0x800) return { cp: 0xfffd, size: 1, error: true } // overlong
    return { cp, size: 3, error: false }
  }

  // Four bytes
  if ((b0 & 0xf8) === 0xf0) {
    if (offset + 3 >= bytes.length) return { cp: 0xfffd, size: 1, error: true }
    const b1 = bytes[offset + 1]
    const b2 = bytes[offset + 2]
    const b3 = bytes[offset + 3]
    if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) {
      return { cp: 0xfffd, size: 1, error: true }
    }
    const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)
    if (cp < 0x10000 || cp > 0x10ffff) return { cp: 0xfffd, size: 1, error: true }
    return { cp, size: 4, error: false }
  }

  // Invalid leading byte
  return { cp: 0xfffd, size: 1, error: true }
}

// escapeC4MName backslash-escapes c4m field-boundary characters:
// space, double-quote, and (for non-sequence names) brackets.
export function escapeC4MName(s: string, isSequence: boolean): string {
  let needsEscape = false
  for (const ch of s) {
    if (ch === " " || ch === '"') {
      needsEscape = true
      break
    }
    if (!isSequence && (ch === "[" || ch === "]")) {
      needsEscape = true
      break
    }
  }
  if (!needsEscape) {
    return s
  }

  let result = ""
  for (const ch of s) {
    switch (ch) {
      case " ":
        result += "\\ "
        break
      case '"':
        result += '\\"'
        break
      case "[":
        if (!isSequence) {
          result += "\\["
        } else {
          result += ch
        }
        break
      case "]":
        if (!isSequence) {
          result += "\\]"
        } else {
          result += ch
        }
        break
      default:
        result += ch
        break
    }
  }
  return result
}

// unescapeC4MName reverses escapeC4MName: removes backslash escapes
// for spaces, double-quotes, and brackets.
export function unescapeC4MName(s: string): string {
  if (!s.includes("\\")) {
    return s
  }

  let result = ""
  let i = 0
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === " " || next === '"' || next === "[" || next === "]" || next === "\\") {
        result += next
        i += 2
        continue
      }
    }
    result += s[i]
    i++
  }
  return result
}

// formatName applies safeName encoding and then c4m field-boundary escaping.
// For directory names (ending in /): escape the base, keep trailing /.
// For files: escape the full name.
export function formatName(name: string, isSequence: boolean): string {
  const safe = safeName(name)

  if (safe.endsWith("/")) {
    const base = safe.slice(0, -1)
    return escapeC4MName(base, isSequence) + "/"
  }

  return escapeC4MName(safe, isSequence)
}

// formatTarget applies safeName encoding and escapes only spaces and
// double-quotes (no bracket escaping).
export function formatTarget(target: string): string {
  const safe = safeName(target)
  if (!safe.includes(" ") && !safe.includes('"')) {
    return safe
  }

  let result = ""
  for (const ch of safe) {
    switch (ch) {
      case " ":
        result += "\\ "
        break
      case '"':
        result += '\\"'
        break
      default:
        result += ch
        break
    }
  }
  return result
}
