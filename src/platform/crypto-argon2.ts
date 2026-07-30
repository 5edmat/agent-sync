/**
 * Argon2id (RFC 9106), version 0x13.
 *
 * WHY A HAND-WRITTEN KDF
 * ----------------------
 * `KdfParams.algorithm` in the vault contract is typed `'argon2id'`. Node ships
 * `scrypt` and not Argon2, so there were exactly two honest moves: widen the
 * type to say `'scrypt'` and mean it, or make the existing label true. This
 * file takes the second, because the surrounding contract is *shaped* like
 * Argon2 — `memoryKiB` / `iterations` / `parallelism` are Argon2's cost knobs,
 * not scrypt's `N`/`r`/`p`, and the OWASP floor quoted in the doc comment
 * (19 MiB, t=2, p=1) is the Argon2id floor. Relabelling would have forced a
 * second, quieter lie about what the numbers mean.
 *
 * That trade is only defensible because the result is *verifiable*: the
 * official RFC 9106 §5.3 Argon2id test vector — which exercises multiple
 * lanes, multiple passes, both the data-independent and the data-dependent
 * addressing modes, and the secret and associated-data inputs — is asserted in
 * `crypto.test.ts`. An implementation that passes that vector agrees with the
 * reference implementation on every internal step; there is nowhere for a
 * subtle deviation to hide.
 *
 * WHAT THIS IS NOT
 * ----------------
 * A side-channel-hardened implementation. Argon2id's first half is
 * data-independent by design, which is where the protection actually comes
 * from, but JavaScript gives no control over cache behaviour, and the memory
 * we allocate is subject to GC copying and to being paged out. Against an
 * attacker with local code execution on the unlocked device, this — like any
 * in-process KDF — is not the defence. It is a defence against offline attack
 * on a stolen server record, and for that it is sound.
 */

import { blake2b, blake2bFinal, blake2bInit, blake2bUpdate } from './crypto-blake2b.js'

/** 1024-byte Argon2 block, as 128 64-bit words = 256 32-bit lanes. */
const WORDS_PER_BLOCK = 128
const LANES_PER_BLOCK = WORDS_PER_BLOCK * 2
const BLOCK_BYTES = WORDS_PER_BLOCK * 8
const SYNC_POINTS = 4
const ADDRESSES_PER_BLOCK = WORDS_PER_BLOCK
const ARGON2_TYPE_ID = 2
const ARGON2_VERSION = 0x13

/** OWASP's low-memory floor for Argon2id, quoted by the vault contract. */
export const ARGON2ID_OWASP_FLOOR = {
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const

export interface Argon2idParams {
  /** Memory cost in kibibytes. Minimum 8 * parallelism. */
  memoryKiB: number
  /** Passes over memory. Minimum 1. */
  iterations: number
  /** Lanes. Minimum 1. */
  parallelism: number
  /** Output length in bytes. Minimum 4. Default 32. */
  tagLength?: number
  /** Optional keyed input ("pepper", RFC 9106 K). Not used by the vault. */
  secret?: Uint8Array
  /** Optional associated data (RFC 9106 X). Not used by the vault. */
  associatedData?: Uint8Array
}

export class Argon2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Argon2Error'
  }
}

// ---------------------------------------------------------------------------
// 64-bit lane arithmetic
// ---------------------------------------------------------------------------

/**
 * v[x] = v[x] + v[y] + 2 * lo32(v[x]) * lo32(v[y])   (RFC 9106 fBlaMka)
 *
 * The 32x32 -> 64 multiply is done in 16-bit limbs so every partial product
 * stays under 2^32 and therefore exact in a float64. Doing it with `*` on
 * 32-bit values directly would silently lose the low bits.
 */
