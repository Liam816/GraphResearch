// @vitest-environment jsdom
/** Saved translation queries survive selection races and reopen without model inference. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ResearchPaperId, ResearchTranslationHistoryEntry } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PdfTranslation } from '../src/client/pdf/highlights.ts'
import { useTranslationHistory } from '../src/client/pdf/translation-history.ts'
import { AnnotatedPages } from '../src/client/pdf/HighlightControls.tsx'
import { en } from '../src/client/pdf/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const entry: ResearchTranslationHistoryEntry = {
  translation: { key: 'first', paperId: 'paper' as ResearchPaperId, sourceSha256: 'original',
    context: { selected: 'policy', sentence: 'The policy acts.', selectionStart: 4, before: [], after: [],
      startPage: 1, endPage: 1, limited: true },
    result: { kind: 'word', lemma: 'policy', partOfSpeech: '名词', meanings: ['策略'], contextualMeaning: '动作策略',
      explanation: '根据原文解释', translation: '该策略执行动作。' },
    pronunciation: { status: 'unavailable', phonetics: [], sourceUrl: '' } },
  selection: { start: { page: 1, item: 0, offset: 4 }, end: { page: 1, item: 0, offset: 10 },
    rects: [{ page: 1, x: 0.1, y: 0.2, width: 0.2, height: 0.02 }] },
  createdAt: '2026-10-26T00:00:00.000Z',
}

function commands(list: NonNullable<PdfTranslation['history']>['list']): PdfTranslation {
  return { history: { key: 'paper:original', list }, translate: vi.fn(async () => entry.translation),
    save: vi.fn(async () => {}), ask: vi.fn(async () => {}) }
}

it('keeps a just-translated occurrence when an older history query resolves late', async () => {
  let resolveOld!: (entries: readonly ResearchTranslationHistoryEntry[]) => void
  const list = vi.fn<NonNullable<PdfTranslation['history']>['list']>()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    .mockResolvedValue([entry])
  const callbacks = commands(list)
  const view = renderHook(() => useTranslationHistory(callbacks))
  await waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
  await act(async () => { await view.result.current.translation!.translate({ text: 'policy', ...entry.selection! }, new AbortController().signal) })
  await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  await act(async () => { resolveOld([]) })
  expect(view.result.current.entries).toEqual([entry])
  expect(list.mock.calls[0]?.[0].aborted).toBe(true)
})

it('retains confirmed history on refresh failure and retries without translating', async () => {
  const list = vi.fn<NonNullable<PdfTranslation['history']>['list']>().mockResolvedValueOnce([entry])
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValue([entry])
  const callbacks = commands(list)
  const view = renderHook(() => useTranslationHistory(callbacks))
  await waitFor(() => { expect(view.result.current.entries).toEqual([entry]) })
  await act(async () => { await view.result.current.translation!.translate({ text: 'policy', ...entry.selection! }, new AbortController().signal) })
  await waitFor(() => { expect(view.result.current.failed).toBe(true) })
  expect(view.result.current.entries).toEqual([entry])
  act(() => { view.result.current.retry() })
  await waitFor(() => { expect(view.result.current.failed).toBe(false) })
  expect(callbacks.translate).toHaveBeenCalledTimes(1)
})

it('cancels the old paper query and hides its results immediately when the PDF changes', async () => {
  let resolveOld!: (entries: readonly ResearchTranslationHistoryEntry[]) => void
  const list = vi.fn<NonNullable<PdfTranslation['history']>['list']>()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve })).mockResolvedValue([])
  const callbacks = commands(list)
  const view = renderHook(({ key }) => useTranslationHistory({ ...callbacks, history: { key, list } }),
    { initialProps: { key: 'paper:original' } })
  view.rerender({ key: 'another-paper:original' })
  expect(list.mock.calls[0]?.[0].aborted).toBe(true)
  await act(async () => { resolveOld([entry]) })
  expect(view.result.current.entries).toEqual([])
})

it('opens and switches saved explanations for one occurrence without translating or mixing repeated words', async () => {
  const second = { ...entry, selection: { ...entry.selection!,
    start: { offset: 4, item: 0, page: 1 }, end: { offset: 10, page: 1, item: 0 } }, translation: { ...entry.translation, key: 'second',
    result: { ...entry.translation.result, contextualMeaning: '另一份语境解释' } } }
  const elsewhere = { ...entry, translation: { ...entry.translation, key: 'elsewhere' },
    selection: { start: { page: 2, item: 0, offset: 4 }, end: { page: 2, item: 0, offset: 10 } } }
  const callbacks = commands(vi.fn(async () => [entry, second, elsewhere]))
  render(<AnnotatedPages annotations={undefined} translation={callbacks} t={makeTranslate(en)}>
    {entries => entries.length === 0 ? null : <button type="button" data-pdf-translation-history="second">History trigger</button>}
  </AnnotatedPages>)
  fireEvent.click(await screen.findByRole('button', { name: 'History trigger' }))
  await screen.findByRole('region', { name: en.translationHistory })
  expect(screen.getByText('另一份语境解释')).toBeDefined()
  expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Record 1' }))
  await screen.findByText('动作策略')
  expect(screen.queryByRole('button', { name: 'Record 3' })).toBeNull()
  expect(callbacks.translate).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('region', { name: en.translationHistory })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'History trigger' }))
  await screen.findByRole('region', { name: en.translationHistory })
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('region', { name: en.translationHistory })).toBeNull()
})
