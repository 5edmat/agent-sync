/**
 * Every other machine, as a collapsed row — the right half of the bench.
 *
 * A row says four things and no more: what it is called, what it runs, what
 * state it is in, and whether it is picked. Everything else waits until it is
 * opened, and what is inside is specific to THAT machine: the same send produces
 * different changes on a Mac and a Windows box, because each machine diffs
 * against its own observed state.
 *
 * The four states are words first and colours second. `blocked` never reads as
 * an error — a CI runner whose Linux paths have never been confirmed against a
 * real install is behaving exactly as designed.
 */

import { useState } from 'react'
import type { MachineRow, MachineState } from '../api/types'
import { cx, joinNames, osLabel, relativeTime, untilTime } from '../lib/words'

const STATE_WORD: Record<MachineState, string> = {
  differs: 'differences',
  'in-sync': 'in sync',
  new: 'not set up yet',
  blocked: 'can’t write yet',
}

const STATE_CLASS: Record<MachineState, string> = {
  differs: 'text-flight font-semibold',
  'in-sync': 'text-settled',
  new: 'text-dim',
  blocked: 'text-exec',
}

interface Props {
  machines: MachineRow[]
  targets: Set<string>
  onToggleTarget: (id: string) => void
  /** How many of the picked items this machine would actually receive. */
  incoming: (deviceId: string) => string[]
}

