// Natural sorting for c4m manifest entries.

interface Segment {
  text: string
  isNumeric: boolean
}

// segmentString splits a string into alternating text/numeric segments.
// A segment is numeric if it consists of ASCII digits 0-9 (0x30-0x39) only.
// Unicode digits are treated as text.
function segmentString(s: string): Segment[] {
  if (s === "") {
    return []
  }

  const segments: Segment[] = []
  let current = ""
  let isNumeric = false
  let first = true

  for (const ch of s) {
    const isDigit = ch >= "0" && ch <= "9"

    if (first) {
      first = false
      isNumeric = isDigit
      current = ch
    } else if (isDigit !== isNumeric) {
      // Transition between text and numeric
      segments.push({ text: current, isNumeric })

      current = ch
      isNumeric = isDigit
    } else {
      current += ch
    }
  }

  // Add final segment
  if (current.length > 0) {
    segments.push({ text: current, isNumeric })
  }

  return segments
}

// compareDigitRuns orders two runs of ASCII digits as integers of any
// length, with no numeric parse (a double keeps 15-16 digits; a 17-digit
// run would lose its last digit and two runs could compare equal):
// leading zeros are dropped, a shorter remainder is the smaller value,
// equal lengths compare digit by digit, and equal values put the shorter
// spelling first ("1" < "01"). Returns -1, 0 or 1.
function compareDigitRuns(a: string, b: string): number {
  const ta = a.replace(/^0+/, "")
  const tb = b.replace(/^0+/, "")
  if (ta.length !== tb.length) {
    return ta.length < tb.length ? -1 : 1
  }
  if (ta !== tb) {
    return ta < tb ? -1 : 1
  }
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1
  }
  return 0
}

// naturalLess compares two strings using natural sorting.
// Natural sorting handles numeric sequences intelligently:
// - "file2.txt" comes before "file10.txt"
// - "render.1.exr" comes before "render.01.exr" (equal value, shorter first)
export function naturalLess(a: string, b: string): boolean {
  const segsA = segmentString(a)
  const segsB = segmentString(b)

  const minLen = Math.min(segsA.length, segsB.length)

  for (let i = 0; i < minLen; i++) {
    const segA = segsA[i]
    const segB = segsB[i]

    if (segA.isNumeric && segB.isNumeric) {
      // Both numeric: compare as integers of any length
      const c = compareDigitRuns(segA.text, segB.text)
      if (c !== 0) {
        return c < 0
      }
    } else if (segA.isNumeric !== segB.isNumeric) {
      // Mixed types: text sorts before numeric
      return !segA.isNumeric
    } else {
      // Both text: UTF-8 codepoint comparison (standard JS string comparison)
      if (segA.text !== segB.text) {
        return segA.text < segB.text
      }
    }
  }

  // All compared segments equal: shorter name (fewer segments) first
  return segsA.length < segsB.length
}
