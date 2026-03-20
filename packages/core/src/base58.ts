const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base = 58n;

// Reverse lookup: character -> index (0xFF = invalid)
const lut = new Uint8Array(256).fill(0xff);
for (let i = 0; i < alphabet.length; i++) {
  lut[alphabet.charCodeAt(i)] = i;
}

/** Encode a 64-byte digest as an 88-character base58 string. */
export function encode(digest: Uint8Array): string {
  let num = 0n;
  for (let i = 0; i < digest.length; i++) {
    num = (num << 8n) | BigInt(digest[i]);
  }

  const chars = new Array<string>(88).fill(alphabet[0]);
  for (let i = 87; i >= 0 && num > 0n; i--) {
    const rem = num % base;
    num = num / base;
    chars[i] = alphabet[Number(rem)];
  }

  return chars.join("");
}

/** Decode an 88-character base58 string to a 64-byte digest. */
export function decode(s: string): Uint8Array {
  if (s.length !== 88) {
    throw new Error(
      `c4 base58 body must be 88 characters, got ${s.length}`
    );
  }

  let num = 0n;
  for (let i = 0; i < s.length; i++) {
    const v = lut[s.charCodeAt(i)];
    if (v === 0xff) {
      throw new Error(`non c4 id character at position ${i}`);
    }
    num = num * base + BigInt(v);
  }

  const out = new Uint8Array(64);
  for (let i = 63; i >= 0 && num > 0n; i--) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  return out;
}
