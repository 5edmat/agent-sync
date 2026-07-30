/**
 * BLAKE2b (RFC 7693) with a selectable digest length.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Node's `crypto` exposes BLAKE2b only as `blake2b512` — a fixed 64-byte
 * digest. Argon2id needs BLAKE2b at *other* lengths (32 bytes for the tag,
 * chained 64-byte blocks for the 1024-byte H'), and BLAKE2b mixes the digest
 * length into its parameter block: truncating BLAKE2b-512 to 32 bytes is a
 * different value from BLAKE2b-256. So the primitive has to live here.
 *
 * HOW WE KNOW IT IS RIGHT
 * -----------------------
 * Correctness is demonstrated, not asserted:
 *  - the 64-byte path is differentially tested against Node's own `blake2b512`
 *    over randomised inputs spanning the block boundary (0, 1, 127, 128, 129,
 *    255, 256 bytes), which pins the compression function, the counter and the
 *    last-block flag;
 *  - the variable-length path is proved end-to-end by the RFC 9106 Argon2id
 *    test vector, which exercises H' at both 32 and 1024 bytes.
 *
 * IMPLEMENTATION NOTE
 * -------------------
 * JavaScript has no 64-bit integer arithmetic that is both exact and fast
 * (BigInt is exact but two orders of magnitude too slow for a memory-hard
 * KDF), so every 64-bit word is carried as a little-endian pair of 32-bit
 * lanes inside a `Uint32Array`: word `k` occupies slots `2k` (low) and `2k+1`
 * (high). The `!` on every typed-array read is `noUncheckedIndexedAccess`
 * paying its tax; each index here is in range by construction (fixed-size
 * buffers, constant offsets) and asserting per-read is cheaper to review than
 * bounds checks that can never fire.
 */

/** Maximum digest length in bytes. */
export const BLAKE2B_MAX_OUTLEN = 64
const BLOCK_BYTES = 128

// IV, as low/high 32-bit lanes. IV[0] = 0x6a09e667f3bcc908, and so on.
const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
])

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
] as const

/**
 * Twelve rounds of message-word permutation, pre-doubled for lane indexing.
 * Rounds 10 and 11 reuse the schedules of rounds 0 and 1 (RFC 7693 §2.7).
 */
const SIGMA82 = (() => {
  const out = new Uint8Array(12 * 16)
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10] as readonly number[]
    for (let i = 0; i < 16; i++) out[round * 16 + i] = (s[i] as number) * 2
  }
  return out
})()

// Scratch reused across compressions. Single-threaded, and `compress` never
// yields, so sharing is safe and saves 512 bytes of allocation per block.
const V = new Uint32Array(32)
const M = new Uint32Array(32)

/** v[a] += v[b] (64-bit). */
function add64(v: Uint32Array, a: number, b: number): void {
  const lo = (v[a] as number) + (v[b] as number)
  let hi = (v[a + 1] as number) + (v[b + 1] as number)
  if (lo >= 0x100000000) hi++
  v[a] = lo
  v[a + 1] = hi
}

/** v[a] += (hi:lo) constant (64-bit). */
function add64c(v: Uint32Array, a: number, lo0: number, hi0: number): void {
  const lo = (v[a] as number) + (lo0 >>> 0)
  let hi = (v[a + 1] as number) + hi0
  if (lo >= 0x100000000) hi++
  v[a] = lo
  v[a + 1] = hi
}

function g(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
  const v = V
  const m = M

  add64(v, a, b)
  add64c(v, a, m[ix] as number, m[ix + 1] as number)

  // v[d] = rotr64(v[d] ^ v[a], 32) — a lane swap.
  let xl = (v[d] as number) ^ (v[a] as number)
  let xh = (v[d + 1] as number) ^ (v[a + 1] as number)
  v[d] = xh
  v[d + 1] = xl

  add64(v, c, d)

  // v[b] = rotr64(v[b] ^ v[c], 24)
  xl = (v[b] as number) ^ (v[c] as number)
  xh = (v[b + 1] as number) ^ (v[c + 1] as number)
  v[b] = (xl >>> 24) | (xh << 8)
  v[b + 1] = (xh >>> 24) | (xl << 8)

  add64(v, a, b)
  add64c(v, a, m[iy] as number, m[iy + 1] as number)

  // v[d] = rotr64(v[d] ^ v[a], 16)
  xl = (v[d] as number) ^ (v[a] as number)
  xh = (v[d + 1] as number) ^ (v[a + 1] as number)
  v[d] = (xl >>> 16) | (xh << 16)
  v[d + 1] = (xh >>> 16) | (xl << 16)

  add64(v, c, d)

  // v[b] = rotr64(v[b] ^ v[c], 63) — equivalently rotl64(.., 1)
  xl = (v[b] as number) ^ (v[c] as number)
  xh = (v[b + 1] as number) ^ (v[c + 1] as number)
  v[b] = (xh >>> 31) | (xl << 1)
  v[b + 1] = (xl >>> 31) | (xh << 1)
}

