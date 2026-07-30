/**
 * Primitive tests.
 *
 * Nothing here is mocked. A mocked cipher proves that the code calls a
 * function; these tests are trying to prove that the bytes are right, which is
 * the only thing that matters when the whole product's promise is "the server
 * cannot read this".
 *
 * The two hand-written primitives carry the burden of proof:
 *  - BLAKE2b is differentially tested against Node's own OpenSSL-backed
 *    `blake2b512` across every interesting input length;
 *  - Argon2id is checked against the official RFC 9106 §5.3 vector, which is
 *    the one artefact that can distinguish a correct implementation from a
 *    plausible one.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { blake2b } from '../crypto-blake2b.js'
import { argon2id, Argon2Error } from '../crypto-argon2.js'
import {
  aeadOpen,
  aeadSeal,
  assertUsableX25519PublicKey,
  concat,
  constantTimeEqual,
  constantTimeEqualString,
  CryptoError,
  fromBase64,
  generateX25519KeyPair,
  hkdfSha256,
  openSealed,
  randomBytes,
  sealTo,
  toBase64,
  utf8,
  x25519PublicFromPrivate,
  x25519SharedSecret,
  zeroize,
} from '../crypto.js'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const fill = (n: number, byte: number): Uint8Array => new Uint8Array(n).fill(byte)

// ---------------------------------------------------------------------------
// BLAKE2b
// ---------------------------------------------------------------------------

describe('blake2b', () => {
  it('matches RFC 7693 for the canonical "abc" input', () => {
    expect(hex(blake2b(64, utf8('abc')))).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
        '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    )
  })

  it('agrees with node blake2b512 on every length that could break blocking', () => {
    // 128 is the block size; 0/1/127/128/129 pin the padding, the last-block
    // flag and the byte counter, which is where a hand-rolled compression
    // function goes wrong.
    for (const n of [0, 1, 2, 63, 64, 65, 127, 128, 129, 255, 256, 1000]) {
      const input = nodeRandomBytes(n)
      expect(hex(blake2b(64, new Uint8Array(input)))).toBe(
        createHash('blake2b512').update(input).digest('hex'),
      )
    }
  })

  it('hashes a multi-part input as its concatenation', () => {
    const a = utf8('the quick brown ')
    const b = utf8('fox')
    expect(hex(blake2b(32, a, b))).toBe(hex(blake2b(32, concat(a, b))))
  })

  it('is not a truncation of the 512-bit digest — the length is in the parameters', () => {
    const short = blake2b(32, utf8('abc'))
    const long = blake2b(64, utf8('abc'))
    expect(hex(short)).not.toBe(hex(long.subarray(0, 32)))
  })

  it('rejects digest lengths outside 1..64', () => {
    expect(() => blake2b(0, utf8('x'))).toThrow(RangeError)
    expect(() => blake2b(65, utf8('x'))).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// Argon2id
// ---------------------------------------------------------------------------

describe('argon2id', () => {
  /**
   * RFC 9106 §5.3. Four lanes and three passes, so it exercises the
   * data-independent addressing of the first two slices, the data-dependent
   * addressing of everything after, cross-lane references, and the XOR-in
   * behaviour of version 0x13 on passes after the first. An implementation
   * that reproduces this tag agrees with the reference on every internal step.
   */
  it('reproduces the RFC 9106 test vector', () => {
    const tag = argon2id(fill(32, 0x01), fill(16, 0x02), {
      memoryKiB: 32,
      iterations: 3,
      parallelism: 4,
      tagLength: 32,
      secret: fill(8, 0x03),
      associatedData: fill(12, 0x04),
    })
    expect(hex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
  })

  it('is deterministic, and every parameter changes the answer', () => {
    const pw = utf8('correct horse battery staple')
    const salt = fill(16, 0x42)
    const base = { memoryKiB: 64, iterations: 2, parallelism: 1 }

    expect(hex(argon2id(pw, salt, base))).toBe(hex(argon2id(pw, salt, base)))
    expect(hex(argon2id(pw, salt, base))).not.toBe(hex(argon2id(utf8('wrong'), salt, base)))
    expect(hex(argon2id(pw, salt, base))).not.toBe(hex(argon2id(pw, fill(16, 0x43), base)))
    expect(hex(argon2id(pw, salt, base))).not.toBe(
      hex(argon2id(pw, salt, { ...base, memoryKiB: 128 })),
    )
    expect(hex(argon2id(pw, salt, base))).not.toBe(hex(argon2id(pw, salt, { ...base, iterations: 3 })))
    expect(hex(argon2id(pw, salt, base))).not.toBe(hex(argon2id(pw, salt, { ...base, parallelism: 2 })))
  })

  it('honours the requested tag length', () => {
    const pw = utf8('pw')
    const salt = fill(16, 1)
    expect(argon2id(pw, salt, { memoryKiB: 32, iterations: 1, parallelism: 1, tagLength: 16 })).toHaveLength(16)
    expect(argon2id(pw, salt, { memoryKiB: 32, iterations: 1, parallelism: 1, tagLength: 64 })).toHaveLength(64)
    // Above 64 bytes H' switches from a single BLAKE2b to a chained construction.
    expect(argon2id(pw, salt, { memoryKiB: 32, iterations: 1, parallelism: 1, tagLength: 100 })).toHaveLength(100)
  })

  it('refuses parameters that would silently weaken it', () => {
    const pw = utf8('pw')
    const salt = fill(16, 1)
    expect(() => argon2id(pw, salt, { memoryKiB: 32, iterations: 0, parallelism: 1 })).toThrow(Argon2Error)
    expect(() => argon2id(pw, salt, { memoryKiB: 4, iterations: 1, parallelism: 1 })).toThrow(Argon2Error)
    expect(() => argon2id(pw, salt, { memoryKiB: 32, iterations: 1, parallelism: 0 })).toThrow(Argon2Error)
    expect(() => argon2id(pw, fill(4, 1), { memoryKiB: 32, iterations: 1, parallelism: 1 })).toThrow(Argon2Error)
  })

  it('runs at the OWASP floor the vault ships with', () => {
    // Not a benchmark — a guard that the production parameters are actually
    // reachable in this implementation rather than only the toy ones.
    const tag = argon2id(utf8('production passphrase'), fill(16, 7), {
      memoryKiB: 19456,
      iterations: 2,
      parallelism: 1,
    })
    expect(tag).toHaveLength(32)
  })
})

