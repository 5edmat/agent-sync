/**
 * The source machine — the left half of the bench.
 *
 * A warm paper object on a dark surface, sticky, scrolling inside itself. It
 * answers one question: what is on this machine, and which of it does not match
 * the machines you have picked.
 *
 * The counts here are SCOPED TO THE PICKED MACHINES, and that is the whole
 * reason the two panels are one instrument rather than two lists. "2 of 37" does
 * not mean "two skills are unusual somewhere in the world"; it means two of your
 * thirty-seven skills are missing from the machines currently ticked. Untick a
 * machine and the number falls. The button at the bottom is the same arithmetic
 * said out loud.
 */

import { useMemo, useState } from 'react'
import type { Bench, ConfigItem, ItemGroup } from '../api/types'
import { cx, joinNames, osLabel, plural, SCOPE_WORD } from '../lib/words'

interface Props {
  bench: Bench
  /** Machines currently ticked. Every count below is relative to these. */
  targets: Set<string>
  chosen: Set<string>
  onToggleItem: (id: string) => void
  onChangeSource: (deviceId: string) => void
  showTechnical: boolean
}

type Filter = 'differences' | 'everything'

/** Does this item differ on at least one machine the person has ticked? */
export function differsOnAny(item: ConfigItem, targets: Set<string>): boolean {
  return item.differsOn.some((id) => targets.has(id))
}

/** Machines that have ticked this item and cannot take it, with core's reason. */
function refusedBy(item: ConfigItem, targets: Set<string>) {
  return [...targets].map((id) => item.refusedOn[id]).filter(Boolean)
}

