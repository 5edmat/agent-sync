import { describe, expect, it } from 'vitest'

import {
  GLOBAL_FLAGS,
  boolFlag,
  editDistance,
  findCommand,
  listFlag,
  parse,
  stringFlag,
  suggest,
  triStateFlag,
  type CommandSpec,
} from '../args.js'
import { EXIT } from '../exit.js'

const COMMANDS: Record<string, CommandSpec> = {
  apply: {
    name: 'apply',
    summary: 'apply',
    usage: 'agentsync apply',
    flags: {
      tool: { type: 'string', placeholder: '<id>', description: 'tool' },
      yes: { type: 'boolean', alias: 'y', description: 'yes' },
      'dry-run': { type: 'boolean', alias: 'n', description: 'dry run' },
      tag: { type: 'string', repeatable: true, description: 'repeatable' },
    },
  },
  rollback: {
    name: 'rollback',
    summary: 'rollback',
    usage: 'agentsync rollback <id>',
    flags: { list: { type: 'boolean', alias: 'l', description: 'list' } },
    positionals: [{ name: 'id', required: true, description: 'id' }],
    positionalsSatisfiedBy: ['list'],
  },
  status: { name: 'status', summary: 'status', usage: 'agentsync status', flags: {} },
}

const ok = (argv: string[]) => {
  const r = parse(argv, { commands: COMMANDS })
  if (!r.ok) throw new Error(`expected parse to succeed: ${r.error.message}`)
  return r.value
}

const fail = (argv: string[]) => {
  const r = parse(argv, { commands: COMMANDS })
  if (r.ok) throw new Error('expected parse to fail')
  return r.error
}

describe('parse — commands', () => {
  it('takes the first bare word as the command', () => {
    expect(ok(['status']).command).toBe('status')
  })

  it('falls back to help when argv has no command', () => {
    expect(ok([]).command).toBe('help')
    expect(ok(['--json']).command).toBe('help')
  })

  it('does not mistake a global string flag value for the command', () => {
    const args = ok(['--state-dir', '/tmp/x', 'status'])
    expect(args.command).toBe('status')
    expect(stringFlag(args, 'state-dir')).toBe('/tmp/x')
  })

  it('rejects an unknown command with exit code 2 and a suggestion', () => {
    const err = fail(['statuz'])
    expect(err.code).toBe(EXIT.USAGE)
    expect(err.message).toContain('Unknown command')
    expect(err.hint).toContain('status')
  })

  it('lists the known commands when the name is too far off to guess', () => {
    const err = fail(['zzzzzzzzzzz'])
    expect(err.details.join(' ')).toContain('apply')
  })
})

describe('parse — flags', () => {
  it('reads long flags with a separate value', () => {
    expect(stringFlag(ok(['apply', '--tool', 'claude-code']), 'tool')).toBe('claude-code')
  })

  it('reads long flags with an inline value', () => {
    expect(stringFlag(ok(['apply', '--tool=claude-code']), 'tool')).toBe('claude-code')
  })

  it('reads boolean flags', () => {
    expect(boolFlag(ok(['apply', '--yes']), 'yes')).toBe(true)
    expect(boolFlag(ok(['apply']), 'yes')).toBe(false)
  })

  it('negates boolean flags with --no-', () => {
    expect(triStateFlag(ok(['status', '--no-color']), 'color')).toBe(false)
    expect(triStateFlag(ok(['status', '--color']), 'color')).toBe(true)
    expect(triStateFlag(ok(['status']), 'color')).toBeUndefined()
  })

  it('accepts explicit boolean literals and inverts them under --no-', () => {
    expect(triStateFlag(ok(['status', '--color=false']), 'color')).toBe(false)
    expect(triStateFlag(ok(['status', '--no-color=false']), 'color')).toBe(true)
  })

  it('rejects a non-boolean literal on a boolean flag', () => {
    expect(fail(['status', '--color=maybe']).code).toBe(EXIT.USAGE)
  })

  it('refuses to negate a string flag', () => {
    const err = fail(['apply', '--no-tool'])
    expect(err.message).toContain('Unknown flag "--no-tool"')
  })

  it('reports an unknown flag rather than ignoring it', () => {
    const err = fail(['apply', '--dry-runn'])
    expect(err.code).toBe(EXIT.USAGE)
    expect(err.hint).toContain('--dry-run')
  })

  it('reports a missing value for a string flag', () => {
    const err = fail(['apply', '--tool'])
    expect(err.message).toContain('--tool needs a value')
  })

  it('treats a following flag as a missing value, not as the value', () => {
    expect(fail(['apply', '--tool', '--yes']).message).toContain('needs a value')
  })

  it('collects repeatable flags', () => {
    expect(listFlag(ok(['apply', '--tag', 'a', '--tag', 'b']), 'tag')).toEqual(['a', 'b'])
  })

  it('last wins for non-repeatable flags', () => {
    expect(stringFlag(ok(['apply', '--tool', 'a', '--tool', 'b']), 'tool')).toBe('b')
  })
})