function fBlaMka(v: Uint32Array, x: number, y: number): void {
  const xl = v[x] as number
  const xh = v[x + 1] as number
  const yl = v[y] as number
  const yh = v[y + 1] as number

  const ah = xl >>> 16
  const al = xl & 0xffff
  const bh = yl >>> 16
  const bl = yl & 0xffff

  const t0 = al * bl
  const t1 = ah * bl + (t0 >>> 16)
  const t2 = al * bh + (t1 & 0xffff)
  let mhi = ah * bh + (t1 >>> 16) + (t2 >>> 16)
  let mlo = (((t2 & 0xffff) << 16) | (t0 & 0xffff)) >>> 0

  // times two
  mhi = ((mhi << 1) | (mlo >>> 31)) >>> 0
  mlo = (mlo << 1) >>> 0

  const s0 = xl + yl
  const c0 = s0 >= 0x100000000 ? 1 : 0
  const s1 = (s0 >>> 0) + mlo
  const c1 = s1 >= 0x100000000 ? 1 : 0

  v[x] = s1
  v[x + 1] = xh + yh + mhi + c0 + c1
}

/** v[x] = rotr64(v[x] ^ v[y], 32) */
function xorRotr32(v: Uint32Array, x: number, y: number): void {
  const lo = (v[x] as number) ^ (v[y] as number)
  const hi = (v[x + 1] as number) ^ (v[y + 1] as number)
  v[x] = hi
  v[x + 1] = lo
}

/** v[x] = rotr64(v[x] ^ v[y], 24) */
function xorRotr24(v: Uint32Array, x: number, y: number): void {
  const lo = (v[x] as number) ^ (v[y] as number)
  const hi = (v[x + 1] as number) ^ (v[y + 1] as number)
  v[x] = (lo >>> 24) | (hi << 8)
  v[x + 1] = (hi >>> 24) | (lo << 8)
}

/** v[x] = rotr64(v[x] ^ v[y], 16) */
function xorRotr16(v: Uint32Array, x: number, y: number): void {
  const lo = (v[x] as number) ^ (v[y] as number)
  const hi = (v[x + 1] as number) ^ (v[y + 1] as number)
  v[x] = (lo >>> 16) | (hi << 16)
  v[x + 1] = (hi >>> 16) | (lo << 16)
}

/** v[x] = rotr64(v[x] ^ v[y], 63) === rotl64(v[x] ^ v[y], 1) */
function xorRotr63(v: Uint32Array, x: number, y: number): void {
  const lo = (v[x] as number) ^ (v[y] as number)
  const hi = (v[x + 1] as number) ^ (v[y + 1] as number)
  v[x] = (lo << 1) | (hi >>> 31)
  v[x + 1] = (hi << 1) | (lo >>> 31)
}

function gb(v: Uint32Array, a: number, b: number, c: number, d: number): void {
  fBlaMka(v, a, b)
  xorRotr32(v, d, a)
  fBlaMka(v, c, d)
  xorRotr24(v, b, c)
  fBlaMka(v, a, b)
  xorRotr16(v, d, a)
  fBlaMka(v, c, d)
  xorRotr63(v, b, c)
}

/**
 * BLAKE2b's round function with no message input, over sixteen 64-bit words
 * given as lane offsets. Four column steps then four diagonal steps.
 */
function roundNoMsg(
  v: Uint32Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number,
  i4: number,
  i5: number,
  i6: number,
  i7: number,
  i8: number,
  i9: number,
  i10: number,
  i11: number,
  i12: number,
  i13: number,
  i14: number,
  i15: number,
): void {
  gb(v, i0, i4, i8, i12)
  gb(v, i1, i5, i9, i13)
  gb(v, i2, i6, i10, i14)
  gb(v, i3, i7, i11, i15)
  gb(v, i0, i5, i10, i15)
  gb(v, i1, i6, i11, i12)
  gb(v, i2, i7, i8, i13)
  gb(v, i3, i4, i9, i14)
}

// ---------------------------------------------------------------------------
// Compression function G
// ---------------------------------------------------------------------------

const R = new Uint32Array(LANES_PER_BLOCK)
const TMP = new Uint32Array(LANES_PER_BLOCK)

/**
 * next = (withXor ? next : 0) ^ (prev ^ ref) ^ P(P_columns(prev ^ ref))
 *
 * `withXor` is the version-0x13 rule for passes after the first: the block
 * being overwritten is XORed in rather than replaced, so later passes depend
 * on the whole prior state.
 */
