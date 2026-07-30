/**
 * Tests for the format-preserving JSONC writer.
 *
 * The contract under test is narrow and absolute: after an edit, every byte of
 * the file that did not need to change is still there. So most of these
 * assertions compare whole strings rather than parsed values — a test that
 * round-trips through `JSON.parse` would pass while we silently deleted every
 * comment in the file, which is precisely the bug this module exists to prevent.
 */

import { describe, expect, it } from 'vitest'

import {
  JsoncError,
  decodeString,
  deleteKey,
  detectStyle,
  editMany,
  editValue,
  getNodeAtPath,
  getPropertyAtPath,
  insertKey,
  nodeEnd,
  parseJsonc,
  parseTree,
  setValue,
  tokenize,
} from '../jsonc.js'

/** A realistic Claude Code settings.json, annotated the way people annotate. */
const ANNOTATED = `{
  // Opus for planning, sonnet for grinding.
  "model": "sonnet",

  /* Permission rules merge across scopes rather than
     override, so keep this list tight. */
  "permissions": {
    "allow": [
      "Bash(ls:*)", // harmless
      "Read(**)"
    ],
    "deny": ["Bash(rm:*)"]
  },
  "env": {
    "EDITOR": "vim"
  }
}
`

// ---------------------------------------------------------------------------
// Tokenizer / parser
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('emits whitespace and comments as tokens, so the stream is lossless', () => {
    const text = '{ // hi\n  "a": 1 }'
    const tokens = tokenize(text)
    const rebuilt = tokens.map((t) => text.slice(t.offset, t.offset + t.length)).join('')
    expect(rebuilt).toBe(text)
    expect(tokens.map((t) => t.kind)).toContain('line-comment')
  })

  it('treats a leading BOM as its own token, not as whitespace', () => {
    const tokens = tokenize('\ufeff{}')
    expect(tokens[0]).toEqual({ kind: 'bom', offset: 0, length: 1 })
  })

  it('rejects an unterminated block comment instead of guessing', () => {
    expect(() => tokenize('{ /* never closed')).toThrow(JsoncError)
  })

  it('rejects a stray slash', () => {
    expect(() => tokenize('{ "a": 1 / 2 }')).toThrow(/expected "\/\/"/)
  })
})

