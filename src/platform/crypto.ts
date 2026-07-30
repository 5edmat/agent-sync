/**
 * The cryptographic primitives the vault is built from.
 *
 * Everything here is Node's own `crypto` (OpenSSL) except Argon2id, which Node
 * does not ship — see `crypto-argon2.ts` for why that one is written out and
 * how it is verified.
 *
 * SCOPE: this module knows about keys and bytes. It knows nothing about
 * vaults, devices or refs — that policy lives in `core/vault-client.ts`. The
 * split matters because the primitives are the part that must be boring, and
 * boring is easier to audit when the file has no product logic in it.
 *
 * CONVENTIONS
 *  - Raw key material crosses this boundary as `Uint8Array`, never as a
 *    string. Strings are immutable in JavaScript and cannot be wiped.
 *  - Every function that derives a secret returns a fresh array the caller
 *    owns and should `zeroize()` when finished.
 *  - Comparisons on anything secret-derived go through `constantTimeEqual`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

export { argon2id, Argon2Error, ARGON2ID_OWASP_FLOOR, type Argon2idParams } from './crypto-argon2.js'
export { blake2b } from './crypto-blake2b.js'

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CryptoError'
  }
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export const AES_KEY_BYTES = 32
export const AES_IV_BYTES = 12
export const AES_TAG_BYTES = 16
export const X25519_KEY_BYTES = 32

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length))
}

export function newId(): string {
  return randomUUID()
}

/**
 * Overwrite key material in place.
 *
 * Honest about its limits: this zeroes the buffer we hold. It cannot reach
 * copies the garbage collector made while relocating the object, anything
 * OpenSSL kept internally, or pages the OS swapped out. It is a real
 * reduction in exposure window, not an erasure guarantee.
 */
export function zeroize(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const b of buffers) if (b) b.fill(0)
}

/**
 * Length-safe constant-time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false,
 * and the throw is itself observable, so lengths are compared first and
 * unequal lengths short-circuit. Length is not the secret here: every value
 * this is used on has a fixed, public length.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Constant-time comparison of two strings, compared as UTF-8 bytes. */
export function constantTimeEqualString(a: string, b: string): boolean {
  return constantTimeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * Strict base64 decode.
 *
 * `Buffer.from(s, 'base64')` silently ignores garbage, so a tampered field
 * would decode to *something* and fail later with a confusing error. Round-trip
 * the result and reject anything that does not reproduce its own input.
 */
export function fromBase64(value: string, what = 'value'): Uint8Array {
  const buf = Buffer.from(value, 'base64')
  if (buf.toString('base64') !== value) {
    throw new CryptoError(`${what} is not valid base64`)
  }
  return new Uint8Array(buf)
}

export function utf8(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

export function fromUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
}

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

/**
 * HKDF-SHA256.
 *
 * Used for key *separation*, never for passphrase stretching — HKDF is fast by
 * design and offers no brute-force resistance. Low-entropy inputs go through
 * `argon2id` first.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length = AES_KEY_BYTES,
): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length))
}

// ---------------------------------------------------------------------------
// AEAD
// ---------------------------------------------------------------------------

export interface AeadCiphertext {
  ciphertext: Uint8Array
  iv: Uint8Array
  tag: Uint8Array
}

/**
 * AES-256-GCM.
 *
 * The IV is generated fresh on every single call and never derived from
 * anything the caller controls. GCM fails catastrophically — full key recovery
 * — on IV reuse under the same key, so there is deliberately no way for a
 * caller to supply one.
 */
export function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): AeadCiphertext {
  if (key.length !== AES_KEY_BYTES) {
    throw new CryptoError(`aes-256-gcm requires a ${AES_KEY_BYTES}-byte key, got ${key.length}`)
  }
  const iv = randomBytes(AES_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ciphertext: new Uint8Array(ciphertext), iv, tag: new Uint8Array(cipher.getAuthTag()) }
}

/**
 * Authenticated decrypt. Throws `CryptoError` on any tag failure — a wrong
 * key, a flipped ciphertext bit and a rewritten AAD are all the same event
 * here, and the caller is responsible for any distinction it wants to draw
 * (see `vault-client.ts`, which draws them from evidence it holds separately
 * rather than from the tag).
 */
export function aeadOpen(key: Uint8Array, sealed: AeadCiphertext, aad: Uint8Array): Uint8Array {
  if (key.length !== AES_KEY_BYTES) {
    throw new CryptoError(`aes-256-gcm requires a ${AES_KEY_BYTES}-byte key, got ${key.length}`)
  }
  if (sealed.iv.length !== AES_IV_BYTES) throw new CryptoError('aes-256-gcm iv must be 12 bytes')
  if (sealed.tag.length !== AES_TAG_BYTES) throw new CryptoError('aes-256-gcm tag must be 16 bytes')
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(sealed.tag)
  try {
    return new Uint8Array(Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]))
  } catch (err) {
    throw new CryptoError('aead authentication failed', { cause: err })
  }
}