function fillBlock(
  prev: Uint32Array,
  prevOff: number,
  ref: Uint32Array,
  refOff: number,
  next: Uint32Array,
  nextOff: number,
  withXor: boolean,
): void {
  for (let i = 0; i < LANES_PER_BLOCK; i++) {
    R[i] = (ref[refOff + i] as number) ^ (prev[prevOff + i] as number)
    TMP[i] = R[i] as number
  }
  if (withXor) {
    for (let i = 0; i < LANES_PER_BLOCK; i++) TMP[i] = (TMP[i] as number) ^ (next[nextOff + i] as number)
  }

  // Columns: words (0..15), (16..31), ... (112..127).
  for (let i = 0; i < 8; i++) {
    const b = 32 * i
    roundNoMsg(
      R, b, b + 2, b + 4, b + 6, b + 8, b + 10, b + 12, b + 14,
      b + 16, b + 18, b + 20, b + 22, b + 24, b + 26, b + 28, b + 30,
    )
  }
  // Rows: words (0,1,16,17,32,33,...), stepping two words per group.
  for (let i = 0; i < 8; i++) {
    const b = 4 * i
    roundNoMsg(
      R, b, b + 2, b + 32, b + 34, b + 64, b + 66, b + 96, b + 98,
      b + 128, b + 130, b + 160, b + 162, b + 192, b + 194, b + 224, b + 226,
    )
  }

  for (let i = 0; i < LANES_PER_BLOCK; i++) {
    next[nextOff + i] = (TMP[i] as number) ^ (R[i] as number)
  }
}

// ---------------------------------------------------------------------------
// H' — variable-length hash (RFC 9106 §3.2)
// ---------------------------------------------------------------------------

function le32(value: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = value & 0xff
  b[1] = (value >>> 8) & 0xff
  b[2] = (value >>> 16) & 0xff
  b[3] = (value >>> 24) & 0xff
  return b
}

/** H'^outlen(parts) — BLAKE2b below 65 bytes, a 32-byte-stride chain above. */
function hPrime(outlen: number, ...parts: readonly Uint8Array[]): Uint8Array {
  if (outlen <= 64) return blake2b(outlen, le32(outlen), ...parts)

  const out = new Uint8Array(outlen)
  const chainCount = Math.ceil(outlen / 32) - 2
  let v = blake2b(64, le32(outlen), ...parts)
  out.set(v.subarray(0, 32), 0)
  for (let i = 1; i < chainCount; i++) {
    v = blake2b(64, v)
    out.set(v.subarray(0, 32), i * 32)
  }
  const tailLen = outlen - 32 * chainCount
  out.set(blake2b(tailLen, v), chainCount * 32)
  return out
}

// ---------------------------------------------------------------------------
// Argon2id
// ---------------------------------------------------------------------------

const EMPTY = new Uint8Array(0)

function h0(
  password: Uint8Array,
  salt: Uint8Array,
  p: Argon2idParams,
  tagLength: number,
): Uint8Array {
  const secret = p.secret ?? EMPTY
  const ad = p.associatedData ?? EMPTY
  const ctx = blake2bInit(64)
  for (const part of [
    le32(p.parallelism),
    le32(tagLength),
    le32(p.memoryKiB),
    le32(p.iterations),
    le32(ARGON2_VERSION),
    le32(ARGON2_TYPE_ID),
    le32(password.length),
    password,
    le32(salt.length),
    salt,
    le32(secret.length),
    secret,
    le32(ad.length),
    ad,
  ]) {
    blake2bUpdate(ctx, part)
  }
  return blake2bFinal(ctx)
}

function blockFromBytes(memory: Uint32Array, offset: number, bytes: Uint8Array): void {
  for (let i = 0; i < LANES_PER_BLOCK; i++) {
    const o = i * 4
    memory[offset + i] =
      (bytes[o] as number) |
      ((bytes[o + 1] as number) << 8) |
      ((bytes[o + 2] as number) << 16) |
      ((bytes[o + 3] as number) << 24)
  }
}

