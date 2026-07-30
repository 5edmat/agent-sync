/**
 * Everything that is not the decision.
 *
 * Backups, adding and removing machines, secrets, what the agent is allowed to
 * look at, unattended sending. All of it real, none of it promoted to a
 * permanent surface — because the moment any of it gets its own tab, the screen
 * stops being "which of these goes where" and becomes an admin console.
 *
 * It is one dialog with plain sections, deliberately not a nested thing you can
 * get lost in. There is nothing below this level.
 */

import { useState } from 'react'
import type { AccountSettings, Bench, PairingSession, Snapshot } from '../api/types'
import { NEVER_ENUMERATE } from '@core/control-plane'
import { Dialog } from './Dialog'
import { cx, osLabel, relativeTime } from '../lib/words'

interface Props {
  bench: Bench
  snapshots: Snapshot[]
  settings: AccountSettings
  pairing?: PairingSession
  showTechnical: boolean
  busy: boolean
  message?: string
  onClose: () => void
  onSetTechnical: (v: boolean) => void
  onBackup: (deviceId: string) => void
  onRestore: (snapshotId: string) => void
  onForget: (deviceId: string) => void
  onRename: (deviceId: string, name: string) => void
  onAddMachine: () => void
  onCancelPairing: () => void
  onSecrets: (enabled: boolean) => void
  onAutoSync: (enabled: boolean, code: boolean) => void
  onEnumeration: (mode: AccountSettings['enumeration']['mode']) => void
}