// ---------------------------------------------------------------------------
// HKDF and AEAD
// ---------------------------------------------------------------------------

describe('hkdfSha256', () => {
  it('separates keys by info string', () => {
    const ikm = fill(32, 9)
    const salt = fill(16, 3)
    expect(hex(hkdfSha256(ikm, salt, 'a'))).not.toBe(hex(hkdfSha256(ikm, salt, 'b')))
    expect(hex(hkdfSha256(ikm, salt, 'a'))).toBe(hex(hkdfSha256(ikm, salt, 'a')))
  })
})

describe('aes-256-gcm', () => {
  const key = fill(32, 1)
  const aad = utf8('bound-context')

  it('round trips', () => {
    const sealed = aeadSeal(key, utf8('hello'), aad)
    expect(Buffer.from(aeadOpen(key, sealed, aad)).toString('utf8')).toBe('hello')
  })

  it('generates a fresh iv per call, so the same plaintext never repeats', () => {
    const a = aeadSeal(key, utf8('hello'), aad)
    const b = aeadSeal(key, utf8('hello'), aad)
    expect(hex(a.iv)).not.toBe(hex(b.iv))
    expect(hex(a.ciphertext)).not.toBe(hex(b.ciphertext))
  })

  it('rejects a flipped ciphertext bit', () => {
    const sealed = aeadSeal(key, utf8('hello'), aad)
    sealed.ciphertext[0] = (sealed.ciphertext[0] as number) ^ 0x01
    expect(() => aeadOpen(key, sealed, aad)).toThrow(CryptoError)
  })

  it('rejects a rewritten tag, iv, aad or key', () => {
    const sealed = aeadSeal(key, utf8('hello'), aad)
    expect(() => aeadOpen(key, { ...sealed, tag: fill(16, 0) }, aad)).toThrow(CryptoError)
    expect(() => aeadOpen(key, { ...sealed, iv: fill(12, 0) }, aad)).toThrow(CryptoError)
    expect(() => aeadOpen(key, sealed, utf8('different-context'))).toThrow(CryptoError)
    expect(() => aeadOpen(fill(32, 2), sealed, aad)).toThrow(CryptoError)
  })

  it('refuses a key that is not 256 bits', () => {
    expect(() => aeadSeal(fill(16, 1), utf8('x'), aad)).toThrow(CryptoError)
  })
})

// ---------------------------------------------------------------------------
// X25519
// ---------------------------------------------------------------------------