function bytesFromBlock(memory: Uint32Array, offset: number): Uint8Array {
  const out = new Uint8Array(BLOCK_BYTES)
  for (let i = 0; i < LANES_PER_BLOCK; i++) {
    const w = memory[offset + i] as number
    const o = i * 4
    out[o] = w & 0xff
    out[o + 1] = (w >>> 8) & 0xff
    out[o + 2] = (w >>> 16) & 0xff
    out[o + 3] = (w >>> 24) & 0xff
  }
  return out
}

/**
 * floor(a * b / 2^32) for a, b < 2^32, exactly.
 *
 * The spec does this in uint64. `a * b` in JavaScript overflows float64's
 * 53-bit mantissa and rounds — silently, and only for some inputs, which is
 * the worst possible failure mode for a KDF. 16-bit limbs keep every partial
 * product exact.
 */
function mulhi32(a: number, b: number): number {
  const a1 = a >>> 16
  const a0 = a & 0xffff
  const b1 = b >>> 16
  const b0 = b & 0xffff
  return a1 * b1 + Math.floor(((a1 * b0 + a0 * b1) * 0x10000 + a0 * b0) / 0x100000000)
}

/**
 * Where the next block's input comes from (RFC 9106 §3.4.1.2). `randHigh`
 * picks the lane, `randLow` picks the position inside it via the quadratic
 * mapping that biases references toward recently written blocks.
 */
function referenceIndex(
  randLow: number,
  sameLane: boolean,
  pass: number,
  slice: number,
  index: number,
  segmentLength: number,
  laneLength: number,
): number {
  let areaSize: number
  if (pass === 0) {
    if (slice === 0) {
      areaSize = index - 1
    } else if (sameLane) {
      areaSize = slice * segmentLength + index - 1
    } else {
      areaSize = slice * segmentLength + (index === 0 ? -1 : 0)
    }
  } else if (sameLane) {
    areaSize = laneLength - segmentLength + index - 1
  } else {
    areaSize = laneLength - segmentLength + (index === 0 ? -1 : 0)
  }

  // relative = areaSize - 1 - ((areaSize * ((rand^2) >> 32)) >> 32), uint64 math.
  const r = randLow >>> 0
  const relative = areaSize - 1 - mulhi32(areaSize, mulhi32(r, r))

  const start = pass === 0 ? 0 : slice === SYNC_POINTS - 1 ? 0 : (slice + 1) * segmentLength
  return (start + relative) % laneLength
}

/**
 * Derive a tag from `password` and `salt`.
 *
 * Both inputs are treated as secret; neither is retained. The returned tag is
 * the caller's to zero.
 */