/** Streaming state. Exported so Argon2 can hash multi-part input in place. */
export interface Blake2bCtx {
  /** Message block buffer. */
  readonly b: Uint8Array
  /** Chaining state, 8 words as 16 lanes. */
  readonly h: Uint32Array
  /** Bytes compressed so far (bounded well below 2^53 for every caller here). */
  t: number
  /** Bytes currently buffered in `b`. */
  c: number
  readonly outlen: number
}

function compress(ctx: Blake2bCtx, last: boolean): void {
  const v = V
  const m = M

  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i] as number
    v[i + 16] = IV32[i] as number
  }

  // Mix in the byte counter t. The high half of t is always zero for the input
  // sizes this module sees (Argon2 hashes at most a few KiB at a time).
  v[24] = (v[24] as number) ^ (ctx.t >>> 0)
  v[25] = (v[25] as number) ^ Math.floor(ctx.t / 0x100000000)
  if (last) {
    v[28] = ~(v[28] as number)
    v[29] = ~(v[29] as number)
  }

  const b = ctx.b
  for (let i = 0; i < 32; i++) {
    const o = i * 4
    m[i] =
      (b[o] as number) ^
      ((b[o + 1] as number) << 8) ^
      ((b[o + 2] as number) << 16) ^
      ((b[o + 3] as number) << 24)
  }

  for (let r = 0; r < 12; r++) {
    const s = r * 16
    g(0, 8, 16, 24, SIGMA82[s] as number, SIGMA82[s + 1] as number)
    g(2, 10, 18, 26, SIGMA82[s + 2] as number, SIGMA82[s + 3] as number)
    g(4, 12, 20, 28, SIGMA82[s + 4] as number, SIGMA82[s + 5] as number)
    g(6, 14, 22, 30, SIGMA82[s + 6] as number, SIGMA82[s + 7] as number)
    g(0, 10, 20, 30, SIGMA82[s + 8] as number, SIGMA82[s + 9] as number)
    g(2, 12, 22, 24, SIGMA82[s + 10] as number, SIGMA82[s + 11] as number)
    g(4, 14, 16, 26, SIGMA82[s + 12] as number, SIGMA82[s + 13] as number)
    g(6, 8, 18, 28, SIGMA82[s + 14] as number, SIGMA82[s + 15] as number)
  }

  for (let i = 0; i < 16; i++) {
    ctx.h[i] = (ctx.h[i] as number) ^ (v[i] as number) ^ (v[i + 16] as number)
  }
}

/** Start an unkeyed BLAKE2b with a digest of `outlen` bytes (1..64). */
export function blake2bInit(outlen: number): Blake2bCtx {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > BLAKE2B_MAX_OUTLEN) {
    throw new RangeError(`blake2b digest length must be 1..${BLAKE2B_MAX_OUTLEN}, got ${outlen}`)
  }
  const h = new Uint32Array(IV32)
  // Parameter block, little-endian: digest_length | key_length<<8 | fanout<<16
  // | depth<<24. Unkeyed, sequential mode.
  h[0] = (h[0] as number) ^ 0x01010000 ^ outlen
  return { b: new Uint8Array(BLOCK_BYTES), h, t: 0, c: 0, outlen }
}

export function blake2bUpdate(ctx: Blake2bCtx, input: Uint8Array): void {
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === BLOCK_BYTES) {
      ctx.t += BLOCK_BYTES
      compress(ctx, false)
      ctx.c = 0
    }
    ctx.b[ctx.c++] = input[i] as number
  }
}

export function blake2bFinal(ctx: Blake2bCtx): Uint8Array {
  ctx.t += ctx.c
  while (ctx.c < BLOCK_BYTES) ctx.b[ctx.c++] = 0
  compress(ctx, true)

  const out = new Uint8Array(ctx.outlen)
  for (let i = 0; i < ctx.outlen; i++) {
    out[i] = ((ctx.h[i >> 2] as number) >> (8 * (i & 3))) & 0xff
  }
  // The chaining state is a secret intermediate for a KDF; do not leave it in
  // a live heap object after the digest has been handed back.
  ctx.h.fill(0)
  ctx.b.fill(0)
  return out
}

/** One-shot BLAKE2b over the concatenation of `parts`, without concatenating. */
export function blake2b(outlen: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const ctx = blake2bInit(outlen)
  for (const p of parts) blake2bUpdate(ctx, p)
  return blake2bFinal(ctx)
}
