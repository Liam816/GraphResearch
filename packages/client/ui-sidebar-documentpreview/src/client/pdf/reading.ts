/** Page-relative reading restoration waits for the saved page's settled zoom and visible viewport. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefCallback } from 'react'
import type { PdfReadingPosition, PdfView } from './store.ts'
import type { ZoomViewportProps } from '../zoom/ZoomViewport.tsx'

/** Main-bundle zoom calculation and paper-owned reading persistence used by the lazy renderer. */
export interface PdfReadingCallbacks {
  readonly save: (position: PdfReadingPosition) => void
  readonly fitWidthZoom: typeof import('../zoom/ZoomViewport.tsx').fitWidthZoom
}

/**
 * Decode the optional page anchor in browser preferences; legacy page-only records retain their page.
 * @param view - restored browser viewing preferences.
 * @param pages - current original page count.
 * @returns a valid relative anchor, or no previous reading position.
 */
export function pdfReadingPosition(view: PdfView, pages: number): PdfReadingPosition | undefined {
  const saved = view.position
  if (saved !== undefined && Number.isSafeInteger(saved.page) && saved.page >= 1 && saved.page <= pages
    && Number.isFinite(saved.y) && saved.y >= -1 && saved.y <= 1
    && Number.isFinite(saved.x) && saved.x >= 0 && saved.x <= 1) return saved
  if (Number.isSafeInteger(view.page) && view.page > 1) return { page: Math.min(view.page, pages), y: 0, x: 0 }
  return undefined
}

/**
 * Retain a precise position across remounts without saving loading placeholders or hidden-panel offsets.
 * @param input - document identity, viewing preferences, settled first-page width and persistence callback.
 * @returns the composed scrollport ref used by the shared zoom viewport.
 */
export function usePdfReadingPosition(input: {
  readonly data: Uint8Array | undefined
  readonly pages: number | undefined
  readonly width: number | undefined
  readonly view: PdfView
  readonly scrollportRef: ZoomViewportProps['scrollportRef']
  readonly reading: PdfReadingCallbacks | undefined
}): RefCallback<HTMLElement> {
  const [scrollport, setScrollport] = useState<HTMLElement | null>(null)
  const current = useRef(input)
  current.current = input
  const attach = useCallback((node: HTMLElement | null): void => {
    input.scrollportRef(node); setScrollport(node)
  }, [input.scrollportRef])
  useLayoutEffect(() => {
    const reading = current.current.reading, count = current.current.pages
    if (scrollport === null || reading === undefined || count === undefined) return
    const save = reading.save
    const pages = Array.from(scrollport.querySelectorAll<HTMLElement>('[data-pdf-page]'))
    const saved = pdfReadingPosition(current.current.view, count)
    let restoring = saved !== undefined
    let last: PdfReadingPosition | undefined
    let frame: number | undefined
    const visible = (): boolean => scrollport.clientHeight > 0 && scrollport.closest('[hidden]') === null
    const capture = (): void => {
      if (restoring || !visible() || pages.length === 0) return
      const top = scrollport.getBoundingClientRect().top
      let low = 0, high = pages.length - 1
      while (low < high) {
        const middle = (low + high) >>> 1
        const candidate = pages[middle]
        if (candidate === undefined) return
        if (candidate.getBoundingClientRect().bottom > top + 1) high = middle
        else low = middle + 1
      }
      const page = pages[low]
      if (page === undefined) return
      const bounds = page.getBoundingClientRect()
      if (bounds.height === 0 || page.dataset.pdfRenderZoom === undefined) return
      last = { page: low + 1, y: Math.max(-1, Math.min(1, (top - bounds.top) / bounds.height)),
        x: scrollport.scrollLeft / Math.max(1, scrollport.scrollWidth - scrollport.clientWidth) }
    }
    const flush = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (last !== undefined) save(last)
    }
    const sample = (): void => {
      capture()
      if (last !== undefined && frame === undefined) frame = requestAnimationFrame(flush)
    }
    const restore = (): void => {
      if (!restoring || saved === undefined || !visible()) return
      const page = pages[saved.page - 1], width = current.current.width
      if (page === undefined || width === undefined) return
      const preference = current.current.view.zoom
      const zoom = preference?.kind === 'fixed' ? preference.scale : reading.fitWidthZoom(scrollport.clientWidth, width, 24)
      if (Number(page.dataset.pdfRenderZoom) !== zoom) return
      const bounds = page.getBoundingClientRect()
      scrollport.scrollTop += bounds.top - scrollport.getBoundingClientRect().top + saved.y * bounds.height
      scrollport.scrollLeft = saved.x * Math.max(0, scrollport.scrollWidth - scrollport.clientWidth)
      restoring = false
      sample()
    }
    const interact = (): void => { restoring = false }
    const resize = (): void => { restore(); sample() }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
    observer?.observe(scrollport)
    for (const page of pages) observer?.observe(page)
    const mutations = new MutationObserver(resize)
    mutations.observe(scrollport, { subtree: true, attributes: true, attributeFilter: ['data-pdf-render-zoom', 'hidden', 'style'] })
    scrollport.addEventListener('scroll', sample, { passive: true })
    for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) scrollport.addEventListener(event, interact, { passive: true })
    window.addEventListener('pagehide', flush)
    restore()
    return () => {
      capture()
      if (frame !== undefined) cancelAnimationFrame(frame)
      flush()
      observer?.disconnect(); mutations.disconnect()
      scrollport.removeEventListener('scroll', sample)
      for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) scrollport.removeEventListener(event, interact)
      window.removeEventListener('pagehide', flush)
    }
  }, [scrollport, input.data, input.pages])
  return attach
}
