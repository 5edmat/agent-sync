/**
 * Format-preserving JSONC.
 *
 * Every tool we sync (Claude Code, Cursor, Zed) accepts comments and trailing
 * commas in its settings files, and developers annotate those files heavily —
 * "// do not enable this, it breaks the sandbox" is load-bearing documentation.
 * Parsing to JS, mutating, and re-serializing throws all of that away on the
 * first write. That is not a formatting nit; it is destroying user data we were
 * never asked to touch.
 *
 * So writes here are SURGICAL: we build a concrete syntax tree that remembers
 * where every token starts and ends, and an edit replaces only the byte span of
 * the value that actually changed. Every other byte of the file — comments,
 * indentation, key order, trailing commas, CRLF, the BOM — comes out identical
 * because it is never rewritten in the first place.
 *
 * Deliberate non-goals:
 *  - This is not a JSON5 implementation. Unquoted keys, hex numbers and the
 *    like are rejected rather than half-supported. Single-quoted strings are
 *    the one exception: they are read, and `detectStyle` reports them, because
 *    a file that uses them must not be silently rewritten to double quotes.
 *  - Array elements are not addressable. Dot paths mirror `getPath` in
 *    `core/reconcile.ts`, where arrays are leaves; replacing element 3 of an
 *    array is not a thing the reconcile engine can ask for.
 *
 * Offsets are UTF-16 code unit indices into the input string (what
 * `String#slice` takes), not UTF-8 byte offsets. Astral-plane characters count
 * as two. Everything here slices the same string it parsed, so the distinction
 * never leaks — but it matters if you hand these offsets to something that
 * works in bytes.
 */

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export type JsoncNodeType =
  | 'document'
  | 'object'
  | 'array'
  | 'property'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'

export interface JsoncComment {
  kind: 'line' | 'block'
  offset: number
  length: number
  /** Raw source, delimiters included. */
  text: string
}

export interface JsoncNode {
  type: JsoncNodeType
  /** Start index. For a property this is the start of its KEY, not its value. */
  offset: number
  /**
   * Extent, so `offset + length` is the exclusive end. Leading and trailing
   * comments are NOT part of the span: an edit that replaces a value's span
   * must not be able to swallow a comment that merely sits next to it.
   */
  length: number
  /** Materialized JS value. Objects and arrays include their contents. */
  value?: unknown
  /**
   * object -> property nodes, array -> element nodes,
   * property -> [key, value], document -> [root] (empty for an empty file).
   */
  children?: JsoncNode[]
  /** Decoded key. Properties only. */
  key?: string
  keyNode?: JsoncNode
  valueNode?: JsoncNode
  /**
   * Comments preceding this node that are not a previous sibling's trailing
   * comment. A comment on the line above a key belongs to that key — deleting
   * the key takes the comment with it, so we never orphan a note about a
   * setting that no longer exists.
   */
  leadingComments?: JsoncComment[]
  /** A comment on the same line, after this node (and after its comma). */
  trailingComment?: JsoncComment
  /** Comments inside a container that follow its last member. */
  innerComments?: JsoncComment[]
  /** Offset of the separator comma after this member, including a trailing one. */
  commaOffset?: number
}

