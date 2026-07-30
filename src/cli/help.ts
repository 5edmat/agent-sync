/**
 * Help text.
 *
 * Generated from the same `CommandSpec` objects the parser validates against,
 * so a flag can never exist without being documented and can never be
 * documented without existing.
 */

import type { CommandSpec, FlagSpec } from './args.js'
import { GLOBAL_FLAGS } from './args.js'
import type { Ctx } from './context.js'
import { EXIT, EXIT_MEANING, type ExitCode } from './exit.js'
import { padEnd } from './ansi.js'

export const helpSpec: CommandSpec = {
  name: 'help',
  summary: 'Show help for agentsync or for one command.',
  usage: 'agentsync help [command]',
  flags: {},
  positionals: [{ name: 'command', required: false, description: 'Command to describe.' }],
}

export const versionSpec: CommandSpec = {
  name: 'version',
  summary: 'Print the version.',
  usage: 'agentsync version',
  flags: {},
}

function flagLine(name: string, spec: FlagSpec, width: number): string {
  const alias = spec.alias ? `-${spec.alias}, ` : '    '
  const value = spec.type === 'string' ? ` ${spec.placeholder ?? '<value>'}` : ''
  return `${padEnd(`  ${alias}--${name}${value}`, width)}  ${spec.description}`
}

export function renderTopLevelHelp(ctx: Ctx, commands: Record<string, CommandSpec>): void {
  const s = ctx.style
  const visible = Object.values(commands).filter((c) => c.name !== 'help' && c.name !== 'version')

  ctx.out()
  ctx.out(`${s.bold('agentsync')} ${s.gray(ctx.deps.version)} — keep your agent config the same on every machine.`)
  ctx.out()
  ctx.out(s.bold('USAGE'))
  ctx.out('  agentsync <command> [options]')
  ctx.out()

  ctx.out(s.bold('COMMANDS'))
  const width = Math.max(...visible.map((c) => c.name.length)) + 4
  for (const c of visible) {
    ctx.out(`  ${s.cyan(padEnd(c.name, width))}${c.summary}`)
  }
  ctx.out()

  ctx.out(s.bold('GLOBAL OPTIONS'))
  const gwidth = Math.max(...Object.entries(GLOBAL_FLAGS).map(([n, f]) => n.length + (f.placeholder?.length ?? 0))) + 16
  for (const [name, spec] of Object.entries(GLOBAL_FLAGS)) {
    ctx.out(flagLine(name, spec, gwidth))
  }
  ctx.out()

  ctx.out(s.bold('EXIT CODES'))
  for (const code of [0, 1, 2, 3, 4] as ExitCode[]) {
    ctx.out(`  ${s.cyan(String(code))}  ${EXIT_MEANING[code]}`)
  }
  ctx.out()

  ctx.out(s.bold('GETTING STARTED'))
  ctx.out(`  ${s.cyan('agentsync init')}     ${s.gray('detect this machine and create local state')}`)
  ctx.out(`  ${s.cyan('agentsync doctor')}   ${s.gray('diagnose anything that looks wrong')}`)
  ctx.out()
}

export function renderCommandHelp(ctx: Ctx, spec: CommandSpec): void {
  const s = ctx.style
  ctx.out()
  ctx.out(`${s.bold(`agentsync ${spec.name}`)} — ${spec.summary}`)
  ctx.out()
  ctx.out(s.bold('USAGE'))
  ctx.out(`  ${spec.usage}`)
  ctx.out()

  if (spec.description) {
    for (const line of wrap(spec.description, 76)) ctx.out(`  ${line}`)
    ctx.out()
  }

  if (spec.positionals && spec.positionals.length > 0) {
    ctx.out(s.bold('ARGUMENTS'))
    const width = Math.max(...spec.positionals.map((p) => p.name.length)) + 6
    for (const p of spec.positionals) {
      ctx.out(`  ${padEnd(`<${p.name}>`, width)}${p.description}${p.required ? '' : s.gray('  (optional)')}`)
    }
    ctx.out()
  }

  const entries = Object.entries(spec.flags)
  if (entries.length > 0) {
    ctx.out(s.bold('OPTIONS'))
    const width = Math.max(...entries.map(([n, f]) => n.length + (f.placeholder?.length ?? 0))) + 16
    for (const [name, flag] of entries) ctx.out(flagLine(name, flag, width))
    ctx.out()
  }

  ctx.out(s.bold('EXIT CODES'))
  ctx.out(`  ${s.cyan('0')}  ${EXIT_MEANING[EXIT.OK]}`)
  ctx.out(`  ${s.cyan('1')}  ${EXIT_MEANING[EXIT.ERROR]}`)
  ctx.out(`  ${s.cyan('2')}  ${EXIT_MEANING[EXIT.USAGE]}`)
  for (const note of spec.exitNotes ?? []) ctx.out(`  ${s.cyan(note.slice(0, 1))}  ${note.slice(4)}`)
  ctx.out()

  if (spec.examples && spec.examples.length > 0) {
    ctx.out(s.bold('EXAMPLES'))
    for (const e of spec.examples) ctx.out(`  ${s.gray('$')} ${e}`)
    ctx.out()
  }

  ctx.out(s.gray('  Global options (--json, --no-color, --state-dir, ...) work here too. See `agentsync help`.'))
  ctx.out()
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line)
      line = w
    } else {
      line = line ? `${line} ${w}` : w
    }
  }
  if (line) lines.push(line)
  return lines
}

export function helpJson(commands: Record<string, CommandSpec>, version: string): Record<string, unknown> {
  return {
    ok: true,
    command: 'help',
    exitCode: EXIT.OK,
    version,
    exitCodes: EXIT_MEANING,
    globalFlags: GLOBAL_FLAGS,
    commands: Object.values(commands).map((c) => ({
      name: c.name,
      summary: c.summary,
      usage: c.usage,
      flags: c.flags,
      positionals: c.positionals ?? [],
    })),
  }
}
