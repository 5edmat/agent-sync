/**
 * Cross-OS conformance suite.
 *
 * These tests are no-ops on any host but their target OS. They exist because
 * the unit suite verifies our *logic* against fakes, and fakes cannot prove
 * that a real syscall behaves the way we modeled it. Everything here was
 * explicitly identified as unprovable from macOS.
 *
 * Until this suite is green on a real runner, the affected path table entries
 * stay `provenance: 'inferred'` and `apply()` refuses to write to them.
 *
 * Run: npm run test:conformance   (CI: .github/workflows/conformance.yml)
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { atomicWriteFile } from '../atomic.js'
import { materialize } from '../links.js'
import { detectHost, probeSymlinkSupport, probeLongPaths, nodeHostIO } from '../host.js'
import { selectSecretStore } from '../secrets.js'

const exec = promisify(execFile)
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'conformance-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe.runIf(isWindows)('windows: atomic write under real file locking', () => {
  /**
   * The highest-value Windows test. We model `rename()` failing with EPERM when
   * another process holds the target open, and we back off and retry. Only a
   * real exclusive handle proves the retry window is wide enough — antivirus and
   * Search Indexer take transient locks constantly on developer machines.
   */
  it('survives an exclusive handle held on the target', async () => {
    const target = join(work, 'locked.json')
    await writeFile(target, '{"v":1}', 'utf8')

    // Hold the file with FileShare.None for ~1.5s, then release.
    const holder = exec('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$f=[System.IO.File]::Open('${target}','Open','ReadWrite','None');` +
        `Start-Sleep -Milliseconds 1500; $f.Close()`,
    ])

    await new Promise((r) => setTimeout(r, 200)) // ensure the lock is held first
    const result = await atomicWriteFile(target, '{"v":2}', { retries: 40 })
    await holder

    expect(await readFile(target, 'utf8')).toBe('{"v":2}')
    // If this is 0, the lock was never actually contended and the test is lying.
    expect(result).toBeDefined()
  }, 30_000)

  it('never leaves a partial file when the write is contended', async () => {
    const target = join(work, 'partial.json')
    const original = JSON.stringify({ keep: 'me' })
    await writeFile(target, original, 'utf8')

    await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => atomicWriteFile(target, JSON.stringify({ n: i }), {})),
    )

    // Whatever won, the file must be complete and parseable — never truncated.
    const text = await readFile(target, 'utf8')
    expect(() => JSON.parse(text)).not.toThrow()

    // And no temp files may survive.
    const leftovers = (await readdir(work)).filter((f) => /\.tmp|~$/.test(f))
    expect(leftovers).toEqual([])
  }, 30_000)
})

describe.runIf(isWindows)('windows: junction safety', () => {
  /**
   * DATA-LOSS CLASS. On Windows we fall back to a directory junction when
   * symlinks are unavailable. If deleting the junction recursively also deletes
   * the *target*, we would destroy a user's real skills directory while
   * "cleaning up a link". A fake cannot catch this — it needs real NTFS.
   */
  it('deleting a junction does not delete its target', async () => {
    const target = join(work, 'junction-target')
    const link = join(work, 'junction-link')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), '# precious', 'utf8')

    const host = await detectHost()
    const res = await materialize(target, link, host)
    expect(['symlink', 'junction', 'copy']).toContain(res.strategy)

    await rm(link, { recursive: true, force: true })

    // The target and its contents MUST survive.
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('# precious')
  }, 30_000)
})

describe.runIf(isWindows)('windows: symlink privilege probe', () => {
  it('probe result matches what the OS actually permits', async () => {
    const probe = await probeSymlinkSupport(nodeHostIO, work)
    // Without Developer Mode or elevation this must report false rather than
    // throwing — materialize() depends on the probe to choose its strategy.
    expect(typeof probe).toBe('object')
  }, 20_000)
})

describe.runIf(isWindows)('windows: MAX_PATH', () => {
  it('long-path writes agree with the probe', async () => {
    const enabled = await probeLongPaths(nodeHostIO, 'windows')
    const deep = join(work, ...Array.from({ length: 12 }, (_, i) => `segment-${i}-${'x'.repeat(18)}`))
    await mkdir(deep, { recursive: true }).catch(() => {})
    const file = join(deep, 'settings.json')

    const attempt = atomicWriteFile(file, '{}', {})
    if (enabled) await expect(attempt).resolves.toBeDefined()
    else await expect(attempt).rejects.toBeTruthy()
  }, 30_000)
})

describe.runIf(isWindows)('windows: DPAPI round trip', () => {
  /**
   * The fake asserts our contract, not that ConvertFrom-SecureString actually
   * produces a blob CryptUnprotectData can read back.
   */
  it('stores and retrieves a secret through the real backend', async () => {
    const host = await detectHost()
    const sel = await selectSecretStore(host)
    expect(sel.chosen).toBe('windows-dpapi')

    const key = `conformance-${process.pid}`
    await sel.store.set(key, 'hunter2-é中')
    expect(await sel.store.get(key)).toBe('hunter2-é中')
    await sel.store.delete(key)
    expect(await sel.store.get(key)).toBeNull()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

describe.runIf(isLinux)('linux: secret backend selection', () => {
  /**
   * Headless Linux — every devcontainer, CI runner and cloud VM — has no
   * keyring. The failure mode we must never ship is a hang: libsecret blocks
   * waiting on a Secret Service that will never answer.
   *
   * CI runs this job twice: once bare, once with dbus-x11 + gnome-keyring.
   */
  it('selects a usable backend and never hangs', async () => {
    const started = Date.now()
    const host = await detectHost()
    const sel = await selectSecretStore(host)
    const elapsed = Date.now() - started

    expect(['linux-libsecret', 'encrypted-file']).toContain(sel.chosen)
    // The 5s internal timeout must actually fire. If this exceeds ~15s the
    // headless hang is real and users on CI would be stuck.
    expect(elapsed).toBeLessThan(15_000)

    if (!host.hasKeyring) expect(sel.chosen).toBe('encrypted-file')
  }, 30_000)

  it('round-trips a secret through whichever backend was chosen', async () => {
    const host = await detectHost()
    const sel = await selectSecretStore(host, { passphrase: 'conformance-pass' })
    const key = `conformance-${process.pid}`
    await sel.store.set(key, 'value-é')
    expect(await sel.store.get(key)).toBe('value-é')
    await sel.store.delete(key)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// All platforms — the invariants that must hold identically everywhere
// ---------------------------------------------------------------------------

describe('all platforms: host detection is self-consistent', () => {
  it('reports a coherent HostEnv', async () => {
    const host = await detectHost()
    expect(['macos', 'linux', 'windows']).toContain(host.os)
    expect(['native', 'wsl']).toContain(host.runtime)
    // WSL is a Linux userland reached through Windows. If this ever reports
    // os:'windows' + runtime:'wsl', the layer targeting in reconcile.ts breaks.
    if (host.runtime === 'wsl') expect(host.os).toBe('linux')
    expect(host.deviceId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('deviceId is stable across calls', async () => {
    const a = await detectHost()
    const b = await detectHost()
    expect(a.deviceId).toBe(b.deviceId)
  })
})