export function More(props: Props) {
  const { bench, snapshots, settings } = props
  const [renaming, setRenaming] = useState<string | undefined>()
  const [draft, setDraft] = useState('')

  return (
    <Dialog title="Everything else" onClose={props.onClose}>
      {props.message && (
        <p role="status" className="mb-4 rounded-md border border-edge px-3 py-2 text-[13px] text-flight">
          {props.message}
        </p>
      )}

      {/* ------------------------------------------------------- machines */}
      <Section
        title="Machines"
        blurb={`${bench.devices.length} paired. ${bench.totals.stores} places config can live on ${bench.source.name}, ${bench.totals.writableStores} of which can be written.`}
      >
        <ul className="space-y-1.5">
          {bench.devices.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-edge px-3 py-2 text-[13px]"
            >
              {renaming === d.id ? (
                <>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={`New name for ${d.name}`}
                    className="min-w-0 flex-1 rounded border border-edge bg-felt px-2 py-1 text-onfelt"
                  />
                  <Small
                    onClick={() => {
                      props.onRename(d.id, draft)
                      setRenaming(undefined)
                    }}
                  >
                    Save
                  </Small>
                  <Small onClick={() => setRenaming(undefined)}>Cancel</Small>
                </>
              ) : (
                <>
                  <span className="font-medium">{d.name}</span>
                  <span className="text-dim">{osLabel(d.host)}</span>
                  {d.isSource && <span className="text-settled">source</span>}
                  <span className="ml-auto text-dimmer">{relativeTime(d.lastSeen)}</span>
                  <Small
                    onClick={() => {
                      setRenaming(d.id)
                      setDraft(d.name)
                    }}
                  >
                    Rename
                  </Small>
                  <Small onClick={() => props.onBackup(d.id)}>Back up</Small>
                  {!d.isSource && <Small onClick={() => props.onForget(d.id)}>Forget</Small>}
                </>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-2.5">
          {props.pairing ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-edge-lit px-3 py-2.5 text-[13px]">
              <span>
                Type{' '}
                <b className="font-mono tracking-wider text-flight">{props.pairing.shortCode}</b> on
                the new machine. The code works once and expires in five minutes.
              </span>
              <Small onClick={props.onCancelPairing}>Stop waiting</Small>
            </div>
          ) : (
            <Small onClick={props.onAddMachine}>Add a machine</Small>
          )}
        </div>
      </Section>

      {/* -------------------------------------------------------- backups */}
      <Section
        title="Backups"
        blurb="One is taken automatically before anything is written, so every send can be undone."
      >
        <ul className="space-y-1.5">
          {snapshots.map((s) => {
            const device = bench.devices.find((d) => d.id === s.deviceId)
            return (
              <li
                key={s.snapshotId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-edge px-3 py-2 text-[13px]"
              >
                <span className="font-medium">{device?.name ?? s.deviceId}</span>
                <span className="text-dim">{s.label ?? 'Backup'}</span>
                <span className="text-dimmer">{relativeTime(s.createdAt)}</span>
                {s.secretRefs.length > 0 && (
                  <span className="text-dim">
                    holds {s.secretRefs.length} sealed{' '}
                    {s.secretRefs.length === 1 ? 'password' : 'passwords'}
                  </span>
                )}
                <Small onClick={() => props.onRestore(s.snapshotId)}>Restore</Small>
              </li>
            )
          })}
        </ul>
      </Section>

      {/* ------------------------------------------------------ passwords */}
      <Section
        title="Passwords"
        blurb="Anything that looks like a password is stripped before it leaves a machine. Turning this on lets sealed copies travel to machines you have enrolled."
      >
        <Toggle
          checked={settings.secrets.enabled}
          onChange={props.onSecrets}
          label="Let sealed passwords travel"
        />
        {settings.secrets.phraseSavedAt && (
          <p className="mt-1 text-[12.5px] text-dimmer">
            Recovery phrase last confirmed {relativeTime(settings.secrets.phraseSavedAt)}.
          </p>
        )}
      </Section>

      {/* ------------------------------------------------------ auto-send */}
      <Section
        title="Send on its own"
        blurb="Off by default. With it on, ordinary settings propagate from the source machine without you here."
      >
        <Toggle
          checked={settings.autoSync.enabled}
          onChange={(v) =>
            props.onAutoSync(v, settings.autoSync.autoApplyRisk.includes('code-execution'))
          }
          label="Send changes from this machine automatically"
        />
        <Toggle
          checked={settings.autoSync.autoApplyRisk.includes('code-execution')}
          onChange={(v) => props.onAutoSync(settings.autoSync.enabled, v)}
          label="Include the things that run a program"
        />
        <p className="mt-1 text-[12.5px] text-dim">
          Hooks, connection commands and environment values are code. If those propagate without you,
          anyone who gets into the source machine gets into every other one. Leaving this off is the
          valve.
        </p>
      </Section>

      {/* ---------------------------------------------------- enumeration */}
      <Section
        title="What gets looked at"
        blurb="How much of a machine the agent is allowed to read."
      >
        <div className="space-y-1.5">
          {(
            [
              ['declared', 'Only the places these tools are documented to use.'],
              ['declared-plus-user', 'Those, plus folders you add on the machine itself.'],
              ['full', 'Anywhere you point it, from here.'],
            ] as const
          ).map(([mode, blurb]) => (
            <label
              key={mode}
              className="flex items-start gap-2.5 rounded-md border border-edge px-3 py-2 text-[13px]"
            >
              <input
                type="radio"
                name="enumeration"
                className="mt-1 h-4 w-4 flex-none accent-flight"
                checked={settings.enumeration.mode === mode}
                onChange={() => props.onEnumeration(mode)}
              />
              <span>{blurb}</span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-[12.5px] text-dim">
          {NEVER_ENUMERATE.length} places are never read whatever this says — keys, browser
          profiles, cloud credentials, environment files. That floor is not adjustable from here.
        </p>
      </Section>

      {/* -------------------------------------------------------- display */}
      <Section title="Display" blurb="">
        <Toggle
          checked={props.showTechnical}
          onChange={props.onSetTechnical}
          label="Show the technical name under each thing"
        />
      </Section>

      {props.busy && (
        <p role="status" className="text-[13px] text-dim">
          Working…
        </p>
      )}
    </Dialog>
  )
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string
  blurb: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-6 last:mb-0">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {blurb && <p className="mt-0.5 mb-2 text-[12.5px] text-dim">{blurb}</p>}
      {children}
    </section>
  )
}

function Small({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-edge px-2 py-0.5 text-[12px] text-dim hover:text-onfelt"
    >
      {children}
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className={cx('flex items-center gap-2.5 py-1 text-[13px]')}>
      <input
        type="checkbox"
        className="h-4 w-4 flex-none accent-flight"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}