describe('x25519', () => {
  it('agrees on a shared secret from either side', () => {
    const a = generateX25519KeyPair()
    const b = generateX25519KeyPair()
    expect(hex(x25519SharedSecret(a.privateKey, b.publicKey))).toBe(
      hex(x25519SharedSecret(b.privateKey, a.publicKey)),
    )
  })

  it('recovers the public key from the private key', () => {
    const a = generateX25519KeyPair()
    expect(hex(x25519PublicFromPrivate(a.privateKey))).toBe(hex(a.publicKey))
  })

  it('rejects a low-order public key instead of agreeing on zero', () => {
    const a = generateX25519KeyPair()
    expect(() => x25519SharedSecret(a.privateKey, fill(32, 0))).toThrow(CryptoError)
    expect(() => assertUsableX25519PublicKey(fill(32, 0))).toThrow(CryptoError)
    expect(() => assertUsableX25519PublicKey(generateX25519KeyPair().publicKey)).not.toThrow()
  })

  it('rejects keys of the wrong length', () => {
    expect(() => x25519PublicFromPrivate(fill(16, 1))).toThrow(CryptoError)
  })
})

describe('sealed box', () => {
  const aad = utf8('slot=device')

  it('round trips to the holder of the private key', () => {
    const recipient = generateX25519KeyPair()
    const box = sealTo(recipient.publicKey, utf8('dek'), aad)
    expect(Buffer.from(openSealed(recipient.privateKey, box, aad)).toString('utf8')).toBe('dek')
  })

  it('produces unrelated output each time — the ephemeral key is per call', () => {
    const recipient = generateX25519KeyPair()
    const a = sealTo(recipient.publicKey, utf8('dek'), aad)
    const b = sealTo(recipient.publicKey, utf8('dek'), aad)
    expect(hex(a.body)).not.toBe(hex(b.body))
    expect(hex(a.body.subarray(0, 32))).not.toBe(hex(b.body.subarray(0, 32)))
  })

  it('does not open for anyone else', () => {
    const recipient = generateX25519KeyPair()
    const stranger = generateX25519KeyPair()
    const box = sealTo(recipient.publicKey, utf8('dek'), aad)
    expect(() => openSealed(stranger.privateKey, box, aad)).toThrow(CryptoError)
  })

  it('rejects a substituted ephemeral key, because it is bound into the kdf', () => {
    const recipient = generateX25519KeyPair()
    const box = sealTo(recipient.publicKey, utf8('dek'), aad)
    box.body.set(generateX25519KeyPair().publicKey, 0)
    expect(() => openSealed(recipient.privateKey, box, aad)).toThrow(CryptoError)
  })

  it('rejects a rewritten aad', () => {
    const recipient = generateX25519KeyPair()
    const box = sealTo(recipient.publicKey, utf8('dek'), aad)
    expect(() => openSealed(recipient.privateKey, box, utf8('slot=passphrase'))).toThrow(CryptoError)
  })

  it('rejects a truncated box rather than reading past the end', () => {
    const recipient = generateX25519KeyPair()
    const box = sealTo(recipient.publicKey, utf8('dek'), aad)
    expect(() => openSealed(recipient.privateKey, { ...box, body: box.body.subarray(0, 8) }, aad)).toThrow(
      CryptoError,
    )
  })
})

// ---------------------------------------------------------------------------
// Byte utilities
// ---------------------------------------------------------------------------

describe('byte utilities', () => {
  it('compares in constant time, and length mismatch is false not a throw', () => {
    expect(constantTimeEqual(fill(32, 1), fill(32, 1))).toBe(true)
    expect(constantTimeEqual(fill(32, 1), fill(32, 2))).toBe(false)
    expect(constantTimeEqual(fill(32, 1), fill(16, 1))).toBe(false)
    expect(constantTimeEqualString('abc', 'abc')).toBe(true)
    expect(constantTimeEqualString('abc', 'abd')).toBe(false)
    expect(constantTimeEqualString('abc', 'abcd')).toBe(false)
  })

  it('round trips base64 and rejects anything that is not canonical', () => {
    const bytes = randomBytes(32)
    expect(hex(fromBase64(toBase64(bytes)))).toBe(hex(bytes))
    // Buffer.from silently discards junk; fromBase64 must not.
    expect(() => fromBase64('not base64!!')).toThrow(CryptoError)
    expect(() => fromBase64('AAAA=')).toThrow(CryptoError)
  })

  it('zeroizes in place and tolerates undefined', () => {
    const secret = fill(32, 0xff)
    zeroize(secret, undefined)
    expect(hex(secret)).toBe('00'.repeat(32))
  })

  it('generates distinct random bytes of the requested length', () => {
    expect(randomBytes(32)).toHaveLength(32)
    expect(hex(randomBytes(32))).not.toBe(hex(randomBytes(32)))
  })
})
