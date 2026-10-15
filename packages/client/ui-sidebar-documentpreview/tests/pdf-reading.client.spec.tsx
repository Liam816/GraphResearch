// @vitest-environment jsdom
/** Reading restoration waits for page geometry and retains final movement on immediate unmount. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pdfReadingPosition, usePdfReadingPosition } from '../src/client/pdf/reading.ts'
import { createEmbeddedPdfStore } from '../src/client/pdf/embedded.tsx'
import type { PdfReadingPosition, PdfView } from '../src/client/pdf/store.ts'
import { fitWidthZoom } from '../src/client/zoom/ZoomViewport.tsx'

const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
beforeEach(() => {
  localStorage.clear(); frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('retains legacy page and zoom preferences under a stable paper identity after a directory change', () => {
  const store = createEmbeddedPdfStore().create('paper-session')
  store.actions.page('/old/paper.pdf', 4)
  store.actions.zoom('/old/paper.pdf', { kind: 'fixed', scale: 1.5 })
  store.actions.adopt('paper-id', '/old/paper.pdf')
  store.actions.position('paper-id', { page: 4, y: 0.35, x: 0.2 })
  store.actions.zoom('paper-id', { kind: 'fixed', scale: 2 })
  store.actions.adopt('paper-id', '/new/paper.pdf')
  expect(createEmbeddedPdfStore().create('paper-session').getSnapshot().byPath['paper-id'])
    .toEqual({ page: 4, zoom: { kind: 'fixed', scale: 2 }, position: { page: 4, y: 0.35, x: 0.2 } })
  expect(createEmbeddedPdfStore().create('another-session').getSnapshot().byPath).toEqual({})
})

it('bounds old page preferences and rejects invalid browser-stored anchors', () => {
  expect(pdfReadingPosition({ page: 8 }, 3)).toEqual({ page: 3, y: 0, x: 0 })
  expect(pdfReadingPosition({ page: 1, position: { page: 0, y: NaN, x: 9 } }, 3)).toBeUndefined()
})

function fixture(saved: PdfView, readyZoom = 1) {
  const save = vi.fn<(position: PdfReadingPosition) => void>()
  let resize: (() => void) | undefined
  class Observer implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resize = () => { callback([], this) } }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void { resize = undefined }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  const data = new Uint8Array([1])
  function Reader({ zoom }: { zoom: number }) {
    const ref = usePdfReadingPosition({ data, pages: 2, width: 600, view: saved, scrollportRef: () => {}, reading: { save, fitWidthZoom } })
    return <div ref={ref} data-testid="scroller">
      <div data-pdf-page="1" data-pdf-render-zoom={zoom} />
      <div data-pdf-page="2" data-pdf-render-zoom={zoom} />
    </div>
  }
  const view = render(<Reader zoom={readyZoom} />)
  const node = view.getByTestId('scroller')
  let height = 400
  Object.defineProperties(node, {
    clientHeight: { get: () => height }, clientWidth: { value: 600 }, scrollWidth: { value: 1200 },
  })
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 600, height))
  Array.from(node.children).forEach((page, index) => {
    vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 12 + index * 1012 - node.scrollTop, 600, 1000))
  })
  const commit = (): void => {
    act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) })
  }
  return { view, node, save, commit, resize: () => { act(() => { resize?.() }) }, hide: () => { height = 0 },
    ready: async (zoom: number) => { await act(async () => { view.rerender(<Reader zoom={zoom} />) }) } }
}

it('waits for the saved zoom, then restores a page-relative point and horizontal pan', async () => {
  const h = fixture({ page: 2, zoom: { kind: 'fixed', scale: 1.5 }, position: { page: 2, y: 0.25, x: 0.4 } })
  h.resize()
  expect(h.node.scrollTop).toBe(0)
  expect(h.save).not.toHaveBeenCalled()
  await h.ready(1.5)
  expect(h.node.scrollTop).toBe(1274)
  expect(h.node.scrollLeft).toBe(240)
  h.commit()
  expect(h.save).toHaveBeenLastCalledWith({ page: 2, y: 0.25, x: 0.4 })
})

it('flushes the latest reading point before a frame or scrollend and ignores hidden geometry', () => {
  const h = fixture({ page: 1, zoom: { kind: 'fixed', scale: 1 } })
  h.node.scrollTop = 1124
  h.node.scrollLeft = 180
  fireEvent.scroll(h.node)
  h.view.unmount()
  expect(h.save).toHaveBeenLastCalledWith({ page: 2, y: 0.1, x: 0.3 })
  expect(frames.size).toBe(0)
  const hidden = fixture({ page: 1, zoom: { kind: 'fixed', scale: 1 } })
  hidden.node.scrollTop = 1124
  fireEvent.scroll(hidden.node); hidden.commit()
  hidden.hide(); hidden.node.scrollTop = 0; fireEvent.scroll(hidden.node); hidden.commit()
  expect(hidden.save).toHaveBeenLastCalledWith({ page: 2, y: 0.1, x: 0 })
})
