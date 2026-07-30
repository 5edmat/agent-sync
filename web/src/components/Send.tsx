/**
 * What pressing the button does.
 *
 * Not a screen and not a step in a wizard — the consequence of one action, shown
 * before it happens. It exists at all for one reason: `risk: 'code-execution'`
 * changes need an explicit yes, and an approval is bound to a plan INDEX, so it
 * cannot be collected anywhere but here, against this plan.
 *
 * Everything else in it is per machine, because each target diffs against its
 * own observed state and one shared answer would be lying to at least one of
 * them.
 */

import { useState } from 'react'
import type { SyncPreview, SyncResult } from '../api/types'
import { Dialog } from './Dialog'
import { cx, plural, untilTime } from '../lib/words'

interface Props {
  preview: SyncPreview
  result?: SyncResult
  pending: boolean
  error?: string
  onConfirm: (approvals: Record<string, number[]>) => void
  onClose: () => void
}

export function Send({ preview, result, pending, error, onConfirm, onClose }: Props) {
  const [approved, setApproved] = useState<Record<string, Set<number>>>({})

  const needed = preview.targets.flatMap((t) =>
    t.needsApproval.map((g) => ({ deviceId: t.deviceId, group: g })),
  )
  const isApproved = (deviceId: string, indexes: number[]) =>
    indexes.every((i) => approved[deviceId]?.has(i))
  const outstanding = needed.filter((n) => !isApproved(n.deviceId, n.group.indexes)).length
  const allApproved = outstanding === 0

  // One yes covers every plan index the item touches — the GitHub connection is
  // two changes in each of two files, and nobody consents to that four times.
  const toggle = (deviceId: string, indexes: number[]) =>
    setApproved((prev) => {
      const next = new Set(prev[deviceId] ?? [])
      const on = indexes.every((i) => next.has(i))
      for (const i of indexes) {
        if (on) next.delete(i)
        else next.add(i)
      }
      return { ...prev, [deviceId]: next }
    })

  if (result) {
    return (
      <Dialog title="What happened" onClose={onClose}>
        <ul className="space-y-3">
          {result.devices.map((d) => (
            <li key={d.deviceId} className="rounded-md border border-edge px-3.5 py-3">
              <p className="text-[13.5px] font-semibold">{d.deviceName}</p>
              <p
                className={cx(
                  'text-[13px]',
                  d.outcome === 'applied' || d.outcome === 'partial'
                    ? 'text-settled'
                    : d.outcome === 'waiting'
                      ? 'text-flight'
                      : 'text-dim',
                )}
              >
                {outcomeSentence(d)}
              </p>
              {d.note && <p className="text-[12.5px] text-dim">{d.note}</p>}
              {d.snapshotId && (
                <p className="text-[12.5px] text-dimmer">
                  A backup was taken first, so this can be undone.
                </p>
              )}
            </li>
          ))}
        </ul>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Before this goes"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={!allApproved || pending}
            onClick={() =>
              onConfirm(
                Object.fromEntries(Object.entries(approved).map(([k, v]) => [k, [...v]])),
              )
            }
            className="rounded-lg bg-flight px-5 py-2.5 text-[14px] font-semibold text-flight-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? 'Sending…' : 'Send it'}
          </button>
          {!allApproved && (
            <span className="text-[13px] text-dim">
              {plural(outstanding, 'thing')} below {outstanding === 1 ? 'runs' : 'run'} a program on
              the other machine. Confirm {outstanding === 1 ? 'it' : 'them'} to continue.
            </span>
          )}
          {error && <span className="text-[13px] text-exec">{error}</span>}
        </>
      }
    >
      <ul className="space-y-3">
        {preview.targets.map((t) => (
          <li key={t.deviceId} className="rounded-md border border-edge px-3.5 py-3">
            <p className="text-[13.5px] font-semibold">{t.deviceName}</p>

            {t.deferred ? (
              <p className="text-[13px] text-flight">
                {t.deferred.reason} This is held and applied {untilTime(t.deferred.retryAfter)}.
              </p>
            ) : (
              <p className="text-[13px] text-dim">
                {writes(t) === 0 ? 'Nothing to write.' : `${plural(writes(t), 'change')} to write.`}
              </p>
            )}

            {t.needsApproval.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {t.needsApproval.map((g) => (
                  <li key={g.label}>
                    <label className="flex items-start gap-2.5 rounded-md border border-edge bg-felt px-2.5 py-2 text-[12.5px]">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 flex-none accent-flight"
                        checked={isApproved(t.deviceId, g.indexes)}
                        onChange={() => toggle(t.deviceId, g.indexes)}
                      />
                      <span className="min-w-0">
                        <span className="text-exec">
                          {g.label} runs a program on {t.deviceName}.
                        </span>{' '}
                        {g.commands.length > 0 && (
                          <code className="font-mono break-all text-onfelt">
                            {g.commands.join(' ')}
                          </code>
                        )}
                        <span className="block text-[11.5px] break-all text-dimmer">
                          {g.wheres.join(' · ')}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {t.withheld.length > 0 && (
              <p className="mt-1.5 text-[12.5px] text-dim">
                {plural(t.withheld.length, 'value')} looked like a password and{' '}
                {t.withheld.length === 1 ? 'was' : 'were'} left behind. Everything else about{' '}
                {t.withheld.length === 1 ? 'it' : 'them'} still travels.
              </p>
            )}

            {t.noEffect.length > 0 && (
              <p className="mt-1.5 text-[12.5px] text-dim">
                {plural(t.noEffect.length, 'change')} will land and change nothing — either a policy
                already sets it, or the tool will not read it there yet.
              </p>
            )}

            {t.refused.length > 0 && (
              <p className="mt-1.5 text-[12.5px] text-dim">
                {plural(t.refused.length, 'thing')} can’t be written here: {t.refused[0]?.refusal.message}
              </p>
            )}

            {t.shadowWarnings.map((w) => (
              <p key={w.writing} className="mt-1.5 text-[12.5px] text-exec">
                <span aria-hidden="true">▲ </span>
                {w.message}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

/**
 * Changes, not items — and counted the same way the result counts them.
 *
 * An approval group is one question and several plan indexes, so counting groups
 * here would preview "19 changes" and report "22 written" for the same send.
 */
function writes(t: SyncPreview['targets'][number]): number {
  return t.automatic.length + t.needsApproval.reduce((n, g) => n + g.indexes.length, 0)
}

function outcomeSentence(d: SyncResult['devices'][number]): string {
  switch (d.outcome) {
    case 'applied':
      return `${plural(d.appliedCount, 'change')} written.`
    case 'partial':
      return `${plural(d.appliedCount, 'change')} written, with something worth reading below.`
    case 'waiting':
      return 'Held until this machine is free. It will apply on its own.'
    case 'held':
      return 'Nothing needed writing.'
    case 'refused':
      return 'Nothing could be written here.'
  }
}
