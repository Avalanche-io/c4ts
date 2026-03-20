import { C4ID } from "./id.js";

/**
 * Compute the tree (Merkle) ID for a set of C4IDs.
 *
 * Algorithm:
 *   1. Sort IDs by digest bytes (big-endian).
 *   2. Deduplicate adjacent equal IDs.
 *   3. Build a Merkle tree bottom-up:
 *      - Pair adjacent IDs and sum each pair (order-independent via C4ID.sum).
 *      - An odd trailing ID promotes unchanged to the next level.
 *      - Repeat until a single root remains.
 *   4. Empty input returns the nil ID.
 *   5. Single element returns itself.
 */
export async function treeId(ids: C4ID[]): Promise<C4ID> {
  if (ids.length === 0) return C4ID.nil();

  // Sort by digest bytes
  const sorted = ids.slice().sort((a, b) => a.compareTo(b));

  // Deduplicate
  const deduped: C4ID[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (!sorted[i].equals(sorted[i - 1])) {
      deduped.push(sorted[i]);
    }
  }

  if (deduped.length === 1) return deduped[0];

  // Build Merkle tree bottom-up
  let level = deduped;
  while (level.length > 1) {
    const next: C4ID[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(await level[i].sum(level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }

  return level[0];
}