export class JsoncError extends Error {
  readonly offset: number
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`)
    this.name = 'JsoncError'
    this.offset = offset
  }
}

/** Exclusive end of a node's span. */
export function nodeEnd(node: JsoncNode): number {
  return node.offset + node.length
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type TokenKind =
  | 'brace-open'
  | 'brace-close'
  | 'bracket-open'
  | 'bracket-close'
  | 'colon'
  | 'comma'
  | 'string'
  | 'number'
  | 'literal'
  | 'line-comment'
  | 'block-comment'
  | 'whitespace'
  | 'bom'

export interface Token {
  kind: TokenKind
  offset: number
  length: number
}

const PUNCT: Readonly<Record<string, TokenKind>> = {
  '{': 'brace-open',
  '}': 'brace-close',
  '[': 'bracket-open',
  ']': 'bracket-close',
  ':': 'colon',
  ',': 'comma',
}

function isWhitespace(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f' ||
    ch === '\v' ||
    ch === '\u00a0' ||
    ch === '\ufeff'
  )
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'

/**
 * Full-fidelity token stream: whitespace and comments are tokens too, so the
 * concatenated tokens reconstruct the input exactly. A leading BOM is its own
 * token rather than whitespace, because it must survive a round trip and it is
 * the only place U+FEFF is not data.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = []
  let i = 0

  if (text.charCodeAt(0) === 0xfeff) {
    out.push({ kind: 'bom', offset: 0, length: 1 })
    i = 1
  }

  while (i < text.length) {
    const start = i
    const ch = text[i] as string

    if (isWhitespace(ch)) {
      while (i < text.length && isWhitespace(text[i] as string)) i++
      out.push({ kind: 'whitespace', offset: start, length: i - start })
      continue
    }

    if (ch === '/') {
      const next = text[i + 1]
      if (next === '/') {
        i += 2
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
        out.push({ kind: 'line-comment', offset: start, length: i - start })
        continue
      }
      if (next === '*') {
        i += 2
        let closed = false
        while (i < text.length) {
          if (text[i] === '*' && text[i + 1] === '/') {
            i += 2
            closed = true
            break
          }
          i++
        }
        if (!closed) throw new JsoncError('unterminated block comment', start)
        out.push({ kind: 'block-comment', offset: start, length: i - start })
        continue
      }
      throw new JsoncError('unexpected "/" — expected "//" or "/*"', start)
    }

    const punct = PUNCT[ch]
    if (punct) {
      i++
      out.push({ kind: punct, offset: start, length: 1 })
      continue
    }

    if (ch === '"' || ch === "'") {
      i = scanString(text, start)
      out.push({ kind: 'string', offset: start, length: i - start })
      continue
    }

    if (ch === '-' || isDigit(ch)) {
      i = scanNumber(text, start)
      out.push({ kind: 'number', offset: start, length: i - start })
      continue
    }

    if (ch >= 'a' && ch <= 'z') {
      while (i < text.length && (text[i] as string) >= 'a' && (text[i] as string) <= 'z') i++
      const word = text.slice(start, i)
      if (word !== 'true' && word !== 'false' && word !== 'null') {
        throw new JsoncError(`unexpected token "${word}"`, start)
      }
      out.push({ kind: 'literal', offset: start, length: i - start })
      continue
    }

    throw new JsoncError(`unexpected character ${JSON.stringify(ch)}`, start)
  }

  return out
}

function scanString(text: string, start: number): number {
  const quote = text[start] as string
  let i = start + 1
  while (i < text.length) {
    const c = text[i] as string
    if (c === '\\') {
      if (i + 1 >= text.length) break
      i += 2
      continue
    }
    if (c === quote) return i + 1
    if (c === '\n' || c === '\r') break
    i++
  }
  throw new JsoncError('unterminated string', start)
}

function scanNumber(text: string, start: number): number {
  let i = start
  if (text[i] === '-') i++
  if (!isDigit(text[i] ?? '')) throw new JsoncError('invalid number', start)
  while (isDigit(text[i] ?? '')) i++
  if (text[i] === '.') {
    i++
    if (!isDigit(text[i] ?? '')) throw new JsoncError('invalid number', start)
    while (isDigit(text[i] ?? '')) i++
  }
  const e = text[i]
  if (e === 'e' || e === 'E') {
    i++
    const sign = text[i]
    if (sign === '+' || sign === '-') i++
    if (!isDigit(text[i] ?? '')) throw new JsoncError('invalid number', start)
    while (isDigit(text[i] ?? '')) i++
  }
  return i
}

/** Decode a raw quoted string token (delimiters included). */
export function decodeString(raw: string, offset = 0): string {
  const body = raw.slice(1, -1)
  if (!body.includes('\\')) return body

  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    if (c !== '\\') {
      out += c
      continue
    }
    const e = body[++i]
    switch (e) {
      case '"':
        out += '"'
        break
      case "'":
        out += "'"
        break
      case '\\':
        out += '\\'
        break
      case '/':
        out += '/'
        break
      case 'b':
        out += '\b'
        break
      case 'f':
        out += '\f'
        break
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\r'
        break
      case 't':
        out += '\t'
        break
      case 'u': {
        const hex = body.slice(i + 1, i + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JsoncError('invalid \\u escape', offset + i)
        }
        // Surrogate pairs come through as two consecutive \u escapes and
        // recombine naturally here — fromCharCode works on code units.
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
        break
      }
      default:
        throw new JsoncError(`invalid escape "\\${String(e ?? '')}"`, offset + i)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function toComment(text: string, t: Token): JsoncComment {
  return {
    kind: t.kind === 'line-comment' ? 'line' : 'block',
    offset: t.offset,
    length: t.length,
    text: text.slice(t.offset, t.offset + t.length),
  }
}

/**
 * Parse into a CST. Throws `JsoncError` on malformed input rather than
 * guessing: a caller that cannot parse a file must not then rewrite it.
 */
export function parseTree(text: string): JsoncNode {
  const tokens = tokenize(text)
  let i = 0
  let pending: JsoncComment[] = []

  const peek = (): Token | undefined => tokens[i]

  /** Consume whitespace/BOM, buffering any comments for the next node. */
  function trivia(): void {
    while (i < tokens.length) {
      const t = tokens[i] as Token
      if (t.kind === 'whitespace' || t.kind === 'bom') {
        i++
        continue
      }
      if (t.kind === 'line-comment' || t.kind === 'block-comment') {
        pending.push(toComment(text, t))
        i++
        continue
      }
      return
    }
  }

  function take(): JsoncComment[] {
    const p = pending
    pending = []
    return p
  }

  /**
   * A buffered comment that starts on the same line the previous member ended
   * on is that member's trailing comment, not the next member's leading one.
   */
  function claimTrailing(prev: JsoncNode | undefined): void {
    if (!prev || prev.trailingComment) return
    const first = pending[0]
    if (!first) return
    const from = prev.commaOffset !== undefined ? prev.commaOffset + 1 : nodeEnd(prev)
    if (from > first.offset) return
    if (text.slice(from, first.offset).includes('\n')) return
    prev.trailingComment = first
    pending.shift()
  }

  function expect(kind: TokenKind, what: string): Token {
    trivia()
    const t = peek()
    if (!t || t.kind !== kind) {
      throw new JsoncError(`expected ${what}`, t ? t.offset : text.length)
    }
    i++
    return t
  }

  function parseObject(lead: JsoncComment[]): JsoncNode {
    const open = expect('brace-open', '"{"')
    const children: JsoncNode[] = []
    let prev: JsoncNode | undefined
    let needSeparator = false
    let close: Token | undefined

    for (;;) {
      trivia()
      claimTrailing(prev)
      const t = peek()
      if (!t) throw new JsoncError('unterminated object', open.offset)

      if (t.kind === 'brace-close') {
        i++
        close = t
        break
      }
      if (t.kind === 'comma') {
        if (!prev || !needSeparator) throw new JsoncError('unexpected ","', t.offset)
        prev.commaOffset = t.offset
        needSeparator = false
        i++
        continue
      }
      if (needSeparator) throw new JsoncError('expected "," between properties', t.offset)

      const prop = parseProperty(take())
      children.push(prop)
      prev = prop
      needSeparator = true
    }

    if (!close) throw new JsoncError('unterminated object', open.offset)
    const inner = take()
    return {
      type: 'object',
      offset: open.offset,
      length: close.offset + 1 - open.offset,
      children,
      value: materializeObject(children),
      ...(lead.length ? { leadingComments: lead } : {}),
      ...(inner.length ? { innerComments: inner } : {}),
    }
  }

  function parseProperty(lead: JsoncComment[]): JsoncNode {
    trivia()
    const keyTok = peek()
    if (!keyTok || keyTok.kind !== 'string') {
      throw new JsoncError('expected a quoted property name', keyTok ? keyTok.offset : text.length)
    }
    i++
    const raw = text.slice(keyTok.offset, keyTok.offset + keyTok.length)
    const keyNode: JsoncNode = {
      type: 'string',
      offset: keyTok.offset,
      length: keyTok.length,
      value: decodeString(raw, keyTok.offset),
    }

    expect('colon', '":" after property name')
    trivia()
    // Anything buffered here sits between the key and the value; it stays
    // inside the property's span, so a value edit steps around it.
    const value = parseValue(take())

    return {
      type: 'property',
      offset: keyNode.offset,
      length: nodeEnd(value) - keyNode.offset,
      key: keyNode.value as string,
      keyNode,
      valueNode: value,
      children: [keyNode, value],
      value: value.value,
      ...(lead.length ? { leadingComments: lead } : {}),
    }
  }

  function parseArray(lead: JsoncComment[]): JsoncNode {
    const open = expect('bracket-open', '"["')
    const children: JsoncNode[] = []
    let prev: JsoncNode | undefined
    let needSeparator = false
    let close: Token | undefined

    for (;;) {
      trivia()
      claimTrailing(prev)
      const t = peek()
      if (!t) throw new JsoncError('unterminated array', open.offset)

      if (t.kind === 'bracket-close') {
        i++
        close = t
        break
      }
      if (t.kind === 'comma') {
        if (!prev || !needSeparator) throw new JsoncError('unexpected ","', t.offset)
        prev.commaOffset = t.offset
        needSeparator = false
        i++
        continue
      }
      if (needSeparator) throw new JsoncError('expected "," between array elements', t.offset)

      const el = parseValue(take())
      children.push(el)
      prev = el
      needSeparator = true
    }

    if (!close) throw new JsoncError('unterminated array', open.offset)
    const inner = take()
    return {
      type: 'array',
      offset: open.offset,
      length: close.offset + 1 - open.offset,
      children,
      value: children.map((c) => c.value),
      ...(lead.length ? { leadingComments: lead } : {}),
      ...(inner.length ? { innerComments: inner } : {}),
    }
  }

  function parseValue(lead: JsoncComment[]): JsoncNode {
    trivia()
    const t = peek()
    if (!t) throw new JsoncError('expected a value', text.length)

    switch (t.kind) {
      case 'brace-open':
        return parseObject(lead)
      case 'bracket-open':
        return parseArray(lead)
      case 'string': {
        i++
        const raw = text.slice(t.offset, t.offset + t.length)
        return {
          type: 'string',
          offset: t.offset,
          length: t.length,
          value: decodeString(raw, t.offset),
          ...(lead.length ? { leadingComments: lead } : {}),
        }
      }
      case 'number': {
        i++
        return {
          type: 'number',
          offset: t.offset,
          length: t.length,
          value: Number(text.slice(t.offset, t.offset + t.length)),
          ...(lead.length ? { leadingComments: lead } : {}),
        }
      }
      case 'literal': {
        i++
        const word = text.slice(t.offset, t.offset + t.length)
        return {
          type: word === 'null' ? 'null' : 'boolean',
          offset: t.offset,
          length: t.length,
          value: word === 'null' ? null : word === 'true',
          ...(lead.length ? { leadingComments: lead } : {}),
        }
      }
      default:
        throw new JsoncError('expected a value', t.offset)
    }
  }

  // -- document ------------------------------------------------------------
  trivia()
  if (i >= tokens.length) {
    // Empty (or comments-only) file. Not an error: it is the state every
    // config file starts in, and inserting into it must work.
    const lead = take()
    return {
      type: 'document',
      offset: 0,
      length: text.length,
      children: [],
      ...(lead.length ? { leadingComments: lead } : {}),
    }
  }

  const root = parseValue(take())
  trivia()
  const trailing = take()
  if (i < tokens.length) {
    const t = tokens[i] as Token
    throw new JsoncError('unexpected content after the top-level value', t.offset)
  }

  return {
    type: 'document',
    offset: 0,
    length: text.length,
    children: [root],
    value: root.value,
    ...(trailing.length ? { innerComments: trailing } : {}),
  }
}

function materializeObject(props: readonly JsoncNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // Last duplicate wins, matching JSON.parse.
  for (const p of props) if (p.key !== undefined) out[p.key] = p.value
  return out
}

/** Tolerant `JSON.parse`: comments and trailing commas are accepted. */
export function parseJsonc(text: string): unknown {
  return parseTree(text).value
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** The root VALUE node of a document (or the node itself, if handed one). */
export function rootValue(tree: JsoncNode): JsoncNode | undefined {
  return tree.type === 'document' ? tree.children?.[0] : tree
}

function findProperty(obj: JsoncNode, key: string): JsoncNode | undefined {
  const kids = obj.children
  if (!kids) return undefined
  // Backwards, so duplicate keys resolve to the same one JSON.parse would.
  for (let n = kids.length - 1; n >= 0; n--) {
    const p = kids[n]
    if (p?.key === key) return p
  }
  return undefined
}

/**
 * Resolve a dot path, with exactly the semantics of `getPath` in
 * `core/reconcile.ts`: `''` is the document root, segments only descend into
 * objects, and arrays are leaves. Returns the VALUE node.
 *
 * A key containing a literal `.` is unaddressable — same limitation as the
 * reconcile engine, deliberately, so a path means one thing everywhere.
 */
export function getNodeAtPath(tree: JsoncNode, path: string): JsoncNode | undefined {
  let node = rootValue(tree)
  if (!node) return undefined
  if (path === '') return node

  for (const seg of path.split('.')) {
    if (node.type !== 'object') return undefined
    const prop = findProperty(node, seg)
    if (!prop?.valueNode) return undefined
    node = prop.valueNode
  }
  return node
}

/** The property node (key + value) at a dot path. `''` has no property node. */
export function getPropertyAtPath(tree: JsoncNode, path: string): JsoncNode | undefined {
  if (path === '') return undefined
  const segs = path.split('.')
  const last = segs.pop() as string
  const parent = getNodeAtPath(tree, segs.join('.'))
  if (!parent || parent.type !== 'object') return undefined
  return findProperty(parent, last)
}

// ---------------------------------------------------------------------------
// Style detection
// ---------------------------------------------------------------------------

export interface JsoncStyle {
  /** Indent width per level: spaces, or tabs when `useTabs`. */
  indent: number
  useTabs: boolean
  /** True when some container already ends its last member with a comma. */
  trailingComma: boolean
  eol: '\n' | '\r\n'
  finalNewline: boolean
  /** JSONC only permits `"`; `'` is reported so we never rewrite a JSON5 file. */
  quoteStyle: 'double' | 'single'
}

