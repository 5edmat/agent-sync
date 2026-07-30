import { useCallback, useEffect, useRef, useState } from 'react'

// There is no theme hook. The bench is one world — a dark surface with one warm
// paper object on it — and a light variant would be a different room, not a
// setting. See `index.css`.

// ---------------------------------------------------------------------------
// Async data
// ---------------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: Error | undefined
  reload: () => void
  /** Replace the data without a round trip, after a mutation returns it. */
  set: (v: T) => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error>()
  const [nonce, setNonce] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    fnRef
      .current()
      .then((v) => {
        if (!cancelled) setData(v)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((x) => x + 1), [])
  return { data, loading, error, reload, set: setData }
}

/**
 * A one-shot action with its own pending + error state.
 *
 * Every mutation in this app can be refused for a reason the person needs to
 * read, so the error is never swallowed — it is returned for a screen to show.
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Error>()
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true)
    setError(undefined)
    try {
      return await fnRef.current(...args)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      return undefined
    } finally {
      setPending(false)
    }
  }, [])

  const clearError = useCallback(() => setError(undefined), [])
  return { run, pending, error, clearError }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function useEscape(handler: () => void, active = true) {
  const cb = useRef(handler)
  cb.current = handler
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active])
}

/**
 * Keeps focus inside an overlay while it is open, and gives it back afterwards.
 *
 * A machine picked up off the bench covers the bench. Letting Tab walk out
 * behind it is how a keyboard user loses the thing they opened.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null

    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)

    focusables()[0]?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0] as HTMLElement
      const last = list[list.length - 1] as HTMLElement
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [active])

  return ref
}

/**
 * Announces a change to a screen reader without moving focus.
 *
 * Picking a chip up and putting it down are physical events that produce no
 * visible text change in the place the person is looking, so they are spoken.
 */
export function useAnnounce(): [string, (msg: string) => void] {
  const [message, setMessage] = useState('')
  const say = useCallback((msg: string) => {
    // Re-announce an identical message by clearing first.
    setMessage('')
    window.setTimeout(() => setMessage(msg), 30)
  }, [])
  return [message, say]
}