describe('parseTree', () => {
  it('records an offset and length for every node', () => {
    const text = '{\n  "a": 12\n}'
    const tree = parseTree(text)

    const root = getNodeAtPath(tree, '')
    expect(root).toBeDefined()
    expect(text.slice(root!.offset, nodeEnd(root!))).toBe(text)

    const a = getNodeAtPath(tree, 'a')
    expect(a?.type).toBe('number')
    expect(text.slice(a!.offset, nodeEnd(a!))).toBe('12')

    // A property spans key through value; its comments are deliberately not
    // part of the span, so replacing a value cannot swallow one.
    const prop = getPropertyAtPath(tree, 'a')
    expect(text.slice(prop!.offset, nodeEnd(prop!))).toBe('"a": 12')
  })

  it('keeps a comment that sits between a key and its value', () => {
    const tree = parseTree('{ "a": /* why not */ 1 }')
    const value = getNodeAtPath(tree, 'a')
    expect(value?.leadingComments?.[0]?.text).toBe('/* why not */')
  })

  it('attaches a same-line comment to the member it follows', () => {
    const tree = parseTree('{\n  "a": 1, // about a\n  "b": 2\n}')
    const a = getPropertyAtPath(tree, 'a')
    const b = getPropertyAtPath(tree, 'b')
    expect(a?.trailingComment?.text).toBe('// about a')
    expect(b?.leadingComments).toBeUndefined()
  })

  it('attaches a comment on the line ABOVE a key to that key', () => {
    const tree = parseTree('{\n  "a": 1,\n  // about b\n  "b": 2\n}')
    const b = getPropertyAtPath(tree, 'b')
    expect(b?.leadingComments?.map((c) => c.text)).toEqual(['// about b'])
  })

  it('accepts trailing commas in objects and arrays', () => {
    expect(parseJsonc('{ "a": [1, 2,], }')).toEqual({ a: [1, 2] })
  })

  it('records the comma offset that follows each member', () => {
    const text = '{ "a": 1, "b": 2 }'
    const tree = parseTree(text)
    expect(text[getPropertyAtPath(tree, 'a')?.commaOffset ?? -1]).toBe(',')
    expect(getPropertyAtPath(tree, 'b')?.commaOffset).toBeUndefined()
  })

  it('parses an empty document without throwing — every file starts there', () => {
    const tree = parseTree('')
    expect(tree.type).toBe('document')
    expect(tree.children).toEqual([])
    expect(getNodeAtPath(tree, '')).toBeUndefined()
  })

  it('keeps comments in a comments-only file', () => {
    const tree = parseTree('// nothing here yet\n')
    expect(tree.leadingComments?.[0]?.text).toBe('// nothing here yet')
  })

  it('refuses content after the top-level value', () => {
    expect(() => parseTree('{} {}')).toThrow(/unexpected content/)
  })

  it('refuses an unquoted key — this is JSONC, not JSON5', () => {
    expect(() => parseTree('{ a: 1 }')).toThrow(JsoncError)
  })

  it('reports the offset of a syntax error', () => {
    try {
      parseTree('{ "a" 1 }')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(JsoncError)
      expect((err as JsoncError).offset).toBe(6)
    }
  })

  it('resolves duplicate keys the way JSON.parse does — last wins', () => {
    expect(parseJsonc('{ "a": 1, "a": 2 }')).toEqual({ a: 2 })
  })
})

describe('decodeString', () => {
  it('decodes escapes, including surrogate pairs', () => {
    expect(decodeString('"caf\\u00e9"')).toBe('café')
    expect(decodeString('"\\ud83d\\ude80"')).toBe('🚀')
    expect(decodeString('"a\\\\b\\"c\\n"')).toBe('a\\b"c\n')
  })

  it('rejects an invalid escape rather than dropping it', () => {
    expect(() => decodeString('"\\q"')).toThrow(JsoncError)
  })
})

// ---------------------------------------------------------------------------
// getNodeAtPath
// ---------------------------------------------------------------------------