const DEFAULT_STYLE: JsoncStyle = {
  indent: 2,
  useTabs: false,
  trailingComma: false,
  eol: '\n',
  finalNewline: true,
  quoteStyle: 'double',
}

export function indentUnit(style: JsoncStyle): string {
  return style.useTabs ? '\t'.repeat(Math.max(1, style.indent)) : ' '.repeat(Math.max(0, style.indent))
}

function countOccurrences(text: string, needle: string): number {
  let n = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return n
    n++
    from = at + needle.length
  }
}

/**
 * Infer the file's own conventions so anything we insert looks like it was
 * always there. Inference is from the token stream rather than line regexes:
 * the interior of a block comment is not indentation, and a `,` inside a string
 * is not a trailing comma.
 */
export function detectStyle(text: string): JsoncStyle {
  if (text.length === 0) return { ...DEFAULT_STYLE }

  const crlf = countOccurrences(text, '\r\n')
  const lines = countOccurrences(text, '\n')
  const eol: '\n' | '\r\n' = crlf > 0 && crlf * 2 >= lines ? '\r\n' : '\n'
  const finalNewline = text.endsWith('\n')

  let indent = DEFAULT_STYLE.indent
  let useTabs = DEFAULT_STYLE.useTabs
  let quoteStyle: 'double' | 'single' = 'double'
  let trailingComma = false

  try {
    const tokens = tokenize(text)
    const prefixes: string[] = []
    let singles = 0
    let doubles = 0

    for (const t of tokens) {
      if (t.kind === 'whitespace' || t.kind === 'bom') continue
      if (t.kind === 'string') {
        if (text[t.offset] === "'") singles++
        else doubles++
      }
      // Only the first token on a line tells us anything about indentation.
      const lineStart = text.lastIndexOf('\n', Math.max(0, t.offset - 1)) + 1
      const prefix = text.slice(lineStart, t.offset)
      if (prefix.length && /^[ \t]+$/.test(prefix)) prefixes.push(prefix)
    }

    if (singles > doubles) quoteStyle = 'single'

    const tabbed = prefixes.filter((p) => p.startsWith('\t'))
    if (tabbed.length > prefixes.length - tabbed.length && tabbed.length > 0) {
      useTabs = true
      indent = Math.min(...tabbed.map((p) => p.replace(/[^\t]/g, '').length)) || 1
    } else {
      const spaced = prefixes.filter((p) => !p.includes('\t'))
      // One indent level is the smallest indent that appears — depth 1 is
      // always present in a file that has any indented line at all.
      if (spaced.length) indent = Math.min(...spaced.map((p) => p.length))
      if (indent <= 0) indent = DEFAULT_STYLE.indent
    }

    trailingComma = hasTrailingComma(parseTree(text))
  } catch {
    // Unparseable: fall back to defaults for the structural bits. The
    // line-ending and final-newline answers above are still trustworthy.
  }

  return { indent, useTabs, trailingComma, eol, finalNewline, quoteStyle }
}

