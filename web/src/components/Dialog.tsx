/**
 * The only overlay in the product.
 *
 * Two things open one: pressing Send, and pressing `···`. Both are consequences
 * of an action rather than places you can navigate to, which is why neither of
 * them is a route and neither leaves anything behind on the bench.
 *
 * Focus goes in, Tab stays in, Escape comes back out to whatever opened it. A
 * dialog that lets Tab walk out behind it is how a keyboard user loses the thing
 * they just opened.
 */

import type { ReactNode } from 'react'
import { useEscape, useFocusTrap } from '../lib/hooks'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function Dialog({ title, onClose, children, footer }: Props) {
  const ref = useFocusTrap<HTMLDivElement>(true)
  useEscape(onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 sm:p-8">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="anim-in my-auto w-full max-w-[560px] rounded-[10px] border border-edge bg-felt-deep shadow-sheet"
      >
        <div className="flex items-center gap-3 border-b border-edge px-5 py-3.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button
            type="button"
            className="ml-auto rounded-md border border-edge px-2.5 py-1 text-[13px] text-dim hover:text-onfelt"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center gap-3 border-t border-edge px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