describe('parse — short flags', () => {
  it('reads a short alias', () => {
    expect(boolFlag(ok(['apply', '-y']), 'yes')).toBe(true)
  })

  it('clusters short booleans', () => {
    const args = ok(['apply', '-yn'])
    expect(boolFlag(args, 'yes')).toBe(true)
    expect(boolFlag(args, 'dry-run')).toBe(true)
  })

  it('rejects an unknown short flag', () => {
    expect(fail(['apply', '-z']).code).toBe(EXIT.USAGE)
  })

  it('lets a value-taking short flag consume the rest of its cluster', () => {
    const spec: Record<string, CommandSpec> = {
      x: { name: 'x', summary: '', usage: '', flags: { out: { type: 'string', alias: 'o', description: '' } } },
    }
    const r = parse(['x', '-ofile.txt'], { commands: spec })
    expect(r.ok).toBe(true)
    if (r.ok) expect(stringFlag(r.value, 'out')).toBe('file.txt')
  })
})

describe('parse — positionals', () => {
  it('collects bare words after the command', () => {
    expect(ok(['rollback', 'rb-123']).positionals).toEqual(['rb-123'])
  })

  it('treats everything after -- as positional', () => {
    expect(ok(['rollback', '--', '--not-a-flag']).positionals).toEqual(['--not-a-flag'])
  })

  it('requires a declared required positional', () => {
    const err = fail(['rollback'])
    expect(err.code).toBe(EXIT.USAGE)
    expect(err.message).toContain('<id>')
  })

  it('lets a satisfying flag stand in for the required positional', () => {
    expect(ok(['rollback', '--list']).positionals).toEqual([])
  })

  it('does not demand positionals when --help was asked for', () => {
    expect(boolFlag(ok(['rollback', '--help']), 'help')).toBe(true)
  })

  it('keeps a positional that happens to equal the command name', () => {
    expect(ok(['rollback', 'rollback']).positionals).toEqual(['rollback'])
  })
})

describe('findCommand', () => {
  it('skips over global string flag values', () => {
    expect(findCommand(['--cwd', '/a', 'diff'], GLOBAL_FLAGS)).toEqual({ command: 'diff', index: 2 })
  })

  it('does not skip a value for an inline-assigned flag', () => {
    expect(findCommand(['--cwd=/a', 'diff'], GLOBAL_FLAGS)).toEqual({ command: 'diff', index: 1 })
  })

  it('returns undefined when everything is a flag', () => {
    expect(findCommand(['--json', '-v'], GLOBAL_FLAGS)).toBeUndefined()
  })

  it('returns undefined when -- comes first', () => {
    expect(findCommand(['--', 'status'], GLOBAL_FLAGS)).toBeUndefined()
  })
})

describe('suggest', () => {
  it('computes edit distance', () => {
    expect(editDistance('apply', 'apply')).toBe(0)
    expect(editDistance('aply', 'apply')).toBe(1)
    expect(editDistance('', 'abc')).toBe(3)
  })

  it('suggests a near miss', () => {
    expect(suggest('doctro', ['doctor', 'devices'])).toBe('doctor')
  })

  it('stays quiet when nothing is close', () => {
    expect(suggest('xyzzy', ['doctor', 'devices'])).toBeUndefined()
  })
})