// ---------------------------------------------------------------------------
// X25519
// ---------------------------------------------------------------------------

export interface X25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

// Node's KeyObject API will not take a bare 32-byte scalar, so raw keys are
// wrapped in the fixed ASN.1 prefixes for id-X25519 (RFC 8410). These are
// constants, not parsing: the algorithm identifier and lengths are the same
// for every X25519 key that has ever existed.
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function privateKeyObject(raw: Uint8Array) {
  if (raw.length !== X25519_KEY_BYTES) {
    throw new CryptoError(`x25519 private key must be ${X25519_KEY_BYTES} bytes, got ${raw.length}`)
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  })
}

function publicKeyObject(raw: Uint8Array) {
  if (raw.length !== X25519_KEY_BYTES) {
    throw new CryptoError(`x25519 public key must be ${X25519_KEY_BYTES} bytes, got ${raw.length}`)
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  })
}

function rawPublic(key: ReturnType<typeof createPublicKey>): Uint8Array {
  const der = key.export({ type: 'spki', format: 'der' })
  return new Uint8Array(der.subarray(der.length - X25519_KEY_BYTES))
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const der = privateKey.export({ type: 'pkcs8', format: 'der' })
  return {
    publicKey: rawPublic(publicKey),
    privateKey: new Uint8Array(der.subarray(der.length - X25519_KEY_BYTES)),
  }
}

export function x25519PublicFromPrivate(privateKey: Uint8Array): Uint8Array {
  return rawPublic(createPublicKey(privateKeyObject(privateKey)))
}

/**
 * X25519 shared secret.
 *
 * Rejects an all-zero result. That is what a low-order public key produces,
 * and it would hand every party the same "shared" secret — a peer who
 * contributed a low-order point could otherwise make two sides agree on a key
 * it also knows. RFC 7748 leaves the check optional; for key wrapping it is
 * not optional.
 */
export function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let shared: Uint8Array
  try {
    shared = new Uint8Array(
      diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) }),
    )
  } catch (err) {
    throw new CryptoError('x25519 key agreement failed', { cause: err })
  }
  if (constantTimeEqual(shared, new Uint8Array(X25519_KEY_BYTES))) {
    zeroize(shared)
    throw new CryptoError('x25519 produced an all-zero shared secret (low-order public key)')
  }
  return shared
}

/** Reject a public key that cannot be used, before it is ever stored. */
export function assertUsableX25519PublicKey(publicKey: Uint8Array): void {
  const probe = generateX25519KeyPair()
  try {
    zeroize(x25519SharedSecret(probe.privateKey, publicKey))
  } finally {
    zeroize(probe.privateKey, probe.publicKey)
  }
}

// ---------------------------------------------------------------------------
// Sealed box — anonymous public-key encryption
// ---------------------------------------------------------------------------

export interface SealedBox {
  /** Ephemeral public key followed by ciphertext. */
  body: Uint8Array
  iv: Uint8Array
  tag: Uint8Array
}

const SEAL_INFO = 'agentsync/vault/sealed-box/v1'

/**
 * Encrypt to a public key, with no sender identity.
 *
 * A fresh ephemeral keypair per call, so the same plaintext sealed twice to
 * the same recipient produces unrelated output and the ephemeral private key
 * is gone before the function returns. Both public keys go into the HKDF salt,
 * which binds the derived key to the exact pair — an attacker who swaps the
 * ephemeral key in transit changes the key and the tag stops verifying.
 */
export function sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): SealedBox {
  const ephemeral = generateX25519KeyPair()
  let shared: Uint8Array | undefined
  let key: Uint8Array | undefined
  try {
    shared = x25519SharedSecret(ephemeral.privateKey, recipientPublicKey)
    key = hkdfSha256(shared, concat(ephemeral.publicKey, recipientPublicKey), SEAL_INFO)
    const { ciphertext, iv, tag } = aeadSeal(key, plaintext, aad)
    return { body: concat(ephemeral.publicKey, ciphertext), iv, tag }
  } finally {
    zeroize(ephemeral.privateKey, shared, key)
  }
}

/** Open a sealed box with the recipient's private key. */
export function openSealed(recipientPrivateKey: Uint8Array, box: SealedBox, aad: Uint8Array): Uint8Array {
  if (box.body.length < X25519_KEY_BYTES) {
    throw new CryptoError('sealed box is truncated')
  }
  const ephemeralPublicKey = box.body.subarray(0, X25519_KEY_BYTES)
  const ciphertext = box.body.subarray(X25519_KEY_BYTES)
  const recipientPublicKey = x25519PublicFromPrivate(recipientPrivateKey)
  let shared: Uint8Array | undefined
  let key: Uint8Array | undefined
  try {
    shared = x25519SharedSecret(recipientPrivateKey, ephemeralPublicKey)
    key = hkdfSha256(shared, concat(ephemeralPublicKey, recipientPublicKey), SEAL_INFO)
    return aeadOpen(key, { ciphertext, iv: box.iv, tag: box.tag }, aad)
  } finally {
    zeroize(shared, key)
  }
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
