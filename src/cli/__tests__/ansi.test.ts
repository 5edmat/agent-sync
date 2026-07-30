import { describe, expect, it } from 'vitest'

import {
  PLAIN,
  decideColor,
  decideUnicode,
  makeStyle,
  padEnd,
  padStart,
  stripAnsi,
  symbolsFor,
  visibleWidth,
} from '../ansi.js'

const ESC = '\u001B'

describe('decideColor', () => {
  it('colours a TTY by default', () => {
    expect(decideColor({ env: {}, isTTY: true }).enabled).toBe(true)
  })

  it('never colours a pipe', () => {
    const d = decideColor({ env: {}, isTTY: false })
    expect(d.enabled).toBe(false)
    expect(d.reason).toBe('output is not a terminal')
  })

  it('honours NO_COLOR even on a TTY', () => {
    const d = decideColor({ env: { NO_COLOR: '1' }, isTTY: true })
    expect(d.enabled).toBe(false)
    expect(d.reason).toBe('NO_COLOR is set')
  })

  it('treats any non-empty NO_COLOR value as a disable', () => {
    expect(decideColor({ env: { NO_COLOR: '0' }, isTTY: true }).enabled).toBe(false)
    expect(decideColor({ env: { NO_COLOR: 'false' }, isTTY: true }).enabled).toBe(false)
  })

  it('ignores an empty NO_COLOR, per the no-color.org spec', () => {
    expect(decideColor({ env: { NO_COLOR: '' }, isTTY: true }).enabled).toBe(true)
  })

  it('disables colour for TERM=dumb', () => {
    expect(decideColor({ env: { TERM: 'dumb' }, isTTY: true }).enabled).toBe(false)
  })

  it('lets FORCE_COLOR re-enable colour on a pipe', () => {
    const d = decideColor({ env: { FORCE_COLOR: '1' }, isTTY: false })
    expect(d.enabled).toBe(true)
    expect(d.reason).toBe('FORCE_COLOR is set')
  })

  it('ignores FORCE_COLOR=0', () => {
    expect(decideColor({ env: { FORCE_COLOR: '0' }, isTTY: false }).enabled).toBe(false)
  })

  it('lets NO_COLOR win over FORCE_COLOR', () => {
    expect(decideColor({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true }).enabled).toBe(false)
  })

  it('lets an explicit flag beat every environment signal', () => {
    expect(decideColor({ env: { NO_COLOR: '1' }, isTTY: false, flag: true }).enabled).toBe(true)
    expect(decideColor({ env: { FORCE_COLOR: '1' }, isTTY: true, flag: false }).enabled).toBe(false)
  })
})

describe('makeStyle', () => {
  it('emits escape sequences when enabled', () => {
    const s = makeStyle(true)
    expect(s.red('x')).toBe(`${ESC}[31mx${ESC}[39m`)
    expect(s.bold('x')).toContain(ESC)
  })

  it('is the identity function when disabled', () => {
    const s = makeStyle(false)
    for (const fn of [s.red, s.bold, s.dim, s.green, s.yellow, s.cyan, s.gray, s.alarm, s.invert]) {
      expect(fn('x')).toBe('x')
    }
  })

  it('PLAIN never adds anything', () => {
    expect(PLAIN.alarm(' CODE EXECUTION ')).toBe(' CODE EXECUTION ')
    expect(PLAIN.enabled).toBe(false)
  })

  it('keeps the alarm style visually distinct from ordinary red', () => {
    const s = makeStyle(true)
    expect(s.alarm('x')).not.toBe(s.red('x'))
    expect(s.alarm('x')).toContain('41m')
  })
})

describe('decideUnicode', () => {
  it('allows unicode on POSIX', () => {
    expect(decideUnicode({}, 'darwin').enabled).toBe(true)
    expect(decideUnicode({}, 'linux').enabled).toBe(true)
  })

  it('defaults to ASCII on a bare Windows console', () => {
    expect(decideUnicode({}, 'win32').enabled).toBe(false)
  })

  it('allows unicode in Windows Terminal', () => {
    expect(decideUnicode({ WT_SESSION: 'abc' }, 'win32').enabled).toBe(true)
  })

  it('honours AGENTSYNC_ASCII everywhere', () => {
    expect(decideUnicode({ AGENTSYNC_ASCII: '1' }, 'darwin').enabled).toBe(false)
    expect(decideUnicode({ AGENTSYNC_ASCII: '0' }, 'darwin').enabled).toBe(true)
  })
})

describe('symbolsFor', () => {
  it('gives pure ASCII when unicode is off', () => {
    const sym = symbolsFor(false)
    for (const v of Object.values(sym)) {
      // eslint-disable-next-line no-control-regex
      expect(v).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('gives box-drawing characters when unicode is on', () => {
    expect(symbolsFor(true).boxTL).toBe('┌')
  })
})

describe('width helpers', () => {
  it('strips escape sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[39m`)).toBe('red')
  })

  it('measures visible width, not byte length', () => {
    expect(visibleWidth(`${ESC}[31mred${ESC}[39m`)).toBe(3)
  })

  it('pads to visible width so colour never skews a table', () => {
    const colored = `${ESC}[31mab${ESC}[39m`
    expect(visibleWidth(padEnd(colored, 5))).toBe(5)
    expect(visibleWidth(padStart(colored, 5))).toBe(5)
  })

  it('leaves over-long strings alone', () => {
    expect(padEnd('abcdef', 3)).toBe('abcdef')
  })
})
