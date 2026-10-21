/** Shared one-line overflow reveal for navigation titles. */
import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'

/* Overflow this small hides no meaningful tail; scrolling for it reads as an
   accidental jitter, so the title stays put. */
const MIN_TITLE_REVEAL_PX = 8

/* Marquee travel speed: slow enough to read the text as it passes. */
const TITLE_MARQUEE_PX_PER_MS = 0.03

/**
 * Place the title's scroll position and publish the stylesheet's fade-mask
 * hooks: `data-scrolled` while the title has left its start (left fade) and
 * `data-clipped` while text remains beyond the right edge (right fade).
 * @param title - the row's clipping title element.
 * @param left - scroll offset in CSS pixels.
 * @param range - the title's maximum scroll offset in CSS pixels.
 */
function placeTitle(title: HTMLSpanElement, left: number, range: number): void {
  // jsdom implements no scrollTo; the lane's direct assignment is instant there
  // anyway, so both paths land on the same position.
  if (typeof title.scrollTo === 'function') title.scrollTo({ left, behavior: 'instant' })
  else title.scrollLeft = left
  if (left > 0) title.dataset.scrolled = ''
  else delete title.dataset.scrolled
  if (left < range) title.dataset.clipped = ''
  else delete title.dataset.clipped
}

/**
 * Return the title to its resting state: scrolled to the start with both fade
 * masks off, so the resting ellipsis renders at full strength.
 * @param title - the row's clipping title element.
 */
function restTitle(title: HTMLSpanElement): void {
  if (typeof title.scrollTo === 'function') title.scrollTo({ left: 0, behavior: 'instant' })
  else title.scrollLeft = 0
  delete title.dataset.scrolled
  delete title.dataset.clipped
}

/**
 * Reveal a clipped title while hovered or focused, resetting immediately on leave.
 * Reduced motion reveals the far edge without animation. Ordinary rows ignore up to eight pixels of overflow.
 * @param title - clipping title element.
 * @param delayMs - dwell time before revealing overflow.
 * @param repeat - reverse at each edge with a one-second pause, including small overflow.
 * @returns stable pointer and focus enter/leave handlers.
 */
export function useTitleMarquee(
  title: RefObject<HTMLSpanElement | null>, delayMs = 0, repeat = false,
): { enter: () => void; leave: () => void } {
  const frame = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(timer.current) }, [])
  return useMemo(() => ({
    enter: (): void => {
      /* v8 ignore next -- defensive: the title span renders unconditionally. */
      if (title.current === null) return
      cancelAnimationFrame(frame.current)
      clearTimeout(timer.current)
      const element = title.current
      const start = (): void => {
        const range = element.scrollWidth - element.clientWidth
        if (range <= (repeat ? 0 : MIN_TITLE_REVEAL_PX)) return
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          placeTitle(element, range, range)
          return
        }
        cancelAnimationFrame(frame.current)
        let previous: number | undefined
        let position = 0
        let direction = 1
        let holdUntil = 0
        const step = (now: DOMHighResTimeStamp): void => {
          const elapsed = previous === undefined || now < holdUntil ? 0 : (repeat ? Math.min(now - previous, 100) : now - previous)
          position += elapsed * TITLE_MARQUEE_PX_PER_MS * direction
          previous = now
          if (repeat && (direction > 0 ? position >= range : position <= 0)) {
            position = Math.max(0, Math.min(position, range)); direction *= -1; holdUntil = now + 1000
          }
          placeTitle(element, Math.max(0, Math.min(position, range)), range)
          if (repeat || position < range) frame.current = requestAnimationFrame(step)
        }
        frame.current = requestAnimationFrame(step)
      }
      if (delayMs === 0) start()
      else timer.current = setTimeout(start, delayMs)
    },
    leave: (): void => {
      clearTimeout(timer.current)
      cancelAnimationFrame(frame.current)
      /* v8 ignore next -- defensive: the title span renders unconditionally. */
      if (title.current === null) return
      restTitle(title.current)
    },
  }), [title, delayMs, repeat])
}
