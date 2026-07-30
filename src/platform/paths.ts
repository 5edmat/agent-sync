/**
 * Portable relative-path validation.
 *
 * A skill named `aux/` or `notes.` is perfectly legal on macOS and Linux and
 * literally cannot be created on Windows. A repo containing both `Foo/` and
 * `foo/` clones fine on Linux and silently merges (or errors) on macOS/Windows.
 * Both classes of problem must be caught on the *authoring* host, before the
 * config is published to the control plane — by the time a Windows device
 * fails to apply, the bad name is already in everyone's config.
 *
 * Everything here is pure. OS-specific behavior is driven by an injected
 * `HostEnv` slice, so Windows rules are fully unit-testable from macOS.
 */

import type { HostEnv } from '../core/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PathIssueCode =
  | 'empty'
  | 'absolute'
  | 'drive-letter'
  | 'unc-path'
  | 'backslash-separator'
  | 'traversal'
  | 'dot-segment'
  | 'empty-segment'
  | 'reserved-name'
  | 'trailing-dot'
  | 'trailing-space'
  | 'leading-space'
  | 'illegal-char'
  | 'control-char'
  | 'segment-too-long'
  | 'path-too-long'
  | 'non-nfc'
  | 'case-collision'

export type PathIssueSeverity = 'error' | 'warning'

export interface PathIssue {
  code: PathIssueCode
  severity: PathIssueSeverity
  message: string
  /** The offending path segment, when the issue is segment-local. */
  segment?: string
  /** Index of the offending segment within the path. */
  segmentIndex?: number
}

export interface PathValidationResult {
  ok: boolean
  /** Slash-separated, Unicode-NFC form. Empty string when the input is unusable. */
  normalized: string
  issues: PathIssue[]
  errors: PathIssue[]
  warnings: PathIssue[]
}

export type HostPathSlice = Pick<HostEnv, 'os' | 'supportsLongPaths'>

export interface ValidatePortablePathOptions {
  /**
   * Host the path must be legal on. Omit to validate against the *union* of
   * all supported OSes — which is what you want when authoring config that
   * will sync to unknown devices. This is the default and it is strict.
   */
  host?: HostPathSlice
  /**
   * Deepest root the path will be joined onto, e.g.
   * `C:\Users\some-long-name\AppData\Roaming\Claude`. Enables MAX_PATH checks.
   */
  root?: string
  /** Override the platform limit. Default 259 usable chars (MAX_PATH 260 incl. NUL). */
  maxPathLength?: number
  /** Per-component byte/char limit. Default 255 (NTFS, ext4, APFS all agree). */
  maxSegmentLength?: number
  /** Treat `\` as a separator instead of an illegal character. Default false. */
  allowBackslashSeparator?: boolean
  /** Permit a leading `./`. Default false. */
  allowDotSegments?: boolean
}

// ---------------------------------------------------------------------------
// Windows name rules
// ---------------------------------------------------------------------------

/**
 * DOS device names. Reserved with *any* extension and in *any* case:
 * `CON`, `con.txt`, `CoN.tar.gz` all fail. `CONIN$`/`CONOUT$` are reserved too.
 * Note COM0/LPT0 are NOT reserved on modern Windows, but COM¹/COM²/COM³
 * (superscript digits) ARE — Windows maps them to COM1/2/3.
 */