export function Machines({ machines, targets, onToggleTarget, incoming }: Props) {
  if (!machines.length) {
    return (
      <p className="bay rounded-[9px] border border-dashed border-edge-lit px-4 py-6 text-center text-[13px] text-dim">
        This is the only machine here. Add another one behind <span aria-hidden="true">···</span>
        <span className="sr-only">the Everything else button</span> and it will appear in this
        column.
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-[7px]">
      {machines.map((m) => (
        <li key={m.device.id}>
          <Row
            row={m}
            picked={targets.has(m.device.id)}
            onToggle={() => onToggleTarget(m.device.id)}
            incoming={incoming(m.device.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function Row({
  row,
  picked,
  onToggle,
  incoming,
}: {
  row: MachineRow
  picked: boolean
  onToggle: () => void
  incoming: string[]
}) {
  const [open, setOpen] = useState(false)
  const { device, state } = row
  const panelId = `machine-${device.id}`
  const canReceive = state !== 'blocked'

  const stateText =
    state === 'differs' ? `${row.differing.length} ${STATE_WORD.differs}` : STATE_WORD[state]

  return (
    <div
      className={cx(
        'overflow-hidden rounded-[9px] border bg-felt-deep',
        open ? 'border-edge-lit' : 'border-edge',
        !canReceive && 'opacity-70',
      )}
    >
      <div className="flex items-center">
        <label
          className={cx(
            'flex flex-none cursor-pointer items-center self-stretch pl-3.5',
            !canReceive && 'cursor-not-allowed',
          )}
        >
          <input
            type="checkbox"
            className="h-[17px] w-[17px] flex-none accent-flight"
            checked={picked}
            disabled={!canReceive}
            onChange={onToggle}
          />
          <span className="sr-only">
            Send to {device.name} ({osLabel(device.host)}, {stateText})
          </span>
        </label>

        <button
          type="button"
          className="flex flex-1 items-center gap-2.5 px-3 py-3 text-left hover:bg-felt-raise"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            aria-hidden="true"
            className={cx('twist w-2 flex-none text-[9px] text-dim', open && 'twist-open')}
          >
            ▶
          </span>
          <span className="truncate text-[14px] font-semibold">{device.name}</span>
          <span className="flex-none text-[12.5px] text-dim">{osLabel(device.host)}</span>
          <span className={cx('tnum ml-auto flex-none text-[12.5px]', STATE_CLASS[state])}>
            {stateText}
          </span>
        </button>
      </div>

      <div id={panelId} hidden={!open} className="px-3.5 pt-0 pb-3.5 pl-12">
        <Panel row={row} incoming={incoming} picked={picked} />
      </div>
    </div>
  )
}

function Panel({
  row,
  incoming,
  picked,
}: {
  row: MachineRow
  incoming: string[]
  picked: boolean
}) {
  const { device, state } = row

  return (
    <div className="space-y-1.5 text-[12.5px]">
      {state === 'new' && (
        <Slot filling={picked}>
          Nothing here yet — all {row.differing.length} things that travel would be new.
        </Slot>
      )}

      {state !== 'new' &&
        row.missing.map((g) => (
          <Slot key={g.title} filling={picked}>
            <span className="text-dim">{g.title}</span> — {joinNames(g.labels, 4)}
          </Slot>
        ))}

      {state === 'in-sync' && <Note>Everything that travels already matches.</Note>}

      {/* Per-machine refusals, in core's own words, one row per reason. */}
      {row.refused.map(({ refusal, labels }) => (
        <div key={refusal.reason} className="pt-1">
          <p className="break-words text-exec">
            {labels.length} {labels.length === 1 ? 'thing' : 'things'} can’t be written here —{' '}
            {refusal.message}
          </p>
          {refusal.remedy && refusal.actionable && (
            <p className="break-words text-dim">{refusal.remedy}</p>
          )}
          <p className="break-words text-dimmer">{joinNames(labels, 4)}</p>
        </div>
      ))}

      {/* `detectShadowing()`. A write that looks purely additive and is quietly
          destructive, so it goes above everything else that is merely a note. */}
      {row.shadowWarnings.map((w) => (
        <p key={w.writing} className="break-words pt-1 text-exec">
          <span aria-hidden="true">▲ </span>
          {w.message}
        </p>
      ))}

      {row.overridden.length > 0 && (
        <Note>
          {joinNames(row.overridden.map((o) => o.label))} — your organisation sets{' '}
          {row.overridden.length === 1 ? 'this' : 'these'} here, so{' '}
          {row.overridden.length === 1 ? 'it will not change' : 'they will not change'}.
        </Note>
      )}

      {row.inert.map((i) => (
        <Note key={i.label}>
          {i.label} — {i.reason}
        </Note>
      ))}

      {row.withheld.map((w) => (
        <Note key={w.label}>
          {w.label} carries a password, so the password stays on this machine. Everything else about
          it travels.
        </Note>
      ))}

      {row.deferred && (
        <Note>
          {row.deferred.reason} Anything sent now is held and applied{' '}
          {untilTime(row.deferred.retryAfter)}.
        </Note>
      )}

      {row.weakDetection.map((w) => (
        <Note key={w}>{w}</Note>
      ))}

      {row.notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}

      {picked && incoming.length > 0 && (
        <p className="pt-1 text-flight">
          {incoming.length} of what you picked would land here.
        </p>
      )}

      <Note>
        {device.lastSeen ? `Seen ${relativeTime(device.lastSeen)}.` : 'Has never reported in.'}
        {device.agentVersion ? ` Running ${device.agentVersion}.` : ''}
      </Note>
    </div>
  )
}

/**
 * An empty slot on the machine, with the shape of the thing that would fill it.
 *
 * Dashed when nothing is on its way, solid-warm when the machine is picked and
 * this is one of the things that would land. Shape carries it; the colour only
 * confirms.
 */
function Slot({ children, filling }: { children: React.ReactNode; filling: boolean }) {
  return (
    <div
      className={cx(
        'flex items-center gap-2.5 rounded-md border border-dashed px-2.5 py-1.5',
        filling
          ? 'border-flight/55 bg-flight-soft text-[#e3be85]'
          : 'bay border-edge-lit text-[#9aa0a5]',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('h-1.5 w-1.5 flex-none rounded-full', filling ? 'bg-flight' : 'bg-[#4a5055]')}
      />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="break-words text-dim">{children}</p>
}
