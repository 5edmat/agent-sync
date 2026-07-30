/**
 * The bench.
 *
 * Two panels and one decision. The machine everything comes from is on the left;
 * every other machine is a row on the right; one button at the bottom counts
 * both dimensions of the choice you have made. Everything that is not that
 * decision lives behind `···` and stays there.
 *
 * The two panels are one instrument, not two lists. Ticking a machine changes
 * what the left panel calls a difference, because a difference is only ever
 * relative to somewhere. That coupling is why the counts can be trusted: the
 * number in the button is the sum of the numbers in the group headings.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, client } from './api/client'
import type {
  AccountSettings,
  Bench,
  PairingSession,
  Snapshot,
  SyncPreview,
  SyncResult,
} from './api/types'
import { differsOnAny, Source } from './components/Source'
import { Machines } from './components/Machines'
import { Send } from './components/Send'
import { More } from './components/More'
import { useAction, useAnnounce, useAsync } from './lib/hooks'
import { plural } from './lib/words'

export function App() {
  const bench = useAsync<Bench>(() => client.getBench(), [])
  const [announcement, say] = useAnnounce()

  // ---- the decision ------------------------------------------------------
  const [targets, setTargets] = useState<Set<string>>()
  const [chosen, setChosen] = useState<Set<string>>()

  // ---- consequences of pressing the button -------------------------------
  const [preview, setPreview] = useState<SyncPreview>()
  const [result, setResult] = useState<SyncResult>()

  // ---- everything else ---------------------------------------------------
  const [moreOpen, setMoreOpen] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [settings, setSettings] = useState<AccountSettings>()
  const [pairing, setPairing] = useState<PairingSession>()
  const [moreMessage, setMoreMessage] = useState<string>()

  const data = bench.data

  /**
   * Default: every machine that has differences is picked, and everything that
   * differs on those machines is picked with it. That is the state a person came
   * here to act on, so it is the state they arrive in.
   */
  const pickedTargets = useMemo(() => {
    if (targets) return targets
    return new Set(
      (data?.machines ?? []).filter((m) => m.state === 'differs').map((m) => m.device.id),
    )
  }, [targets, data])

  const autoChosen = useMemo(
    () =>
      new Set(
        (data?.items ?? [])
          .filter((i) => i.syncable && differsOnAny(i, pickedTargets))
          .filter((i) => [...pickedTargets].some((t) => !i.refusedOn[t]))
          .map((i) => i.id),
      ),
    [data, pickedTargets],
  )

  // `chosen` stays undefined until the first manual toggle, at which point it is
  // seeded from whatever was implied. Materialising it eagerly would freeze the
  // selection the moment a machine was ticked.
  const pickedItems = chosen ?? autoChosen

  const toggleTarget = useCallback(
    (id: string) => {
      setTargets((prev) => {
        const next = new Set(prev ?? pickedTargets)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setChosen(undefined)
    },
    [pickedTargets],
  )

  const toggleItem = useCallback(
    (id: string) => {
      setChosen((prev) => {
        const next = new Set(prev ?? autoChosen)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [autoChosen],
  )

  /** Items that would actually land on one machine: picked, and not refused there. */
  const incoming = useCallback(
    (deviceId: string) =>
      (data?.items ?? [])
        .filter(
          (i) => pickedItems.has(i.id) && !i.refusedOn[deviceId] && i.differsOn.includes(deviceId),
        )
        .map((i) => i.label),
    [data, pickedItems],
  )

  const sendable = useMemo(
    () => (data?.items ?? []).filter((i) => pickedItems.has(i.id)),
    [data, pickedItems],
  )
  const runsCode = sendable.filter((i) => i.risk === 'code-execution')

  // ---- actions -----------------------------------------------------------
  const doPreview = useAction(async () => {
    if (!data) return
    const pv = await client.previewSync({
      sourceDeviceId: data.source.id,
      itemIds: [...pickedItems],
      targetDeviceIds: [...pickedTargets],
    })
    setResult(undefined)
    setPreview(pv)
  })

  const doApply = useAction(async (approvals: Record<string, number[]>) => {
    if (!preview) return
    const res = await client.applySync(preview.previewId, approvals)
    setResult(res)
    say(
      res.devices
        .map((d) => `${d.deviceName}: ${d.outcome === 'waiting' ? 'held for later' : d.outcome}`)
        .join('. '),
    )
    bench.reload()
    setChosen(undefined)
  })

  const doSetSource = useAction(async (deviceId: string) => {
    const next = await client.setSourceDevice(deviceId)
    bench.set(next)
    setTargets(undefined)
    setChosen(undefined)
    say(`${next.source.name} is now the machine everything comes from.`)
  })

  const openMore = useCallback(async () => {
    setMoreOpen(true)
    setMoreMessage(undefined)
    const [s, cfg] = await Promise.all([client.listSnapshots(), client.getSettings()])
    setSnapshots(s)
    setSettings(cfg)
  }, [])

  const more = useAction(async (fn: () => Promise<void>) => {
    setMoreMessage(undefined)
    try {
      await fn()
    } catch (e) {
      setMoreMessage(e instanceof ApiError ? e.message : String(e))
    }
  })

  useEffect(() => {
    if (data) document.title = `${data.source.name} — your machines, side by side`
  }, [data])

  // ---- render ------------------------------------------------------------
  if (bench.error) {
    return (
      <Shell>
        <p className="text-[14px] text-exec">
          Could not reach the control plane. {bench.error.message}
        </p>
        <button
          type="button"
          className="mt-3 rounded-lg border border-edge px-3 py-1.5 text-[13px]"
          onClick={bench.reload}
        >
          Try again
        </button>
      </Shell>
    )
  }

  if (!data) {
    return (
      <Shell>
        <p role="status" className="text-[14px] text-dim">
          Reading what is on your machines…
        </p>
      </Shell>
    )
  }

  const itemCount = sendable.length
  const machineCount = pickedTargets.size
  // "Pick a machine" first: with nothing ticked there is nothing to be different
  // FROM, so "Nothing picked" would be the second question, not the first.
  const buttonLabel =
    machineCount === 0
      ? 'Pick a machine'
      : itemCount === 0
        ? 'Nothing picked'
        : `Send ${plural(itemCount, 'item')} to ${plural(machineCount, 'machine')}`

  return (
    <Shell>
      <div className="mb-5 flex flex-wrap items-baseline gap-2.5">
        <h1 className="text-[17px] font-semibold tracking-[-0.015em]">{data.source.name}</h1>
        <p className="text-[13.5px] text-dim">
          is the source · {plural(data.machines.length, 'other machine')} ·{' '}
          {plural(data.totals.tracked, 'thing')} tracked
        </p>
        <button
          type="button"
          className="ml-auto rounded-md border border-edge px-2.5 py-1.5 text-[14px] text-dim hover:text-onfelt"
          onClick={() => void openMore()}
          aria-haspopup="dialog"
          title="Backups, machines, passwords, settings"
        >
          <span aria-hidden="true">···</span>
          <span className="sr-only">Everything else</span>
        </button>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Source
          bench={data}
          targets={pickedTargets}
          chosen={pickedItems}
          onToggleItem={toggleItem}
          onChangeSource={(id) => void doSetSource.run(id)}
          showTechnical={showTechnical}
        />

        <Machines
          machines={data.machines}
          targets={pickedTargets}
          onToggleTarget={toggleTarget}
          incoming={incoming}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={itemCount === 0 || machineCount === 0 || doPreview.pending}
          onClick={() => void doPreview.run()}
          className="rounded-lg bg-flight px-5 py-2.5 text-[15px] font-semibold text-flight-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {doPreview.pending ? 'Working out what changes…' : buttonLabel}
        </button>

        {runsCode.length > 0 && (
          <p className="text-[13px] text-dim">
            {runsCode.map((i) => i.label).join(', ')}{' '}
            <b className="font-semibold text-onfelt">
              {runsCode.length === 1 ? 'runs a program' : 'run programs'}
            </b>{' '}
            — you’ll confirm {runsCode.length === 1 ? 'that one' : 'those'}.
          </p>
        )}
        {doPreview.error && <p className="text-[13px] text-exec">{doPreview.error.message}</p>}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {preview && (
        <Send
          preview={preview}
          {...(result ? { result } : {})}
          pending={doApply.pending}
          {...(doApply.error ? { error: doApply.error.message } : {})}
          onConfirm={(approvals) => void doApply.run(approvals)}
          onClose={() => {
            setPreview(undefined)
            setResult(undefined)
            doApply.clearError()
          }}
        />
      )}

      {moreOpen && settings && (
        <More
          bench={data}
          snapshots={snapshots}
          settings={settings}
          {...(pairing ? { pairing } : {})}
          showTechnical={showTechnical}
          busy={more.pending}
          {...(moreMessage ? { message: moreMessage } : {})}
          onClose={() => setMoreOpen(false)}
          onSetTechnical={setShowTechnical}
          onBackup={(id) => void more.run(async () => setSnapshots(await client.createSnapshot(id)))}
          onRestore={(id) =>
            void more.run(async () => {
              const r = await client.restoreSnapshot(id)
              setMoreMessage(
                r.unresolvedSecrets.length
                  ? `${r.restored} things put back. ${plural(r.unresolvedSecrets.length, 'sealed password')} could not be opened on that machine.`
                  : `${r.restored} things put back.`,
              )
              bench.reload()
            })
          }
          onForget={(id) =>
            void more.run(async () => {
              await client.removeDevice(id)
              bench.reload()
            })
          }
          onRename={(id, name) =>
            void more.run(async () => {
              await client.renameDevice(id, name)
              bench.reload()
            })
          }
          onAddMachine={() => void more.run(async () => setPairing(await client.startPairing()))}
          onCancelPairing={() =>
            void more.run(async () => {
              if (pairing) await client.cancelPairing(pairing.pairingId)
              setPairing(undefined)
            })
          }
          onSecrets={(v) => void more.run(async () => setSettings(await client.setSecretsSync(v)))}
          onAutoSync={(enabled, code) =>
            void more.run(async () =>
              setSettings(await client.setAutoSync({ enabled, autoApplyCodeExecution: code })),
            )
          }
          onEnumeration={(mode) =>
            void more.run(async () => setSettings(await client.requestEnumerationChange(mode)))
          }
        />
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-[980px] px-5 pt-8 pb-20">{children}</main>
}