function hasTrailingComma(node: JsoncNode): boolean {
  if (node.type === 'object' || node.type === 'array') {
    const kids = node.children ?? []
    const last = kids[kids.length - 1]
    if (last && last.commaOffset !== undefined) return true
  }
  for (const child of node.children ?? []) {
    if (hasTrailingComma(child)) return true
    if (child.valueNode && hasTrailingComma(child.valueNode)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Same ordering as `canonicalJson`: UTF-16 code unit, never `localeCompare`
 * (which depends on the machine's ICU data). Duplicated rather than imported
 * so this module stays free of Node built-ins and can run in the browser.
 */
function compareKeys(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function quoteString(s: string, style: JsoncStyle): string {
  const json = JSON.stringify(s)
  if (style.quoteStyle === 'double') return json
  return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
}

/**
 * Render a JS value as JSON text in the file's own style, indented as if it
 * started on a line indented by `baseIndent`.
 */
export function renderValue(value: unknown, style: JsoncStyle, baseIndent = ''): string {
  const unit = indentUnit(style)
  const eol = style.eol
  const inner = baseIndent + unit
  const tail = style.trailingComma ? ',' : ''

  value = unwrapToJson(value)
  if (value === null || value === undefined) return 'null'

  switch (typeof value) {
    case 'string':
      return quoteString(value, style)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new JsoncError(`non-finite number ${String(value)} cannot be written to JSON`, 0)
      }
      return Object.is(value, -0) ? '0' : String(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      throw new JsoncError('bigint cannot be written to JSON; use a string', 0)
    case 'function':
    case 'symbol':
      throw new JsoncError(`${typeof value} cannot be written to JSON`, 0)
    default:
      break
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((v) => inner + renderValue(v, style, inner))
    return `[${eol}${items.join(',' + eol)}${tail}${eol}${baseIndent}]`
  }

  const obj = value as Record<string, unknown>
  const keys = objectKeys(obj)
  if (keys.length === 0) return '{}'
  const parts = keys.map(
    (k) => `${inner}${quoteString(k, style)}: ${renderValue(obj[k], style, inner)}`,
  )
  return `{${eol}${parts.join(',' + eol)}${tail}${eol}${baseIndent}}`
}

/** Honor `toJSON` before anything else, exactly as `canonicalJson` does. */
function unwrapToJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return (value as { toJSON: () => unknown }).toJSON()
  }
  return value
}

function objectKeys(obj: Record<string, unknown>): string[] {
  // Sorted, like `canonicalJson`: two devices inserting the same key must
  // produce the same bytes, and insertion order is not something a plan carries.
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(compareKeys)
}

/**
 * One-line rendering, for inserting into a container the file itself keeps on
 * one line. Expanding `{"a":1}` to four lines because we added a key is not a
 * change the user asked for.
 */
function renderInline(value: unknown, style: JsoncStyle, colon: string, comma: string): string {
  value = unwrapToJson(value)
  if (value === null || value === undefined || typeof value !== 'object') {
    return renderValue(value, style)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.map((v) => renderInline(v, style, colon, comma)).join(',' + comma)}]`
  }
  const obj = value as Record<string, unknown>
  const keys = objectKeys(obj)
  if (keys.length === 0) return '{}'
  const parts = keys.map(
    (k) => `${quoteString(k, style)}:${colon}${renderInline(obj[k], style, colon, comma)}`,
  )
  return `{${parts.join(',' + comma)}}`
}

// ---------------------------------------------------------------------------
// Splices
// ---------------------------------------------------------------------------

interface Splice {
  offset: number
  length: number
  text: string
}

/**
 * Apply splices back-to-front. Every offset was computed against the original
 * text, so editing the tail first leaves every earlier offset still valid —
 * this is the whole reason `editMany` can work from a single parse.
 */
function applySplices(text: string, splices: readonly Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.offset - a.offset || b.length - a.length)
  let out = text
  for (const s of ordered) {
    out = out.slice(0, s.offset) + s.text + out.slice(s.offset + s.length)
  }
  return out
}

function overlaps(splices: readonly Splice[]): boolean {
  const ordered = [...splices].sort((a, b) => a.offset - b.offset)
  for (let n = 1; n < ordered.length; n++) {
    const prev = ordered[n - 1] as Splice
    const cur = ordered[n] as Splice
    if (cur.offset < prev.offset + prev.length) return true
    // Equal offsets conflict even for two pure insertions: each was rendered
    // assuming the other was not there, and both might want to add a comma.
    if (cur.offset === prev.offset) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function lineIndentAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  let j = start
  while (j < offset && (text[j] === ' ' || text[j] === '\t')) j++
  return text.slice(start, j)
}

function lineStartAt(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

/** Start of the line after the one containing `offset`. */
function lineEndOffset(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset)
  return nl < 0 ? text.length : nl + 1
}

function sameLine(text: string, from: number, to: number): boolean {
  return from <= to && !text.slice(from, to).includes('\n')
}

function isBlank(s: string): boolean {
  return /^[ \t\r\n]*$/.test(s)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, n) => deepEqual(v, b[n]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ka = Object.keys(ao).sort(compareKeys)
    const kb = Object.keys(bo).sort(compareKeys)
    if (ka.length !== kb.length) return false
    return ka.every((k, n) => kb[n] === k && deepEqual(ao[k], bo[k]))
  }
  return false
}

/** Indentation an inserted member of `container` should use. */
function memberIndent(text: string, container: JsoncNode, style: JsoncStyle): string {
  const first = container.children?.[0]
  const anchor = first ?? container.innerComments?.[0]
  if (anchor) {
    const at = anchor.offset
    if (isBlank(text.slice(lineStartAt(text, at), at))) return lineIndentAt(text, at)
  }
  return lineIndentAt(text, container.offset) + indentUnit(style)
}

function isSingleLine(text: string, container: JsoncNode): boolean {
  return !text.slice(container.offset, nodeEnd(container)).includes('\n')
}

/** Mimic the file's spacing after a comma, for single-line containers. */
function commaSpacing(text: string, container: JsoncNode, fallback: string): string {
  const kids = container.children ?? []
  for (const k of kids) {
    if (k.commaOffset === undefined) continue
    const m = /^[ \t]*/.exec(text.slice(k.commaOffset + 1))
    return m?.[0] ?? fallback
  }
  return fallback
}

/**
 * Mimic the file's spacing after `:`. Compact files (anything that has been
 * through `JSON.stringify`) write `"a":1`, and an inserted `"b": 2` next to it
 * reads as someone else's edit.
 */
function colonSpacing(text: string, container: JsoncNode): string {
  for (const prop of container.children ?? []) {
    const key = prop.keyNode
    const value = prop.valueNode
    if (!key || !value) continue
    const between = text.slice(nodeEnd(key), value.offset)
    const m = /^[ \t]*:([ \t]*)$/.exec(between)
    if (m) return m[1] as string
  }
  return ' '
}

// ---------------------------------------------------------------------------
// Edit planning
// ---------------------------------------------------------------------------

function nest(segments: readonly string[], value: unknown): unknown {
  let out = value
  for (let n = segments.length - 1; n >= 0; n--) out = { [segments[n] as string]: out }
  return out
}

/** Replace an existing value node in place. */
function planReplace(text: string, node: JsoncNode, value: unknown, style: JsoncStyle): Splice[] {
  if (deepEqual(node.value, value)) return []
  const rendered = renderValue(value, style, lineIndentAt(text, node.offset))
  return [{ offset: node.offset, length: node.length, text: rendered }]
}

function planInsertIntoContainer(
  text: string,
  container: JsoncNode,
  key: string,
  value: unknown,
  style: JsoncStyle,
): Splice[] {
  const members = container.children ?? []
  const inner = container.innerComments ?? []
  const indent = memberIndent(text, container, style)
  const colon = colonSpacing(text, container)
  const singleLine = isSingleLine(text, container) && !(members.length === 0 && inner.length === 0)
  const comma = commaSpacing(text, container, colon)
  const body = singleLine
    ? renderInline(value, style, colon, comma)
    : renderValue(value, style, indent)
  const rendered = `${quoteString(key, style)}:${colon}${body}`

  // Empty container: replace whatever sits between the braces, so `{}`, `{ }`
  // and `{\n}` all produce the same well-formed result.
  if (members.length === 0 && inner.length === 0) {
    const open = container.offset + 1
    const close = nodeEnd(container) - 1
    const closeIndent = lineIndentAt(text, container.offset)
    const body = `${style.eol}${indent}${rendered}${style.trailingComma ? ',' : ''}${style.eol}${closeIndent}`
    return [{ offset: open, length: close - open, text: body }]
  }

  const last = members[members.length - 1]
  const lastInner = inner[inner.length - 1]

  // Anchor: after the last member, its comma, and any comment sharing that
  // line. Inserting before a same-line comment would silently re-attach the
  // comment to the new key.
  let anchor: number
  let needComma = false
  if (last) {
    const end = nodeEnd(last)
    anchor = last.commaOffset !== undefined ? last.commaOffset + 1 : end
    needComma = last.commaOffset === undefined
    const tc = last.trailingComment
    if (tc && tc.offset >= end && sameLine(text, anchor, tc.offset)) anchor = tc.offset + tc.length
  } else if (lastInner) {
    anchor = lastInner.offset + lastInner.length
  } else {
    anchor = container.offset + 1
  }

  const separator = singleLine ? comma : `${style.eol}${indent}`
  const tail = singleLine ? '' : style.trailingComma ? ',' : ''
  const commaEnd = last ? nodeEnd(last) : anchor

  if (needComma && commaEnd !== anchor) {
    return [
      { offset: commaEnd, length: 0, text: ',' },
      { offset: anchor, length: 0, text: `${separator}${rendered}${tail}` },
    ]
  }
  return [
    {
      offset: anchor,
      length: 0,
      text: `${needComma ? ',' : ''}${separator}${rendered}${tail}`,
    },
  ]
}

/**
 * Upsert. Mirrors `setPath` in core/reconcile: missing intermediate objects are
 * created, and an intermediate that is NOT an object is replaced by one.
 */
function planSet(text: string, tree: JsoncNode, path: string, value: unknown, style: JsoncStyle): Splice[] {
  const root = rootValue(tree)

  if (path === '') {
    if (!root) return planNewDocument(text, tree, value, style)
    return planReplace(text, root, value, style)
  }

  const existing = getNodeAtPath(tree, path)
  if (existing) return planReplace(text, existing, value, style)

  if (!root) return planNewDocument(text, tree, nest(path.split('.'), value), style)
  if (root.type !== 'object') {
    throw new JsoncError(
      `cannot set "${path}": the document root is a ${root.type}, not an object`,
      root.offset,
    )
  }

  const segs = path.split('.')
  let container = root
  let n = 0
  for (; n < segs.length - 1; n++) {
    const prop = findProperty(container, segs[n] as string)
    const child = prop?.valueNode
    if (!child) break
    if (child.type !== 'object') {
      // setPath overwrites a scalar standing where an object is needed.
      return planReplace(text, child, nest(segs.slice(n + 1), value), style)
    }
    container = child
  }

  return planInsertIntoContainer(
    text,
    container,
    segs[n] as string,
    nest(segs.slice(n + 1), value),
    style,
  )
}

/** A file with no top-level value yet — empty, or comments only. */
function planNewDocument(text: string, tree: JsoncNode, value: unknown, style: JsoncStyle): Splice[] {
  const rendered = renderValue(value, style, '')
  const lead = tree.leadingComments ?? []
  const after = lead.length ? lead[lead.length - 1] as JsoncComment : undefined
  const at = after ? after.offset + after.length : text.length
  const prefix = after ? style.eol : ''
  const suffix = style.finalNewline ? style.eol : ''
  return [{ offset: at, length: text.length - at, text: `${prefix}${rendered}${suffix}` }]
}

/**
 * Remove a member, its comma, and the comments that belong to it — leaving no
 * dangling comma, no orphaned note about a setting that no longer exists, and
 * no blank line where the member used to be.
 */
function planDelete(text: string, tree: JsoncNode, path: string): Splice[] {
  if (path === '') throw new JsoncError('cannot delete the document root', 0)

  const segs = path.split('.')
  const key = segs.pop() as string
  const container = getNodeAtPath(tree, segs.join('.'))
  if (!container || container.type !== 'object') return []

  const members = container.children ?? []
  const target = findProperty(container, key)
  const index = target ? members.indexOf(target) : -1
  const prop = members[index]
  if (!prop) return []

  let start = prop.offset
  let end = nodeEnd(prop)

  // Leading comments are ours as long as no blank line separates them from the
  // key. A comment fenced off by a blank line is about the section, not us.
  const lead = prop.leadingComments ?? []
  let claimedAllComments = true
  for (let n = lead.length - 1; n >= 0; n--) {
    const c = lead[n] as JsoncComment
    const between = text.slice(c.offset + c.length, start)
    if (!isBlank(between) || /\n[ \t]*\n/.test(between)) {
      claimedAllComments = false
      break
    }
    start = c.offset
  }

  const extra: Splice[] = []
  if (prop.commaOffset !== undefined) {
    end = prop.commaOffset + 1
  } else {
    // Last member: the comma that separated us from the PREVIOUS member is now
    // dangling. Remove just that character — the span between it and us may
    // hold the previous member's trailing comment, which must survive.
    const prev = members[index - 1]
    if (prev?.commaOffset !== undefined) {
      extra.push({ offset: prev.commaOffset, length: 1, text: '' })
    }
  }

  const tc = prop.trailingComment
  if (tc && tc.offset >= end && sameLine(text, end, tc.offset)) end = tc.offset + tc.length

  // If the member had its line to itself, take the whole line — otherwise the
  // deletion leaves an indented blank line behind.
  const ls = lineStartAt(text, start)
  const nl = text.indexOf('\n', end)
  const lineEnd = nl < 0 ? text.length : nl
  if (isBlank(text.slice(ls, start)) && isBlank(text.slice(end, lineEnd))) {
    start = ls
    end = nl < 0 ? text.length : nl + 1

    // A blank line that only existed to separate us from a neighbour goes with
    // us when there is no longer a neighbour on that side — otherwise removing
    // the first or last member leaves the container gaping open.
    if (/[{[][ \t\r\n]*$/.test(text.slice(0, start))) {
      while (end < text.length) {
        const next = lineEndOffset(text, end)
        if (!isBlank(text.slice(end, next)) || next === end) break
        end = next
      }
    }
    if (/^[ \t\r\n]*[}\]]/.test(text.slice(end))) {
      while (start > 0) {
        const prev = lineStartAt(text, start - 1)
        if (!isBlank(text.slice(prev, start))) break
        start = prev
      }
    }
  } else {
    while (text[end] === ' ' || text[end] === '\t') end++
  }

  // Sole member with nothing else inside: collapse to `{}` rather than leave a
  // container wrapped around an empty line.
  const noComments = (container.innerComments?.length ?? 0) === 0
  if (members.length === 1 && noComments && claimedAllComments) {
    return [{ offset: container.offset, length: container.length, text: '{}' }]
  }

  return [...extra, { offset: start, length: end - start, text: '' }]
}

// ---------------------------------------------------------------------------
// Public edit API
// ---------------------------------------------------------------------------

/**
 * Replace ONE existing value, touching nothing else in the file.
 *
 * Idempotent by construction: if the value at `path` already equals
 * `newValue`, the input string is returned unchanged — including when the
 * current value is a container full of comments we would not reproduce.
 */
export function editValue(text: string, path: string, newValue: unknown): string {
  const tree = parseTree(text)
  const node = getNodeAtPath(tree, path)
  if (!node) throw new JsoncError(`no value at path "${path || '<root>'}"`, 0)
  return applySplices(text, planReplace(text, node, newValue, detectStyle(text)))
}

/** Insert a key that does not exist yet, matching the file's indent and commas. */
export function insertKey(text: string, path: string, value: unknown): string {
  const tree = parseTree(text)
  if (path !== '' && getNodeAtPath(tree, path)) {
    throw new JsoncError(`"${path}" already exists — use editValue to replace it`, 0)
  }
  return applySplices(text, planSet(text, tree, path, value, detectStyle(text)))
}

/** Insert or replace, whichever the file calls for. */
export function setValue(text: string, path: string, value: unknown): string {
  const tree = parseTree(text)
  return applySplices(text, planSet(text, tree, path, value, detectStyle(text)))
}

/** Remove a key. A path that is not present is a no-op, not an error. */
export function deleteKey(text: string, path: string): string {
  const tree = parseTree(text)
  return applySplices(text, planDelete(text, tree, path))
}

export interface JsoncEdit {
  path: string
  /** Default 'set', which inserts when the key is absent. */
  op?: 'set' | 'delete'
  value?: unknown
}

/**
 * Do any two edits address the same key, or one the ancestor of another? Then
 * the second one's outcome depends on the first having already been applied,
 * and planning both against the original document would be wrong.
 */
function pathsInterfere(edits: readonly JsoncEdit[]): boolean {
  for (let i = 0; i < edits.length; i++) {
    const a = (edits[i] as JsoncEdit).path
    for (let j = i + 1; j < edits.length; j++) {
      const b = (edits[j] as JsoncEdit).path
      if (a === b || a === '' || b === '') return true
      if (b.startsWith(`${a}.`) || a.startsWith(`${b}.`)) return true
    }
  }
  return false
}

/**
 * Apply several edits to one file.
 *
 * Fast path: every edit is resolved against a single parse and the resulting
 * splices are applied in reverse document order, so an earlier edit can never
 * invalidate a later edit's offsets.
 *
 * When two edits could see each other — the same path twice, one path nested
 * inside another, or two splices landing on the same span — we fall back to
 * applying them one at a time against a fresh parse. Slower, but it keeps the
 * result identical to applying the edits in order, which is what callers mean
 * and what `applyChangesToDoc` does with the same change list.
 */
export function editMany(text: string, edits: readonly JsoncEdit[]): string {
  if (edits.length === 0) return text
  if (edits.length === 1) {
    const only = edits[0] as JsoncEdit
    return only.op === 'delete' ? deleteKey(text, only.path) : setValue(text, only.path, only.value)
  }

  let conflicted = pathsInterfere(edits)

  if (!conflicted) {
    const style = detectStyle(text)
    const tree = parseTree(text)
    const planned: Splice[] = []

    for (const edit of edits) {
      planned.push(
        ...(edit.op === 'delete'
          ? planDelete(text, tree, edit.path)
          : planSet(text, tree, edit.path, edit.value, style)),
      )
      if (overlaps(planned)) {
        conflicted = true
        break
      }
    }
    if (!conflicted) return applySplices(text, planned)
  }

  // Nothing has been written anywhere yet — this builds a string, so a throw
  // part way through leaves the caller's text untouched.
  let out = text
  for (const edit of edits) {
    out = edit.op === 'delete' ? deleteKey(out, edit.path) : setValue(out, edit.path, edit.value)
  }
  return out
}
