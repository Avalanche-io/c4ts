import { C4ID, identifyBytes } from './id.js'
import { Manifest } from './manifest.js'

/**
 * Quick heuristic: does this look like it could be a c4m file?
 *
 * Checks whether the first non-blank line starts with a valid mode
 * prefix: a 10-char Unix permission string (starting with -, d, or l),
 * or a bare "-" followed by a space.
 */
function looksLikeC4m(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue

    // Bare null-mode entry: "- " at start of line
    if (ch === '-' && i + 1 < text.length && text[i + 1] === ' ') return true

    // 10-char mode string starting with -, d, or l
    if (ch === '-' || ch === 'd' || ch === 'l') {
      if (i + 10 < text.length && text[i + 10] === ' ') return true
    }

    // Indented entry (leading spaces then mode)
    return false
  }
  return false
}

/**
 * Try to canonicalize data as a c4m file.
 * Returns the canonical bytes if the data parses as valid c4m,
 * or null if it does not.
 *
 * @deprecated Since 1.0.27 nothing in c4ts identifies, stores, scans,
 * verifies or reconciles a re-rendered form: a file's C4 ID is its bytes.
 * This returns text, not an ID, and is kept for code built against 1.0.26;
 * it is removed in 1.1. For a description's ID use
 * `(await Manifest.parse(text)).computeC4ID()`.
 */
export async function tryCanonicalizeC4m(data: Uint8Array): Promise<Uint8Array | null> {
  // Quick binary check: c4m is text, reject if it contains null bytes
  for (let i = 0; i < Math.min(data.length, 512); i++) {
    if (data[i] === 0) return null
  }

  const text = new TextDecoder().decode(data)
  if (!looksLikeC4m(text)) return null

  try {
    const m = await Manifest.parse(text)
    if (m.entries.length === 0) return null

    const copy = m.copy()
    copy.canonicalize()
    const canonical = copy.canonical()
    return new TextEncoder().encode(canonical)
  } catch {
    return null
  }
}

/**
 * The C4 ID of exactly these bytes.
 *
 * Through 1.0.26 this re-rendered anything that parsed as c4m to its
 * one-level canonical listing first, so the ID named other bytes (the
 * listing's, which is the description ID only for a flat tree). A file's
 * C4 ID summons exactly that file, and c4m text is no exception.
 *
 * @deprecated Use `identifyBytes`, which this now is; removed in 1.1. For
 * the ID of the description a c4m text holds use
 * `(await Manifest.parse(text)).computeC4ID()`.
 */
export async function identifyContent(data: Uint8Array): Promise<C4ID> {
  return identifyBytes(data)
}
