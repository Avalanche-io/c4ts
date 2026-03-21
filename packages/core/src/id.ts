import { encode, decode } from "./base58.js";
import { BadIDLengthError, BadIDCharError } from "./errors.js";

const digestLen = 64;
const prefix = "c4";
const idLen = 90; // "c4" + 88 base58 chars

async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-512", data as unknown as BufferSource);
  return new Uint8Array(buf);
}

export class C4ID {
  readonly digest: Uint8Array;

  constructor(digest: Uint8Array) {
    if (digest.length !== digestLen) {
      throw new Error(`digest must be ${digestLen} bytes, got ${digest.length}`);
    }
    this.digest = digest;
  }

  /** Returns the canonical string: "c4" + 88 base58 chars. */
  toString(): string {
    return prefix + encode(this.digest);
  }

  /** Lowercase hex of the 64-byte digest. */
  hex(): string {
    let s = "";
    for (let i = 0; i < this.digest.length; i++) {
      s += this.digest[i].toString(16).padStart(2, "0");
    }
    return s;
  }

  /** True if every byte of the digest is zero. */
  isNil(): boolean {
    for (let i = 0; i < this.digest.length; i++) {
      if (this.digest[i] !== 0) return false;
    }
    return true;
  }

  /** Byte-wise equality. */
  equals(other: C4ID): boolean {
    return this.compareTo(other) === 0;
  }

  /** -1, 0, or 1 — big-endian byte comparison like Go's bytes.Compare. */
  compareTo(other: C4ID): number {
    for (let i = 0; i < digestLen; i++) {
      if (this.digest[i] < other.digest[i]) return -1;
      if (this.digest[i] > other.digest[i]) return 1;
    }
    return 0;
  }

  /**
   * Order-independent sum of two IDs.
   * Sort by digest (smaller first), then SHA-512(smaller || larger).
   * If both are equal, return self.
   */
  async sum(other: C4ID): Promise<C4ID> {
    const cmp = this.compareTo(other);
    if (cmp === 0) return this;

    const first = cmp < 0 ? this.digest : other.digest;
    const second = cmp < 0 ? other.digest : this.digest;

    const combined = new Uint8Array(digestLen * 2);
    combined.set(first, 0);
    combined.set(second, digestLen);

    const hash = await sha512(combined);
    return new C4ID(hash);
  }

  /** Parse a "c4..." string. Throws on invalid input. */
  static parse(s: string): C4ID {
    return parse(s);
  }

  /** Construct from a 64-byte digest (copies the data). */
  static fromDigest(d: Uint8Array): C4ID {
    const copy = new Uint8Array(digestLen);
    copy.set(d);
    return new C4ID(copy);
  }

  /** The nil ID: all 64 bytes zero. */
  static nil(): C4ID {
    return new C4ID(new Uint8Array(digestLen));
  }
}

/** Identify content from a ReadableStream, ArrayBuffer, or Uint8Array. */
export async function identify(
  source: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array
): Promise<C4ID> {
  if (source instanceof Uint8Array) {
    return identifyBytes(source);
  }
  if (source instanceof ArrayBuffer) {
    return identifyBytes(new Uint8Array(source));
  }
  // ReadableStream: accumulate all chunks, then hash
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  const reader = source.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return identifyBytes(combined);
}

/** Hash a Uint8Array with SHA-512 and return its C4ID. */
export async function identifyBytes(data: Uint8Array): Promise<C4ID> {
  const hash = await sha512(data);
  return new C4ID(hash);
}

/** Parse a "c4..." string synchronously (base58 decode only, no hashing). */
export function parse(s: string): C4ID {
  if (s.length !== idLen) {
    throw new BadIDLengthError(s.length);
  }
  if (s[0] !== "c" || s[1] !== "4") {
    throw new BadIDCharError(0);
  }
  const digest = decode(s.slice(2));
  return new C4ID(digest);
}