export function argon2id(password: Uint8Array, salt: Uint8Array, params: Argon2idParams): Uint8Array {
  const tagLength = params.tagLength ?? 32
  const { memoryKiB, iterations, parallelism } = params

  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 0xffffff) {
    throw new Argon2Error(`parallelism must be 1..${0xffffff}, got ${parallelism}`)
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Argon2Error(`iterations must be at least 1, got ${iterations}`)
  }
  if (!Number.isInteger(memoryKiB) || memoryKiB < 8 * parallelism) {
    throw new Argon2Error(`memoryKiB must be at least 8 * parallelism (${8 * parallelism}), got ${memoryKiB}`)
  }
  if (!Number.isInteger(tagLength) || tagLength < 4) {
    throw new Argon2Error(`tagLength must be at least 4, got ${tagLength}`)
  }
  if (salt.length < 8) {
    throw new Argon2Error(`salt must be at least 8 bytes, got ${salt.length}`)
  }

  // m' = 4*p*floor(m/4p): memory is rounded down to whole segments.
  const blocks = SYNC_POINTS * parallelism * Math.floor(memoryKiB / (SYNC_POINTS * parallelism))
  const laneLength = blocks / parallelism
  const segmentLength = laneLength / SYNC_POINTS

  const memory = new Uint32Array(blocks * LANES_PER_BLOCK)
  const seed = h0(password, salt, params, tagLength)
  const seeded = new Uint8Array(72)
  seeded.set(seed, 0)

  try {
    for (let lane = 0; lane < parallelism; lane++) {
      for (let col = 0; col < 2; col++) {
        seeded.set(le32(col), 64)
        seeded.set(le32(lane), 68)
        const block = hPrime(BLOCK_BYTES, seeded)
        blockFromBytes(memory, (lane * laneLength + col) * LANES_PER_BLOCK, block)
        block.fill(0)
      }
    }

    const zero = new Uint32Array(LANES_PER_BLOCK)
    const addressInput = new Uint32Array(LANES_PER_BLOCK)
    const addressBlock = new Uint32Array(LANES_PER_BLOCK)

    for (let pass = 0; pass < iterations; pass++) {
      for (let slice = 0; slice < SYNC_POINTS; slice++) {
        for (let lane = 0; lane < parallelism; lane++) {
          // Argon2id: the first two slices of the first pass are indexed
          // data-independently (argon2i), everything after is data-dependent
          // (argon2d). That split is the whole point of the "id" variant.
          const dataIndependent = pass === 0 && slice < 2

          if (dataIndependent) {
            addressInput.fill(0)
            addressInput[0] = pass
            addressInput[2] = lane
            addressInput[4] = slice
            addressInput[6] = blocks
            addressInput[8] = iterations
            addressInput[10] = ARGON2_TYPE_ID
          }

          const startIndex = pass === 0 && slice === 0 ? 2 : 0
          if (dataIndependent && startIndex === 2) {
            addressInput[12] = (addressInput[12] as number) + 1
            fillBlock(zero, 0, addressInput, 0, addressBlock, 0, false)
            fillBlock(zero, 0, addressBlock, 0, addressBlock, 0, false)
          }

          let curr = lane * laneLength + slice * segmentLength + startIndex
          let prev = curr % laneLength === 0 ? curr + laneLength - 1 : curr - 1

          for (let index = startIndex; index < segmentLength; index++, curr++, prev++) {
            if (curr % laneLength === 1) prev = curr - 1

            let randLow: number
            let randHigh: number
            if (dataIndependent) {
              const addressCursor = index % ADDRESSES_PER_BLOCK
              if (addressCursor === 0) {
                addressInput[12] = (addressInput[12] as number) + 1
                fillBlock(zero, 0, addressInput, 0, addressBlock, 0, false)
                fillBlock(zero, 0, addressBlock, 0, addressBlock, 0, false)
              }
              randLow = addressBlock[addressCursor * 2] as number
              randHigh = addressBlock[addressCursor * 2 + 1] as number
            } else {
              randLow = memory[prev * LANES_PER_BLOCK] as number
              randHigh = memory[prev * LANES_PER_BLOCK + 1] as number
            }

            let refLane = (randHigh >>> 0) % parallelism
            if (pass === 0 && slice === 0) refLane = lane

            const refIndex = referenceIndex(
              randLow,
              refLane === lane,
              pass,
              slice,
              index,
              segmentLength,
              laneLength,
            )

            fillBlock(
              memory,
              prev * LANES_PER_BLOCK,
              memory,
              (refLane * laneLength + refIndex) * LANES_PER_BLOCK,
              memory,
              curr * LANES_PER_BLOCK,
              pass !== 0,
            )
          }
        }
      }
    }

    // C = XOR of the last block of every lane; tag = H'(C).
    const final = new Uint32Array(LANES_PER_BLOCK)
    for (let lane = 0; lane < parallelism; lane++) {
      const off = (lane * laneLength + laneLength - 1) * LANES_PER_BLOCK
      for (let i = 0; i < LANES_PER_BLOCK; i++) final[i] = (final[i] as number) ^ (memory[off + i] as number)
    }
    const finalBytes = bytesFromBlock(final, 0)
    const tag = hPrime(tagLength, finalBytes)
    final.fill(0)
    finalBytes.fill(0)
    zero.fill(0)
    addressInput.fill(0)
    addressBlock.fill(0)
    return tag
  } finally {
    // 19 MiB of key-correlated state. Wipe it even if we threw.
    memory.fill(0)
    seed.fill(0)
    seeded.fill(0)
    R.fill(0)
    TMP.fill(0)
  }
}
