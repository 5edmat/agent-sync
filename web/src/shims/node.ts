/**
 * Browser stand-ins for the Node builtins the adapter graph imports.
 *
 * WHY THIS EXISTS: the store inventory this app draws must be the real one.
 * `adapter.locations(host, ctx)` is declared pure — "The path table for this
 * (tool x OS) cell. Pure — no IO." — so it runs perfectly well in a browser.
 * What does not run in a browser is the module graph it sits in: the adapters
 * import `node:fs/promises` for `read()`, and reach `core/apply-engine.ts`,
 * which reaches `platform/atomic.ts`, `platform/host.ts` and
 * `platform/secrets.ts` for `apply()`. None of that is reachable FROM
 * `locations()`; all of it has to resolve for the module to load.
 *
 * The alternative was a build-time snapshot script that dumps the path table to
 * JSON. That decouples the UI from the adapters exactly when it matters — an
 * adapter gains a store and the app keeps drawing yesterday's inventory until
 * someone remembers to regenerate. Importing the source keeps one copy.
 *
 * So: every function here THROWS, and this is not a polyfill and must never
 * become one. If one of them ever fires, the app has reached for real IO, which
 * is a bug in the app — the web tier only edits intent, `apply()` is the only
 * thing in the product that writes, and it runs on the device. A loud failure is
 * how that gets found.
 *
 * The shapes (`promises`, `promisify`, `sep`) exist because some of those
 * modules destructure or call at import time. They are the minimum needed for
 * the graph to LOAD, never enough for it to do anything.
 */

function forbidden(fn: string): never {
  throw new Error(
    `${fn}() is not available in the browser. The web tier reads adapter path ` +
      `tables (locations(), which is pure) and never touches a filesystem, a ` +
      `keychain or a process. Reaching this means something called into ` +
      `adapter IO from the UI.`,
  )
}

const nope =
  (name: string) =>
  (...args: unknown[]): never => {
    void args
    return forbidden(name)
  }

// --- node:fs/promises, and node:fs's `promises` -----------------------------
export const readFile = nope('readFile')
export const writeFile = nope('writeFile')
export const readdir = nope('readdir')
export const stat = nope('stat')
export const lstat = nope('lstat')
export const mkdir = nope('mkdir')
export const rm = nope('rm')
export const rename = nope('rename')
export const unlink = nope('unlink')
export const symlink = nope('symlink')
export const readlink = nope('readlink')
export const realpath = nope('realpath')
export const open = nope('open')
export const chmod = nope('chmod')
export const copyFile = nope('copyFile')
export const access = nope('access')
export const cp = nope('cp')

/** `import { promises as fsp } from 'node:fs'` destructures this at load time. */
export const promises = {
  readFile,
  writeFile,
  readdir,
  stat,
  lstat,
  mkdir,
  rm,
  rename,
  unlink,
  symlink,
  readlink,
  realpath,
  open,
  chmod,
  copyFile,
  access,
  cp,
}

export const constants = {}

// --- node:path -------------------------------------------------------------
// Pure string functions, but still unreachable from `locations()`, which does
// its own OS-correct joining. A silently POSIX-only `join` on a Windows host
// would be worse than a stack trace.
export const join = nope('join')
export const resolve = nope('resolve')
export const dirname = nope('dirname')
export const basename = nope('basename')
export const extname = nope('extname')
export const relative = nope('relative')
export const normalize = nope('normalize')
export const isAbsolute = nope('isAbsolute')
export const sep = '/'
export const delimiter = ':'

const pathApi = { join, resolve, dirname, basename, extname, relative, normalize, isAbsolute }
/** `path.posix.join` / `path.win32.join` — reached through the namespace import. */
export const posix = { ...pathApi, sep: '/', delimiter: ':' }
export const win32 = { ...pathApi, sep: '\\', delimiter: ';' }

// --- node:os ---------------------------------------------------------------
export const homedir = nope('homedir')
export const tmpdir = nope('tmpdir')
export const platform = nope('platform')
export const arch = nope('arch')
export const hostname = nope('hostname')
export const userInfo = nope('userInfo')
export const EOL = '\n'

// --- node:crypto -----------------------------------------------------------
export const createHash = nope('createHash')
export const createCipheriv = nope('createCipheriv')
export const createDecipheriv = nope('createDecipheriv')
export const randomBytes = nope('randomBytes')
export const randomUUID = nope('randomUUID')
export const scrypt = nope('scrypt')
export const timingSafeEqual = nope('timingSafeEqual')

// --- node:util -------------------------------------------------------------
/**
 * Shaped, not implemented. `platform/secrets.ts` calls `promisify(scrypt)` at
 * module scope, so this must return a function rather than throw during import
 * — otherwise the whole adapter graph fails to load and the app shows nothing
 * instead of showing the inventory.
 */
export function promisify(fn: unknown): (...args: unknown[]) => Promise<never> {
  void fn
  return () => Promise.reject(new Error('promisify() stub: no Node APIs in the browser.'))
}

// --- node:child_process ----------------------------------------------------
export const spawn = nope('spawn')
export const spawnSync = nope('spawnSync')
export const execFile = nope('execFile')

export default {
  promises,
  promisify,
  sep,
  delimiter,
  EOL,
  constants,
}