export const WINDOWS_RESERVED_NAMES: readonly string[] = Object.freeze([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

const RESERVED_SET = new Set(WINDOWS_RESERVED_NAMES)

/** Superscript ¹²³ are folded to 1/2/3 by the Win32 name parser. */
const SUPERSCRIPT_DIGITS: Record<string, string> = { '\u00b9': '1', '\u00b2': '2', '\u00b3': '3' }

/** `< > : " | ? *` plus `/` and `\`. Legal on POSIX, fatal on NTFS. */
export const NTFS_ILLEGAL_CHARS: readonly string[] = Object.freeze(['<', '>', ':', '"', '|', '?', '*'])

const NTFS_ILLEGAL_RE = /[<>:"|?*]/
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

// Separate global copies for `replace()`. Sharing one `/g` regex with `test()`
// would carry `lastIndex` across calls and make detection non-deterministic —
// the classic every-other-call-returns-false bug.
const NTFS_ILLEGAL_RE_G = new RegExp(NTFS_ILLEGAL_RE.source, 'g')
const CONTROL_CHAR_RE_G = new RegExp(CONTROL_CHAR_RE.source, 'g')

const DRIVE_LETTER_RE = /^[a-zA-Z]:/
const WINDOWS_MAX_PATH_USABLE = 259 // MAX_PATH is 260 *including* the NUL

/**
 * Is `segment` a Windows reserved device name?
 * Strips the extension and folds superscript digits before comparing.
 */
export function isWindowsReservedName(segment: string): boolean {
  if (segment.length === 0) return false
  // Trailing dots/spaces are stripped by Win32 before the name is resolved,
  // so `CON.` and `CON ` also hit the device.
  const stripped = segment.replace(/[. ]+$/, '')
  // `CON.txt` -> `CON`. Only the first extension boundary matters.
  const dot = stripped.indexOf('.')
  const base = dot === -1 ? stripped : stripped.slice(0, dot)
  const folded = base.replace(/[\u00b9\u00b2\u00b3]/g, (c) => SUPERSCRIPT_DIGITS[c] ?? c)
  return RESERVED_SET.has(folded.toUpperCase())
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function issue(
  code: PathIssueCode,
  severity: PathIssueSeverity,
  message: string,
  segment?: string,
  segmentIndex?: number,
): PathIssue {
  const i: PathIssue = { code, severity, message }
  if (segment !== undefined) i.segment = segment
  if (segmentIndex !== undefined) i.segmentIndex = segmentIndex
  return i
}

function finish(normalized: string, issues: PathIssue[]): PathValidationResult {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return { ok: errors.length === 0, normalized, issues, errors, warnings }
}

/**
 * Validate a *relative* path for portability across macOS, Linux, WSL and
 * Windows. Returns every problem found rather than throwing on the first —
 * the CLI shows all of them at once.
 */
export function validatePortablePath(
  relPath: string,
  options: ValidatePortablePathOptions = {},
): PathValidationResult {
  const {
    host,
    root,
    maxPathLength,
    maxSegmentLength = 255,
    allowBackslashSeparator = false,
    allowDotSegments = false,
  } = options

  // No host => validate against the strictest union of all targets.
  const applyWindowsRules = host === undefined || host.os === 'windows'

  const issues: PathIssue[] = []

  if (typeof relPath !== 'string' || relPath.length === 0) {
    issues.push(issue('empty', 'error', 'path is empty'))
    return finish('', issues)
  }

  // Unicode: macOS (APFS/HFS+) hands back NFD, Linux stores bytes verbatim,
  // Windows stores NFC-ish. Normalize for comparison, warn on the mismatch.
  const nfc = relPath.normalize('NFC')
  if (nfc !== relPath) {
    issues.push(
      issue(
        'non-nfc',
        'warning',
        'path is not Unicode NFC; macOS returns NFD from readdir and the same name will compare unequal on Linux',
      ),
    )
  }

  let working = nfc

  if (working.includes('\\')) {
    if (allowBackslashSeparator) {
      working = working.replace(/\\/g, '/')
    } else {
      issues.push(
        issue(
          'backslash-separator',
          'error',
          'contains a backslash; use `/` as the separator in portable paths (a literal `\\` is illegal on NTFS)',
        ),
      )
      working = working.replace(/\\/g, '/')
    }
  }

  if (working.startsWith('//')) {
    issues.push(issue('unc-path', 'error', 'UNC path is not a portable relative path'))
  } else if (working.startsWith('/')) {
    issues.push(issue('absolute', 'error', 'path is absolute; a portable path must be relative'))
  }
  if (DRIVE_LETTER_RE.test(working)) {
    issues.push(issue('drive-letter', 'error', 'path carries a Windows drive letter; must be relative'))
  }

  const segments = working.split('/')

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1

    if (segment.length === 0) {
      // A single trailing slash (dir marker) is tolerated; anything else is an
      // empty segment, which collapses differently across path libraries.
      if (isLast && index > 0) return
      if (index === 0 && working.startsWith('/')) return // already reported as absolute
      issues.push(issue('empty-segment', 'error', 'contains an empty path segment (`//`)', segment, index))
      return
    }

    if (segment === '..') {
      issues.push(
        issue('traversal', 'error', '`..` escapes the config root and is never allowed', segment, index),
      )
      return
    }
    if (segment === '.') {
      if (!allowDotSegments) {
        issues.push(issue('dot-segment', 'error', '`.` segment is not allowed in a normalized path', segment, index))
      }
      return
    }

    if (CONTROL_CHAR_RE.test(segment)) {
      issues.push(
        issue('control-char', 'error', 'contains a control character (illegal on NTFS)', segment, index),
      )
    }

    if (applyWindowsRules) {
      if (NTFS_ILLEGAL_RE.test(segment)) {
        const bad = [...new Set([...segment].filter((c) => NTFS_ILLEGAL_RE.test(c)))].join(' ')
        issues.push(
          issue('illegal-char', 'error', `contains character(s) illegal on NTFS: ${bad}`, segment, index),
        )
      }
      if (isWindowsReservedName(segment)) {
        issues.push(
          issue(
            'reserved-name',
            'error',
            `\`${segment}\` is a Windows reserved device name (reserved with any extension and in any case)`,
            segment,
            index,
          ),
        )
      }
      if (segment.endsWith('.')) {
        issues.push(
          issue(
            'trailing-dot',
            'error',
            'ends with `.`; Win32 silently strips it, so the file resolves to a different name',
            segment,
            index,
          ),
        )
      }
      if (segment.endsWith(' ')) {
        issues.push(
          issue(
            'trailing-space',
            'error',
            'ends with a space; Win32 silently strips it, so the file resolves to a different name',
            segment,
            index,
          ),
        )
      }
      if (segment.startsWith(' ')) {
        issues.push(
          issue('leading-space', 'warning', 'starts with a space; survives but is a usability trap', segment, index),
        )
      }
    }

    if (segment.length > maxSegmentLength) {
      issues.push(
        issue(
          'segment-too-long',
          'error',
          `segment is ${segment.length} characters; the limit is ${maxSegmentLength}`,
          segment,
          index,
        ),
      )
    }
  })

  const normalized = segments.filter((s, i) => s.length > 0 || i === 0).join('/')

  const lengthOptions: PathLengthOptions = {}
  if (host !== undefined) lengthOptions.host = host
  if (root !== undefined) lengthOptions.root = root
  if (maxPathLength !== undefined) lengthOptions.maxPathLength = maxPathLength

  const lengthIssue = checkPathLength(normalized, lengthOptions)
  if (lengthIssue) issues.push(lengthIssue)

  return finish(normalized, issues)
}

// ---------------------------------------------------------------------------
// MAX_PATH
// ---------------------------------------------------------------------------

export interface PathLengthOptions {
  host?: HostPathSlice
  root?: string
  maxPathLength?: number
}

/**
 * Windows fails at 260 chars (`MAX_PATH`, including the NUL) unless long paths
 * are enabled *and* the process manifest opts in. Node 20+ ships the manifest,
 * but the registry key is off by default on most machines, so we gate on
 * `host.supportsLongPaths`.
 *
 * Note the check is on the *joined* path: `.claude/skills/x` is 17 chars, but
 * under `C:\Users\a.very.long.corporate.name\AppData\Roaming\...` it is not.
 */
export function checkPathLength(relPath: string, options: PathLengthOptions = {}): PathIssue | null {
  const { host, root, maxPathLength } = options
  // Absent a host we assume the strictest target (Windows, long paths off).
  const isWindowsTarget = host === undefined || host.os === 'windows'
  const longPathsOn = host !== undefined && host.supportsLongPaths
  if (!isWindowsTarget) return null

  const limit = maxPathLength ?? WINDOWS_MAX_PATH_USABLE
  const joined = joinForLengthCheck(root, relPath)

  if (joined.length <= limit) return null

  if (longPathsOn) {
    return issue(
      'path-too-long',
      'warning',
      `joined path is ${joined.length} chars (> ${limit}); this host has long paths enabled, but tools that use the ANSI Win32 API or lack a long-path manifest will still fail`,
    )
  }
  return issue(
    'path-too-long',
    'error',
    `joined path is ${joined.length} chars, over the Windows MAX_PATH limit of ${limit}; enable long paths or shorten the path`,
  )
}

function joinForLengthCheck(root: string | undefined, relPath: string): string {
  if (!root) return relPath
  const sep = root.includes('\\') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  const rel = sep === '\\' ? relPath.replace(/\//g, '\\') : relPath
  return `${trimmed}${sep}${rel}`
}

// ---------------------------------------------------------------------------
// Case + Unicode collisions
// ---------------------------------------------------------------------------

export interface CaseCollision {
  /**
   * Lowercased path of the colliding node, e.g. `skills/foo`. This is the
   * directory or file that exists twice once the set lands on a
   * case-insensitive filesystem.
   */
  key: string
  /** Distinct on-disk spellings that fold to `key`. Always length >= 2. */
  variants: string[]
  /** Input paths that contributed each variant, in input order. */
  paths: string[]
  /** `case` for A/a, `unicode` when only NFC/NFD normalization differs. */
  reason: 'case' | 'unicode'
}

interface TreeNode {
  /** foldedSegment -> (originalSegment -> node) */
  children: Map<string, Map<string, TreeNode>>
  /** input paths whose walk passed through this node */
  paths: Set<string>
}

function newNode(): TreeNode {
  return { children: new Map(), paths: new Set() }
}

/**
 * Case-fold the way a case-insensitive filesystem does, near enough.
 *
 * Caveat worth knowing: this is *not* exactly NTFS's fold (which uses a frozen
 * Unicode 6 uppercase table) nor APFS's (which uses its own normalization
 * table). Divergence only shows up in exotic scripts; for ASCII and Latin-1 —
 * which is every real skill/agent name — the three agree.
 */
function fold(segment: string): string {
  return segment.normalize('NFC').toLowerCase()
}

/**
 * Find names within the same directory that collide once the set is checked
 * out on a case-insensitive filesystem (APFS default, NTFS default).
 *
 * Detects the directory-level case: `Foo/a.md` and `foo/b.md` are two distinct
 * full paths that collide at the `Foo` vs `foo` *directory*, so a naive
 * "lowercase the whole path and look for duplicates" misses it entirely.
 */
export function detectCaseCollisions(paths: readonly string[]): CaseCollision[] {
  const root = newNode()

  for (const original of paths) {
    const segments = original
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s.length > 0 && s !== '.')

    let node = root
    for (const segment of segments) {
      const folded = fold(segment)
      let bucket = node.children.get(folded)
      if (!bucket) {
        bucket = new Map()
        node.children.set(folded, bucket)
      }
      let child = bucket.get(segment)
      if (!child) {
        child = newNode()
        bucket.set(segment, child)
      }
      child.paths.add(original)
      node = child
    }
  }

  const collisions: CaseCollision[] = []

  const walk = (node: TreeNode, prefix: string): void => {
    for (const [folded, bucket] of node.children) {
      const key = prefix ? `${prefix}/${folded}` : folded
      if (bucket.size > 1) {
        const variants = [...bucket.keys()]
        const involved: string[] = []
        for (const child of bucket.values()) for (const p of child.paths) involved.push(p)
        // If the variants are already identical once NFC-normalized, the only
        // difference is Unicode composition (macOS hands back NFD from
        // readdir, Linux stores whatever bytes were written) — not case.
        const nfcForms = new Set(variants.map((v) => v.normalize('NFC')))
        collisions.push({
          key,
          variants,
          paths: [...new Set(involved)],
          reason: nfcForms.size === 1 ? 'unicode' : 'case',
        })
      }
      for (const child of bucket.values()) walk(child, key)
    }
  }

  walk(root, '')
  return collisions
}

// ---------------------------------------------------------------------------
// Set-level validation
// ---------------------------------------------------------------------------

export interface PathSetValidationResult {
  ok: boolean
  /** Per-path results, keyed by the original input string. */
  perPath: Map<string, PathValidationResult>
  collisions: CaseCollision[]
  errors: string[]
}

/**
 * Validate a whole directory set at once: every path individually, plus the
 * cross-path collisions that only exist in aggregate.
 */
export function validatePathSet(
  paths: readonly string[],
  options: ValidatePortablePathOptions = {},
): PathSetValidationResult {
  const perPath = new Map<string, PathValidationResult>()
  const errors: string[] = []

  for (const p of paths) {
    const result = validatePortablePath(p, options)
    perPath.set(p, result)
    for (const e of result.errors) errors.push(`${p}: ${e.message}`)
  }

  const collisions = detectCaseCollisions(paths)
  for (const c of collisions) {
    errors.push(
      c.reason === 'case'
        ? `${c.key}: case collision between ${c.variants.map((v) => `\`${v}\``).join(' and ')} — these are one entry on macOS/Windows`
        : `${c.key}: Unicode normalization collision between ${c.variants
            .map((v) => `\`${v}\``)
            .join(' and ')} — identical after NFC`,
    )
  }

  return { ok: errors.length === 0, perPath, collisions, errors }
}

/**
 * Best-effort rewrite of a name into something legal everywhere. Used to
 * *suggest* a fix in CLI output — never to silently rename a user's file.
 */
export function suggestPortableName(segment: string): string {
  let out = segment.normalize('NFC')
  out = out.replace(NTFS_ILLEGAL_RE_G, '-')
  out = out.replace(CONTROL_CHAR_RE_G, '')
  out = out.replace(/[. ]+$/, '')
  if (out.length === 0) out = 'unnamed'
  if (isWindowsReservedName(out)) out = `${out}_`
  return out.slice(0, 255)
}
