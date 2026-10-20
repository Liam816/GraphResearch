// @vitest-environment jsdom
/** Text overlay resources follow page ownership; resize only aligns selection with the existing canvas. */
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ render: vi.fn(), cancel: vi.fn(), create: vi.fn() }))
vi.mock('pdfjs-dist', () => ({}))
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    div = document.createElement('div')
    constructor(options: unknown) { api.create(options) }
    render = api.render
    cancel = api.cancel
  },
}))
import { pdfTextRenderer } from '../src/client/pdf/text.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('aligns selectable text to the displayed width and removes its observer and DOM on cancellation', async () => {
  let resize: ResizeObserverCallback | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe = observe
    disconnect = disconnect
  })
  api.render.mockResolvedValue(undefined)
  const host = document.createElement('div')
  let width = 200
  vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect)
  const viewport = { width: 400, scale: 4 / 3, userUnit: 1 } as PageViewport
  const text = new ReadableStream()
  const page = { streamTextContent: () => text } as PDFPageProxy
  const task = pdfTextRenderer(host)(page, viewport)
  await task.promise
  expect(api.create.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ pdfPage: page }))
  const options = api.create.mock.calls[0]![0] as { onAppend(root: HTMLElement): void }
  const layer = host.firstElementChild as HTMLElement
  layer.innerHTML = '<span class="markedContent"><span role="presentation">First</span><br role="presentation"><span role="presentation">Second</span></span>'
  options.onAppend(layer)
  expect(Array.from(layer.querySelectorAll('span[role="presentation"]'), span => (span as HTMLElement).dataset['pdfTextItem'])).toEqual(['0', '1'])
  expect(api.render).toHaveBeenCalledWith({ viewport })
  expect(observe).toHaveBeenCalledWith(host)
  expect((host.firstElementChild as HTMLElement).style.scale).toBe('0.5')
  width = 100
  resize!([], {} as ResizeObserver)
  expect((host.firstElementChild as HTMLElement).style.scale).toBe('0.25')
  task.cancel()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(api.cancel).toHaveBeenCalledOnce()
  expect(host.childElementCount).toBe(0)
})