describe('getNodeAtPath', () => {
  it('uses the same dot-path semantics as getPath in reconcile', () => {
    const tree = parseTree(ANNOTATED)
    expect(getNodeAtPath(tree, 'permissions.allow')?.value).toEqual(['Bash(ls:*)', 'Read(**)'])
    expect(getNodeAtPath(tree, 'env.EDITOR')?.value).toBe('vim')
    expect(getNodeAtPath(tree, 'nope')).toBeUndefined()
    expect(getNodeAtPath(tree, 'model.deeper')).toBeUndefined()
  })

  it('treats "" as the whole document', () => {
    expect(getNodeAtPath(parseTree(ANNOTATED), '')?.type).toBe('object')
    expect(getNodeAtPath(parseTree('[1, 2]'), '')?.value).toEqual([1, 2])
  })

  it('does not index into arrays — they are leaves, like in reconcile', () => {
    expect(getNodeAtPath(parseTree('{ "a": [1] }'), 'a.0')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// detectStyle
// ---------------------------------------------------------------------------

describe('detectStyle', () => {
  it('reads indent, EOL and final newline off the file', () => {
    expect(detectStyle(ANNOTATED)).toEqual({
      indent: 2,
      useTabs: false,
      trailingComma: false,
      eol: '\n',
      finalNewline: true,
      quoteStyle: 'double',
    })
  })

  it('detects tabs', () => {
    const style = detectStyle('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n')
    expect(style.useTabs).toBe(true)
    expect(style.indent).toBe(1)
  })

  it('detects four-space indent', () => {
    expect(detectStyle('{\n    "a": 1\n}\n').indent).toBe(4)
  })

  it('detects CRLF and a missing final newline', () => {
    const style = detectStyle('{\r\n  "a": 1\r\n}')
    expect(style.eol).toBe('\r\n')
    expect(style.finalNewline).toBe(false)
  })

  it('detects trailing commas from the tree, not from a regex', () => {
    expect(detectStyle('{ "a": [1, 2], "b": 3 }').trailingComma).toBe(false)
    expect(detectStyle('{ "a": [1, 2,] }').trailingComma).toBe(true)
    // A comma inside a string is not a trailing comma.
    expect(detectStyle('{ "a": "x,y," }').trailingComma).toBe(false)
  })

  it('is not fooled by the interior of a block comment', () => {
    // The ` * ` continuation lines are one space in; that is not the indent.
    const style = detectStyle('/*\n * header\n */\n{\n    "a": 1\n}\n')
    expect(style.indent).toBe(4)
  })

  it('reports single quotes so a JSON5-ish file is not rewritten to double', () => {
    expect(detectStyle("{ 'a': 'b' }").quoteStyle).toBe('single')
  })

  it('falls back to defaults on an empty file', () => {
    expect(detectStyle('')).toEqual({
      indent: 2,
      useTabs: false,
      trailingComma: false,
      eol: '\n',
      finalNewline: true,
      quoteStyle: 'double',
    })
  })
})

// ---------------------------------------------------------------------------
// editValue
// ---------------------------------------------------------------------------

describe('editValue', () => {
  it('changes one value and leaves every comment intact', () => {
    const out = editValue(ANNOTATED, 'model', 'opus')
    expect(out).toBe(ANNOTATED.replace('"sonnet"', '"opus"'))
    expect(out).toContain('// Opus for planning, sonnet for grinding.')
    expect(out).toContain('/* Permission rules merge across scopes rather than')
    expect(out).toContain('"Bash(ls:*)", // harmless')
  })

  it('edits a nested path', () => {
    const out = editValue(ANNOTATED, 'env.EDITOR', 'nano')
    expect(out).toBe(ANNOTATED.replace('"vim"', '"nano"'))
  })

  it('replaces a whole array as a leaf value, at the right indent', () => {
    const out = editValue(ANNOTATED, 'permissions.allow', ['Bash(git:*)', 'Edit(src/**)'])
    expect(out).toContain(
      '    "allow": [\n      "Bash(git:*)",\n      "Edit(src/**)"\n    ],\n',
    )
    // The comment INSIDE the old array is gone with the array, but the ones
    // around it are untouched.
    expect(out).toContain('// Opus for planning')
    expect(out).toContain('"deny": ["Bash(rm:*)"]')
  })

  it('steps around a comment between the key and the value', () => {
    const text = '{\n  "a": /* keep me */ 1\n}\n'
    expect(editValue(text, 'a', 2)).toBe('{\n  "a": /* keep me */ 2\n}\n')
  })

  it('replaces the whole document at the "" path', () => {
    const text = '// Zed keymap\n[\n  { "context": "Editor" }\n]\n'
    const out = editValue(text, '', [{ context: 'Workspace' }])
    expect(out).toBe('// Zed keymap\n[\n  {\n    "context": "Workspace"\n  }\n]\n')
  })

  it('is idempotent when the value has not changed', () => {
    expect(editValue(ANNOTATED, 'model', 'sonnet')).toBe(ANNOTATED)
    expect(editValue(ANNOTATED, 'env.EDITOR', 'vim')).toBe(ANNOTATED)
  })

  it('is idempotent for containers too, comments and all', () => {
    // Structural equality, not textual: re-rendering this array would drop the
    // "// harmless" comment, so an unchanged value must not be re-rendered.
    expect(editValue(ANNOTATED, 'permissions.allow', ['Bash(ls:*)', 'Read(**)'])).toBe(ANNOTATED)
    expect(
      editValue(ANNOTATED, 'permissions', {
        allow: ['Bash(ls:*)', 'Read(**)'],
        deny: ['Bash(rm:*)'],
      }),
    ).toBe(ANNOTATED)
  })

  it('refuses a path that does not exist rather than inventing one', () => {
    expect(() => editValue(ANNOTATED, 'nope', 1)).toThrow(/no value at path/)
  })

  it('refuses to write a non-finite number', () => {
    expect(() => editValue(ANNOTATED, 'model', Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
  })
})

// ---------------------------------------------------------------------------
// Line endings, BOM, unicode
// ---------------------------------------------------------------------------

describe('byte-level preservation', () => {
  const CRLF = '{\r\n  "a": 1,\r\n  "b": {\r\n    "c": 2\r\n  }\r\n}\r\n'

  it('keeps CRLF files CRLF', () => {
    expect(editValue(CRLF, 'a', 9)).toBe('{\r\n  "a": 9,\r\n  "b": {\r\n    "c": 2\r\n  }\r\n}\r\n')
    expect(insertKey(CRLF, 'd', 4)).toContain('  },\r\n  "d": 4\r\n}')
    expect(deleteKey(CRLF, 'a')).toBe('{\r\n  "b": {\r\n    "c": 2\r\n  }\r\n}\r\n')
  })

  it('keeps LF files LF', () => {
    const lf = '{\n  "a": 1\n}\n'
    expect(insertKey(lf, 'b', 2)).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
    expect(insertKey(lf, 'b', 2)).not.toContain('\r')
  })

  it('keeps a BOM', () => {
    const bom = '\ufeff{\n  "a": 1\n}\n'
    expect(insertKey(bom, 'b', 2).charCodeAt(0)).toBe(0xfeff)
    expect(editValue(bom, 'a', 2)).toBe('\ufeff{\n  "a": 2\n}\n')
    expect(deleteKey(bom, 'a')).toBe('\ufeff{}\n')
  })

  it('leaves unicode and escapes in untouched keys byte-identical', () => {
    const text =
      '{\n' +
      '  "emoji \\ud83d\\ude80": "caf\\u00e9",\n' +
      '  "quote\\"key": "back\\\\slash",\n' +
      '  "日本": "テスト"\n' +
      '}\n'

    expect(parseJsonc(text)).toEqual({
      'emoji 🚀': 'café',
      'quote"key': 'back\\slash',
      日本: 'テスト',
    })

    const out = editValue(text, '日本', 'ok ✓')
    // The \u escapes in the OTHER entries are not normalized — we never
    // re-serialized them.
    expect(out).toContain('"emoji \\ud83d\\ude80": "caf\\u00e9"')
    expect(out).toContain('"quote\\"key": "back\\\\slash"')
    expect(out).toContain('"日本": "ok ✓"')
  })

  it('addresses and edits a key that itself contains escapes', () => {
    const text = '{\n  "quote\\"key": 1\n}\n'
    expect(editValue(text, 'quote"key', 2)).toBe('{\n  "quote\\"key": 2\n}\n')
  })

  it('escapes what it writes', () => {
    const out = editValue('{\n  "a": 1\n}\n', 'a', 'he said "hi"\\done\n')
    expect(out).toBe('{\n  "a": "he said \\"hi\\"\\\\done\\n"\n}\n')
    expect(parseJsonc(out)).toEqual({ a: 'he said "hi"\\done\n' })
  })
})

// ---------------------------------------------------------------------------
// insertKey
// ---------------------------------------------------------------------------

describe('insertKey', () => {
  it('matches the file indent and adds the separating comma', () => {
    const out = insertKey(ANNOTATED, 'theme', 'dark')
    expect(out).toContain('  },\n  "theme": "dark"\n}\n')
    expect(out).toContain('// Opus for planning')
  })

  it('inserts into a nested object', () => {
    const out = insertKey(ANNOTATED, 'env.PAGER', 'less')
    expect(out).toContain('  "env": {\n    "EDITOR": "vim",\n    "PAGER": "less"\n  }\n')
  })

  it('creates missing intermediate objects, like setPath does', () => {
    const out = insertKey('{\n  "a": 1\n}\n', 'agent.profiles.write.context_servers', ['fs'])
    expect(parseJsonc(out)).toEqual({
      a: 1,
      agent: { profiles: { write: { context_servers: ['fs'] } } },
    })
    expect(out).toBe(
      '{\n' +
        '  "a": 1,\n' +
        '  "agent": {\n' +
        '    "profiles": {\n' +
        '      "write": {\n' +
        '        "context_servers": [\n' +
        '          "fs"\n' +
        '        ]\n' +
        '      }\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    )
  })

  it('inserts into an empty object', () => {
    expect(insertKey('{}', 'a', 1)).toBe('{\n  "a": 1\n}')
    expect(insertKey('{}\n', 'env.TOKEN', 'x')).toBe('{\n  "env": {\n    "TOKEN": "x"\n  }\n}\n')
    expect(insertKey('{\n}\n', 'a', 1)).toBe('{\n  "a": 1\n}\n')
  })

  it('inserts into an empty file', () => {
    expect(insertKey('', 'a', 1)).toBe('{\n  "a": 1\n}\n')
    expect(insertKey('', 'a.b', 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n')
  })

  it('keeps the comments in a comments-only file', () => {
    expect(insertKey('// notes\n', 'a', 1)).toBe('// notes\n{\n  "a": 1\n}\n')
  })

  it('keeps a single-line file on one line, with its own spacing', () => {
    expect(insertKey('{"a":1}', 'b', 2)).toBe('{"a":1,"b":2}')
    expect(insertKey('{ "a": 1 }', 'b', { c: 2 })).toBe('{ "a": 1, "b": {"c": 2} }')
  })

  it('follows the file trailing-comma style', () => {
    const out = insertKey('{\n  "a": 1,\n}\n', 'b', [1])
    expect(out).toBe('{\n  "a": 1,\n  "b": [\n    1,\n  ],\n}\n')
  })

  it('does not steal the last member trailing comment', () => {
    const out = insertKey('{\n  "a": 1 // about a\n}\n', 'b', 2)
    expect(out).toBe('{\n  "a": 1, // about a\n  "b": 2\n}\n')
  })

  it('inserts before a comment that belongs to the closing brace', () => {
    const out = insertKey('{\n  "a": 1\n  // section end\n}\n', 'b', 2)
    expect(out).toBe('{\n  "a": 1,\n  "b": 2\n  // section end\n}\n')
  })

  it('inserts into a container that holds only comments', () => {
    expect(insertKey('{\n  // nothing yet\n}\n', 'a', 1)).toBe(
      '{\n  // nothing yet\n  "a": 1\n}\n',
    )
  })

  it('uses tabs when the file uses tabs', () => {
    expect(insertKey('{\n\t"a": 1\n}\n', 'b', { c: 1 })).toBe(
      '{\n\t"a": 1,\n\t"b": {\n\t\t"c": 1\n\t}\n}\n',
    )
  })

  it('refuses to insert over an existing key', () => {
    expect(() => insertKey(ANNOTATED, 'model', 'opus')).toThrow(/already exists/)
  })

  it('refuses a dot path into an array-rooted document', () => {
    expect(() => insertKey('[1, 2]', 'a', 1)).toThrow(/root is a array/)
  })
})

describe('setValue', () => {
  it('inserts when absent and replaces when present', () => {
    expect(setValue('{\n  "a": 1\n}\n', 'a', 2)).toBe('{\n  "a": 2\n}\n')
    expect(setValue('{\n  "a": 1\n}\n', 'b', 2)).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
  })

  it('replaces a scalar standing where an object is needed, like setPath', () => {
    expect(setValue('{\n  "a": 1\n}\n', 'a.b', 2)).toBe('{\n  "a": {\n    "b": 2\n  }\n}\n')
  })

  it('writes the whole document at "" even when the file is empty', () => {
    expect(setValue('', '', [{ shell: 'echo hi' }])).toBe(
      '[\n  {\n    "shell": "echo hi"\n  }\n]\n',
    )
  })
})

// ---------------------------------------------------------------------------
// deleteKey
// ---------------------------------------------------------------------------

describe('deleteKey', () => {
  it('removes the key and its comma, leaving no dangling comma', () => {
    const out = deleteKey('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n', 'b')
    expect(out).toBe('{\n  "a": 1,\n  "c": 3\n}\n')
  })

  it('removes the PREVIOUS comma when deleting the last member', () => {
    const out = deleteKey('{\n  "a": 1,\n  "b": 2\n}\n', 'b')
    expect(out).toBe('{\n  "a": 1\n}\n')
  })

  it('keeps the previous member trailing comment when it deletes the last member', () => {
    const out = deleteKey('{\n  "a": 1, // about a\n  "b": 2\n}\n', 'b')
    expect(out).toBe('{\n  "a": 1 // about a\n}\n')
  })

  it('takes the comment on the line above with it, rather than orphaning it', () => {
    const text = '{\n  "a": 1,\n  // about b\n  // and more about b\n  "b": 2,\n  "c": 3\n}\n'
    expect(deleteKey(text, 'b')).toBe('{\n  "a": 1,\n  "c": 3\n}\n')
  })

  it('takes the member own-line trailing comment too', () => {
    const text = '{\n  "a": 1,\n  "b": 2, // about b\n  "c": 3\n}\n'
    expect(deleteKey(text, 'b')).toBe('{\n  "a": 1,\n  "c": 3\n}\n')
  })

  it('leaves a comment fenced off by a blank line — that one is about the section', () => {
    const text = '{\n  "a": 1,\n\n  // ---- section ----\n\n  "b": 2,\n  "c": 3\n}\n'
    const out = deleteKey(text, 'b')
    expect(out).toContain('// ---- section ----')
    expect(out).not.toContain('"b"')
  })

  it('leaves no blank line where the member was', () => {
    // The blank line only existed to separate the two members; with one of
    // them gone it would just be a hole at the top or bottom of the object.
    const text = '{\n  "a": 1,\n\n  "b": 2\n}\n'
    expect(deleteKey(text, 'a')).toBe('{\n  "b": 2\n}\n')
    expect(deleteKey(text, 'b')).toBe('{\n  "a": 1\n}\n')
  })

  it('collapses a container it empties, rather than leaving a hole', () => {
    expect(deleteKey('{\n  "env": {\n    "A": 1\n  }\n}\n', 'env.A')).toBe('{\n  "env": {}\n}\n')
  })

  it('handles single-line containers without eating the neighbours', () => {
    expect(deleteKey('{ "a": 1, "b": 2 }', 'a')).toBe('{ "b": 2 }')
    expect(deleteKey('{ "a": 1, "b": 2 }', 'b')).toBe('{ "a": 1 }')
  })

  it('keeps a trailing comma file valid', () => {
    expect(deleteKey('{\n  "a": 1,\n  "b": 2,\n}\n', 'b')).toBe('{\n  "a": 1,\n}\n')
  })

  it('is a no-op for a path that is not there', () => {
    expect(deleteKey(ANNOTATED, 'nope')).toBe(ANNOTATED)
    expect(deleteKey(ANNOTATED, 'nope.deeper')).toBe(ANNOTATED)
  })

  it('refuses to delete the document root', () => {
    expect(() => deleteKey(ANNOTATED, '')).toThrow(/cannot delete the document root/)
  })
})

// ---------------------------------------------------------------------------
// editMany
// ---------------------------------------------------------------------------

describe('editMany', () => {
  it('applies several edits without letting earlier ones corrupt later offsets', () => {
    // The first replacement is much longer than what it replaces; if edits were
    // applied front-to-back against stale offsets, the later ones would land in
    // the wrong place.
    const out = editMany(ANNOTATED, [
      { path: 'model', value: 'claude-opus-4-6-with-a-very-long-name' },
      { path: 'env.EDITOR', value: 'nano' },
      { path: 'permissions.deny', value: ['Bash(rm:*)', 'Bash(sudo:*)'] },
    ])

    expect(parseJsonc(out)).toEqual({
      model: 'claude-opus-4-6-with-a-very-long-name',
      permissions: {
        allow: ['Bash(ls:*)', 'Read(**)'],
        deny: ['Bash(rm:*)', 'Bash(sudo:*)'],
      },
      env: { EDITOR: 'nano' },
    })
    expect(out).toContain('// Opus for planning, sonnet for grinding.')
    expect(out).toContain('"Bash(ls:*)", // harmless')
  })

  it('handles several inserts into the same object', () => {
    const out = editMany('{\n  "a": 1\n}\n', [
      { path: 'b', value: 2 },
      { path: 'c', value: 3 },
    ])
    expect(out).toBe('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n')
  })

  it('handles overlapping edits by applying them in order', () => {
    // Setting `a` and then `a.b` must end up with both applied, not with one
    // splice landing inside the other's replacement text.
    const out = editMany('{\n  "a": 1\n}\n', [
      { path: 'a', value: { b: 1 } },
      { path: 'a.b', value: 2 },
    ])
    expect(parseJsonc(out)).toEqual({ a: { b: 2 } })
  })

  it('mixes sets and deletes', () => {
    const out = editMany(ANNOTATED, [
      { path: 'model', value: 'opus' },
      { path: 'env.EDITOR', op: 'delete' },
      { path: 'theme', value: 'dark' },
    ])
    expect(parseJsonc(out)).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)', 'Read(**)'], deny: ['Bash(rm:*)'] },
      env: {},
      theme: 'dark',
    })
    expect(out).toContain('/* Permission rules merge across scopes rather than')
  })

  it('is idempotent when nothing actually changes', () => {
    expect(
      editMany(ANNOTATED, [
        { path: 'model', value: 'sonnet' },
        { path: 'env.EDITOR', value: 'vim' },
      ]),
    ).toBe(ANNOTATED)
  })

  it('returns the input untouched for an empty edit list', () => {
    expect(editMany(ANNOTATED, [])).toBe(ANNOTATED)
  })
})

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe('round trips', () => {
  const CASES: Array<[string, string]> = [
    ['plain', '{\n  "a": 1\n}\n'],
    ['annotated', ANNOTATED],
    ['crlf', '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n'],
    ['bom', '\ufeff{\n  "a": 1\n}\n'],
    ['tabs', '{\n\t"a": {\n\t\t"b": [1, 2]\n\t}\n}\n'],
    ['trailing commas', '{\n  "a": [\n    1,\n  ],\n}\n'],
    ['array root', '// header\n[\n  1,\n  2\n]\n'],
    ['compact', '{"a":1,"b":[1,2]}'],
    ['no final newline', '{\n  "a": 1\n}'],
  ]

  for (const [name, text] of CASES) {
    it(`re-writing an unchanged value is a no-op: ${name}`, () => {
      const tree = parseTree(text)
      const root = getNodeAtPath(tree, '')
      expect(editValue(text, '', root?.value)).toBe(text)
    })
  }

  it('survives insert-then-delete unchanged', () => {
    for (const [, text] of CASES) {
      if (!text.trimStart().startsWith('{')) continue
      const withKey = insertKey(text, '__tmp__', { nested: [1, 2] })
      expect(deleteKey(withKey, '__tmp__')).toBe(text)
    }
  })
})

// ---------------------------------------------------------------------------
// Generated documents
// ---------------------------------------------------------------------------

/**
 * A hand-rolled parser earns a property test. These generate annotated
 * documents in assorted styles and check the invariants that matter: the edit
 * lands, the output still parses, and the file's line endings are untouched.
 * Seeded, so a failure is reproducible rather than a flake.
 */
describe('generated documents', () => {
  let seed = 20260729
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const KEYS = ['a', 'model', 'permissions', 'env', '日本', 'q"k', 'back\\slash'] as const

  function value(depth: number): unknown {
    const r = rnd()
    if (depth > 2 || r < 0.35) return pick([1, -2.5, true, false, null, 'str', 'ünï✓', 'a\nb'])
    if (r < 0.55) return Array.from({ length: Math.floor(rnd() * 3) }, () => value(depth + 1))
    const o: Record<string, unknown> = {}
    for (let i = 0; i <= Math.floor(rnd() * 2); i++) o[pick(KEYS)] = value(depth + 1)
    return o
  }

  /** Serialize with comments, a random indent, and optional trailing commas. */
  function write(v: unknown, indent: string, eol: string, tc: boolean, level = 0): string {
    const pad = indent.repeat(level + 1)
    const close = indent.repeat(level)
    if (Array.isArray(v)) {
      if (!v.length) return '[]'
      const items = v.map((x) => pad + write(x, indent, eol, tc, level + 1))
      return `[${eol}${items.join(',' + eol)}${tc ? ',' : ''}${eol}${close}]`
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v as Record<string, unknown>)
      if (!keys.length) return '{}'
      const items = keys.map((k, i) => {
        const lead = rnd() < 0.4 ? `${pad}// note about ${i}${eol}` : ''
        const body = `${pad}${JSON.stringify(k)}: ${write((v as Record<string, unknown>)[k], indent, eol, tc, level + 1)}`
        const comma = i < keys.length - 1 || tc ? ',' : ''
        return `${lead}${body}${comma}${rnd() < 0.25 ? ` // inline ${i}` : ''}`
      })
      return `{${eol}${items.join(eol)}${eol}${close}}`
    }
    return JSON.stringify(v)
  }

  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
        .join(',')}}`
    }
    return JSON.stringify(v) ?? 'null'
  }

  const leafPaths = (v: unknown, prefix = ''): string[] => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return prefix ? [prefix] : []
    const out = prefix ? [prefix] : []
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      out.push(...leafPaths(sub, prefix ? `${prefix}.${k}` : k))
    }
    return out
  }

  it('applies the edit, keeps the file parseable, and keeps its line endings', () => {
    for (let n = 0; n < 400; n++) {
      const doc = value(0)
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue

      const indent = pick(['  ', '    ', '\t'])
      const eol = pick(['\n', '\r\n'])
      const tc = rnd() < 0.3
      const text = write(doc, indent, eol, tc) + eol

      expect(canon(parseJsonc(text))).toBe(canon(doc))

      const path = pick([...leafPaths(doc), 'brand.new.key'])
      const deleting = rnd() < 0.3
      const next = value(1)
      const out = deleting ? deleteKey(text, path) : setValue(text, path, next)

      const expected = structuredClone(doc) as Record<string, unknown>
      const segs = path.split('.')
      let cursor = expected
      let reachable = true
      for (const seg of segs.slice(0, -1)) {
        const child = cursor[seg]
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          if (deleting) {
            reachable = false
            break
          }
          cursor[seg] = {}
        }
        cursor = cursor[seg] as Record<string, unknown>
      }
      if (reachable) {
        const leaf = segs[segs.length - 1] as string
        if (deleting) delete cursor[leaf]
        else cursor[leaf] = next
      }

      const context = `path=${path} delete=${String(deleting)}\n--- in\n${text}\n--- out\n${out}`
      expect(canon(parseJsonc(out)), context).toBe(canon(expected))
      // A CRLF file must not sprout a lone LF anywhere.
      if (eol === '\r\n') expect(/[^\r]\n/.test(out), context).toBe(false)
      else expect(out.includes('\r'), context).toBe(false)
    }
  })
})