export function Source({
  bench,
  targets,
  chosen,
  onToggleItem,
  onChangeSource,
  showTechnical,
}: Props) {
  const [filter, setFilter] = useState<Filter>('differences')
  const [swapping, setSwapping] = useState(false)
  /** Only groups a person has explicitly opened or closed. Absent means default. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  const scoped = useMemo(
    () =>
      bench.groups.map((g) => ({
        group: g,
        differing: g.items.filter((i) => differsOnAny(i, targets)),
      })),
    [bench.groups, targets],
  )

  const totalDiffering = scoped.reduce((n, g) => n + g.differing.length, 0)

  // Open by default when the group has a difference in it. Nobody should have
  // to hunt for the thing they came here to find, and nothing that is already
  // settled should be in the way of it.
  const isOpen = (key: string, hasDifference: boolean) => overrides[key] ?? hasDifference
  const toggleGroup = (key: string, hasDifference: boolean) =>
    setOverrides((prev) => ({ ...prev, [key]: !(prev[key] ?? hasDifference) }))

  const others = bench.devices.filter((d) => d.id !== bench.source.id)

  return (
    <div className="flex max-h-[calc(100vh-3rem)] flex-col rounded-[10px] bg-paper text-ink shadow-machine lg:sticky lg:top-6">
      {/* ---------------------------------------------------------- header */}
      <div className="border-b border-paper-edge px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[14.5px] leading-tight font-semibold">{bench.source.name}</h2>
          <span className="rounded-[3px] bg-[#e3e8e4] px-1.5 py-0.5 text-[10px] font-bold tracking-[0.08em] text-settled-on-paper uppercase">
            source
          </span>
          <button
            type="button"
            className="ml-auto rounded-md border border-paper-edge px-2 py-0.5 text-[12px] text-ink-2 hover:border-[#c9c4bb] hover:text-ink"
            aria-expanded={swapping}
            onClick={() => setSwapping((v) => !v)}
          >
            change
          </button>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-2">
          {osLabel(bench.source.host)} · this machine · {plural(bench.totals.tracked, 'thing')}
        </p>
      </div>

      {/* --------------------------------------------- pick another source */}
      {swapping && (
        <div className="anim-in border-b border-paper-edge bg-paper-sub px-4 py-3">
          <p className="mb-2 text-[12.5px] text-ink-2">
            Whichever machine is the source, the others copy from it.
          </p>
          <ul className="space-y-1">
            {others.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-paper-edge bg-paper-face px-2.5 py-1.5 text-left text-[13px] hover:border-[#c9c4bb]"
                  onClick={() => {
                    setSwapping(false)
                    onChangeSource(d.id)
                  }}
                >
                  {d.name}
                  <span className="ml-auto text-[11.5px] text-ink-3">{osLabel(d.host)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------------------------------------------------- filter */}
      <div className="flex gap-1 px-4 pt-3" role="group" aria-label="What to show">
        <FilterButton on={filter === 'differences'} onClick={() => setFilter('differences')}>
          Differences · {totalDiffering}
        </FilterButton>
        <FilterButton on={filter === 'everything'} onClick={() => setFilter('everything')}>
          Everything · {bench.totals.tracked}
        </FilterButton>
      </div>

      {/* ---------------------------------------------------------- groups */}
      <div className="flex-1 overflow-y-auto px-4 pt-2 pb-4">
        {filter === 'differences' && totalDiffering === 0 && (
          <p className="py-6 text-center text-[13px] text-ink-2">
            {targets.size === 0
              ? 'Tick a machine on the right to see what it is missing.'
              : 'Everything matches on the machines you picked.'}
          </p>
        )}

        {scoped.map(({ group, differing }) => {
          const shown = filter === 'differences' ? differing : group.items
          if (!shown.length) return null
          const hasDifference = differing.length > 0
          return (
            <Group
              key={group.key}
              group={group}
              shown={shown}
              differingCount={differing.length}
              open={isOpen(group.key, hasDifference)}
              onToggle={() => toggleGroup(group.key, hasDifference)}
              targets={targets}
              chosen={chosen}
              onToggleItem={onToggleItem}
              showTechnical={showTechnical}
              showMatchNote={filter === 'everything'}
            />
          )
        })}
      </div>
    </div>
  )
}

function FilterButton({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'tnum rounded-full border px-2.5 py-1 text-[12px]',
        on
          ? 'border-ink bg-ink font-semibold text-paper'
          : 'border-paper-edge text-ink-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

function Group({
  group,
  shown,
  differingCount,
  open,
  onToggle,
  targets,
  chosen,
  onToggleItem,
  showTechnical,
  showMatchNote,
}: {
  group: ItemGroup
  shown: ConfigItem[]
  differingCount: number
  open: boolean
  onToggle: () => void
  targets: Set<string>
  chosen: Set<string>
  onToggleItem: (id: string) => void
  showTechnical: boolean
  showMatchNote: boolean
}) {
  const bodyId = `grp-${group.key}`
  const matching = group.total - differingCount

  return (
    <section className="border-b border-[#ece8e1] last:border-b-0">
      <h3>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 py-2.5 text-left text-[13px] hover:text-black"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span
            aria-hidden="true"
            className={cx('twist w-2 flex-none text-[9px] text-ink-3', open && 'twist-open')}
          >
            ▶
          </span>
          <span className="font-semibold">{group.title}</span>
          <span className="tnum ml-auto text-[12px] text-ink-3">
            {group.key === 'stays-put' ? (
              group.total
            ) : (
              <>
                <b className="font-bold text-flight">{differingCount}</b> of {group.total}
              </>
            )}
          </span>
        </button>
      </h3>

      <div id={bodyId} hidden={!open} className="pb-2">
        <ul className="space-y-1.5">
          {shown.map((item) => (
            <li key={item.id}>
              <Chip
                item={item}
                targets={targets}
                selected={chosen.has(item.id)}
                onToggle={() => onToggleItem(item.id)}
                showTechnical={showTechnical}
              />
            </li>
          ))}
        </ul>

        {showMatchNote && matching > 0 && group.key !== 'stays-put' && (
          <p className="px-0.5 pt-1.5 text-[12px] text-ink-3">
            {matching === group.total
              ? 'All of these already match.'
              : `${matching} more already match.`}
          </p>
        )}

        {group.note && <p className="px-0.5 pt-1.5 text-[12px] text-ink-3">{group.note}</p>}
      </div>
    </section>
  )
}

/**
 * One thing, one line.
 *
 * The right-hand word is never decoration — it is the reason this item will not
 * behave like the others, and every one of them comes from the engine:
 * `Change.risk`, `Change.blocked`, `Change.overriddenBy`, `Change.inert`, or a
 * `writeVerdict` refusal.
 */
function Chip({
  item,
  targets,
  selected,
  onToggle,
  showTechnical,
}: {
  item: ConfigItem
  targets: Set<string>
  selected: boolean
  onToggle: () => void
  showTechnical: boolean
}) {
  const refusals = refusedBy(item, targets)
  const differs = differsOnAny(item, targets)
  const blockedEverywhere = targets.size > 0 && refusals.length === targets.size
  const overridden = [...targets].some((id) => item.overriddenOn[id])
  const inert = [...targets].some((id) => item.inertOn[id])

  const stuck = !item.syncable || blockedEverywhere
  const disabled = stuck || !differs

  const note = !item.syncable
    ? item.staysPutBecause
    : blockedEverywhere
      ? refusals[0]?.headline
      : item.withheld
        ? 'password held back'
        : overridden
          ? 'policy wins here'
          : inert
            ? 'lands, does nothing'
            : item.risk === 'code-execution'
              ? 'runs a program'
              : !differs
                ? 'matches'
                : undefined

  // Colour is never the only signal: the dot has a colour AND the row has a
  // word, and the accessible name spells out the whole state.
  const dot = !item.syncable
    ? 'bg-[#c8c4bc]'
    : blockedEverywhere
      ? 'bg-[#c8c4bc]'
      : item.risk === 'code-execution'
        ? 'bg-exec'
        : selected
          ? 'bg-flight'
          : 'bg-[#c8c4bc]'

  return (
    <button
      type="button"
      aria-pressed={disabled ? undefined : selected}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-md border bg-paper-face px-2.5 py-2 text-left text-[13px]',
        'disabled:cursor-default',
        stuck && 'opacity-55',
        !stuck && !differs && 'opacity-50',
        selected && !disabled
          ? 'border-flight shadow-[0_0_0_2px_rgb(216_146_44_/_0.18)]'
          : 'border-paper-edge',
      )}
    >
      <span aria-hidden="true" className={cx('h-[7px] w-[7px] flex-none rounded-full', dot)} />
      <span className="min-w-0">
        <span className="block truncate">{item.label}</span>
        {showTechnical && (
          <>
            <span className="block truncate font-mono text-[10.5px] text-ink-3">
              {item.technicalKey} · {item.anchors[0]?.where}
            </span>
            {/* `StoreDescriptor.subtree` and `fileId`. Two things in one file are
                two stores, and apply() coalesces them into ONE atomic write —
                which is worth knowing before you send one and not the other. */}
            {item.subtree && item.filePeers.length > 0 && (
              <span className="block text-[10.5px] text-ink-3">
                one part of that file, which also holds {item.filePeers.length} other{' '}
                {item.filePeers.length === 1 ? 'thing' : 'things'} — they land in a single write
              </span>
            )}
            <span className="block text-[10.5px] text-ink-3">{SCOPE_WORD[item.scope]}</span>
          </>
        )}
      </span>
      {note && (
        <span
          className={cx(
            'ml-auto flex-none text-[11px] whitespace-nowrap',
            item.risk === 'code-execution' && !stuck ? 'text-exec-on-paper' : 'text-ink-3',
          )}
        >
          {note}
        </span>
      )}
      <span className="sr-only">
        {' '}
        {item.blurb}
        {item.toolNames.length > 1 && ` Filed by ${joinNames(item.toolNames)}.`}
        {/* Deliberately not core's `Change.blocked.reason`, which names the dot
            path it caught. The fact is what matters here; the path is available
            under the technical names toggle. */}
        {item.withheld && ' Part of this looks like a password and stays on this machine.'}
        {blockedEverywhere && refusals[0] && ` ${refusals[0].message}`}
        {!item.syncable && ' This one never travels.'}
        {!differs && item.syncable && ' Already matches everywhere you picked.'}
      </span>
    </button>
  )
}
