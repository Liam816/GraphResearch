// @vitest-environment jsdom
/** Multi-page marker geometry and retained selection after failed annotation writes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchHighlight, ResearchHighlightId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { collectPdfSelection, highlightAtPoint, type PdfAnnotations } from '../src/client/pdf/highlights.ts'
import { AnnotatedPages, HighlightLayer } from '../src/client/pdf/HighlightControls.tsx'
import { en } from '../src/client/pdf/locales.ts'

const previousRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const bounds = (left: number, top: number, width: number, height: number): DOMRect => new DOMRect(left, top, width, height)

beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value(this: Range) {
    const page = this.startContainer.parentElement?.closest<HTMLElement>('[data-pdf-page]')
    return [page?.dataset['pdfPage'] === '2' ? bounds(30, 450, 60, 20) : bounds(30, 60, 80, 20)]
  } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const page = this.closest<HTMLElement>('[data-pdf-page]')
    return page?.dataset['pdfPage'] === '2' ? bounds(10, 410, 400, 400) : bounds(10, 10, 200, 200)
  })
})
afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  if (previousRects === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects')
  else Object.defineProperty(Range.prototype, 'getClientRects', previousRects)
})

function fixture(highlights: readonly ResearchHighlight[] = [], available = true) {
  const change = vi.fn<PdfAnnotations['change']>(async () => {})
  const annotations = { highlights, change, available }
  const t = makeTranslate(en)
  const view = render(<AnnotatedPages annotations={annotations} t={t}>
    {[1, 2].map(page => <div key={page} data-pdf-page={page}><div data-document-zoom-surface>
      <div data-pdf-text><span>{page === 1 ? 'First selected line' : 'Second selected line'}</span></div>
      <HighlightLayer annotations={annotations} page={page} t={t} />
    </div></div>)}
  </AnnotatedPages>)
  const lines = view.container.querySelectorAll('[data-pdf-text] span')
  const first = lines[0]!.firstChild!, second = lines[1]!.firstChild!
  const select = (): void => {
    const range = document.createRange()
    range.setStart(first, 0); range.setEnd(second, second.textContent!.length)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    fireEvent.pointerUp(lines[1]!)
  }
  return { ...view, change, select, first }
}

it('captures per-page normalized coordinates and rejects selections outside the current reader', () => {
  const view = fixture()
  view.select()
  const selected = collectPdfSelection(view.container, window.getSelection())!
  expect(selected.text).toBe('First selected line Second selected line')
  expect(selected.rects).toEqual([
    { page: 1, x: 0.1, y: 0.25, width: 0.4, height: 0.1 },
    { page: 2, x: 0.05, y: 0.1, width: 0.15, height: 0.05 },
  ])
  expect(collectPdfSelection(document.createElement('div'), window.getSelection())).toBeUndefined()
  window.getSelection()!.removeAllRanges()
  expect(collectPdfSelection(view.container, window.getSelection())).toBeUndefined()
})

it('explains that an older backend needs restarting and sends no unsupported highlight requests', () => {
  const view = fixture([], false)
  view.select()
  expect(screen.getByRole('alert').textContent).toBe(en.highlightRestartRequired)
  const color = screen.getByRole<HTMLButtonElement>('button', { name: en.yellow })
  expect(color.disabled).toBe(true)
  fireEvent.click(color)
  expect(view.change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.highlightDismiss }))
  expect(screen.queryByRole('toolbar')).toBeNull()
})

it('shows all marker colors, dismisses on Escape, and submits the selected text and page rectangles', async () => {
  const view = fixture()
  view.select()
  expect(screen.getByRole('toolbar', { name: en.highlightColors })).toBeDefined()
  for (const name of [en.yellow, en.green, en.blue, en.pink, en.orange]) expect(screen.getByRole('button', { name })).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('toolbar')).toBeNull()
  view.select()
  fireEvent.click(screen.getByRole('button', { name: en.blue }))
  await waitFor(() => { expect(screen.queryByRole('toolbar')).toBeNull() })
  const submitted = view.change.mock.calls[0]![0]
  expect(submitted.type).toBe('add')
  if (submitted.type !== 'add') throw new Error('the toolbar must add a highlight')
  expect(submitted.highlight.id).toEqual(expect.any(String))
  expect(submitted.highlight.color).toBe('blue')
  expect(submitted.highlight.text).toBe('First selected line Second selected line')
  expect(submitted.highlight.rects.map(rect => rect.page)).toEqual([1, 2])
})

it('retains failed additions and retries the same identity instead of creating another marker', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = fixture()
  view.change.mockRejectedValueOnce(new Error('connection lost'))
  view.select()
  fireEvent.click(screen.getByRole('button', { name: en.yellow }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en.highlightFailed) })
  expect(window.getSelection()?.toString()).toContain('First selected line')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.green }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(view.change.mock.calls[1]).toEqual(view.change.mock.calls[0])
})

it('keeps confirmed markers on deletion failure and supports double-click and keyboard removal', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const highlight: ResearchHighlight = { id: 'selection' as ResearchHighlightId, color: 'pink', text: 'First selected line',
    rects: [{ page: 1, x: 0.1, y: 0.25, width: 0.4, height: 0.1 }] }
  const view = fixture([highlight])
  expect(highlightAtPoint(view.container, [highlight], 40, 70)).toEqual(highlight)
  view.change.mockRejectedValueOnce(new Error('storage unavailable'))
  fireEvent.doubleClick(view.first.parentElement!, { clientX: 40, clientY: 70 })
  await waitFor(() => { expect(screen.getByRole('alert')).toBeDefined() })
  const marker = screen.getByRole('button', { name: 'Remove highlight: First selected line' })
  expect(marker).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  fireEvent.click(marker)
  await waitFor(() => { expect(view.change).toHaveBeenCalledTimes(3) })
  expect(view.change.mock.calls.every(([change]) => change.type === 'remove' && change.id === highlight.id)).toBe(true)
})
