/// pHash comparison. The hash itself is computed in `buddyd` (the sidecar
/// writes the PNG straight to disk, so sending the bytes over stdio just to
/// hash them would cost a whole frame for eight bytes); this side only has to
/// compare.

/** Hamming distance between two 16-hex-char pHashes. 64 — maximally different
 *  — for anything unparseable, so a corrupt hash never reads as a duplicate. */
export function phashDistance(a: string, b: string): number {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let d = 0;
  // BigInt would be tidier; two 32-bit halves avoids allocating one per frame.
  for (const [x, y] of [
    [a.slice(0, 8), b.slice(0, 8)],
    [a.slice(8), b.slice(8)],
  ]) {
    const nx = parseInt(x, 16);
    const ny = parseInt(y, 16);
    if (Number.isNaN(nx) || Number.isNaN(ny)) return 64;
    let v = (nx ^ ny) >>> 0;
    while (v) {
      v &= v - 1;
      d++;
    }
  }
  return d;
}
