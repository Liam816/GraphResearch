// @vitest-environment jsdom
/** Saved translation occurrences remain selectable and expose one history anchor across result versions. */
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchPaperId, ResearchTranslationHistoryEntry } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TranslationLayer, translationPageRects } from '../src/client/pdf/TranslationMarkers.tsx'
import { en } from '../src/client/pdf/locales.ts'

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const ranges: string[] = []
const rects = [{ page: 1, x: 0.1, y: 0.25, width: 0.2, height: 0.05 }]

function entry(key: string, start = 4, end = 10): ResearchTranslationHistoryEntry {
  return { translation: { key, paperId: 'paper' as ResearchPaperId, sourceSha256: 'source',
    context: { selected: 'policy', sentence: 'The policy predicts actions.', selectionStart: start,
      before: [], after: [], startPage: 1, endPage: 1, limited: true },
    result: { kind: 'word', lemma: 'policy', partOfSpeech: '名词', meanings: ['策略'], contextualMeaning: '动作策略',
      explanation: '根据观测生成动作的方法', translation: '该策略预测动作。' },
    pronunciation: { status: 'unavailable', phonetics: [], sourceUrl: '' } },
  selection: { start: { page: 1, item: 0, offset: start }, end: { page: 1, item: 0, offset: end }, rects },
  createdAt: '2026-10-26T00:00:00.000Z' }
}

function Page({ entries, page = 1, ready = true }: {
  readonly entries: readonly ResearchTranslationHistoryEntry[]
  readonly page?: number
  readonly ready?: boolean
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  return <div ref={surfaceRef} data-document-zoom-surface data-pdf-page={page}>
    <div data-pdf-text><span data-pdf-text-item="0">The policy predicts actions.</span></div>
    <TranslationLayer entries={entries} page={page} ready={ready} surfaceRef={surfaceRef} t={makeTranslate(en)} />
  </div>
}

beforeEach(() => {
  ranges.length = 0
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 200, 200))
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value(this: Range) {
    ranges.push(this.toString())
    return [new DOMRect(30, 60, 40, 10)]
  } })
})
afterEach(() => {
  cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks()
  if (originalRects === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects')
  else Object.defineProperty(Range.prototype, 'getClientRects', originalRects)
})

it('combines result versions at one occurrence while keeping a second occurrence separate', () => {
  const view = render(<Page entries={[entry('old'), entry('new'), entry('another', 11, 19)]} />)
  const buttons = screen.getAllByRole('button', { name: 'View translation history: policy' })
  expect(buttons.map(button => button.dataset['pdfTranslationHistory'])).toEqual(['new', 'another'])
  const markers = view.container.querySelectorAll<HTMLElement>('[data-pdf-translation]')
  expect([...markers].map(marker => marker.dataset['pdfTranslation'])).toEqual(['new', 'another'])
  expect(markers[0]!.style.left).toBe('10%')
  expect(markers[0]!.getAttribute('aria-hidden')).toBe('true')
})

it('recovers older selections from original text-item offsets without replacing the native selection', () => {
  const original = entry('old')
  const selection = original.selection!
  const legacy = { ...original, selection: { start: selection.start, end: selection.end } }
  const view = render(<Page entries={[legacy]} />)
  expect(screen.getByRole('button', { name: 'View translation history: policy' })).toBeDefined()
  expect(ranges.length).toBeGreaterThan(0)
  expect(ranges.every(value => value === 'policy')).toBe(true)
  const text = view.container.querySelector('[data-pdf-text-item]')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3)
  window.getSelection()!.addRange(range)
  expect(translationPageRects(view.container.firstElementChild as HTMLElement, 1, legacy.selection)).toEqual(rects)
  expect(window.getSelection()?.toString()).toBe('The')
})

it('draws a cross-page passage on both pages with a history button only at the passage start', () => {
  const original = entry('two-pages')
  const across = { ...original, selection: { ...original.selection!, end: { page: 2, item: 0, offset: 6 },
    rects: [...rects, { ...rects[0]!, page: 2 }] } }
  const view = render(<><Page entries={[across]} /><Page entries={[across]} page={2} /></>)
  expect(view.container.querySelectorAll('[data-pdf-translation]')).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'View translation history: policy' })).toHaveLength(1)
})

it('omits unlocated history and waits for the page text layer before showing its markers', () => {
  const unlocated = { translation: entry('unlocated').translation }
  const view = render(<Page entries={[entry('ready'), unlocated]} ready={false} />)
  expect(screen.queryByRole('button')).toBeNull()
  view.rerender(<Page entries={[entry('ready'), unlocated]} ready />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(translationPageRects(view.container.firstElementChild as HTMLElement, 2, entry('other-page').selection!)).toEqual([])
})
