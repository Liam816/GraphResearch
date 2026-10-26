// @vitest-environment jsdom
/** Reader-owned translation work survives card visibility while retaining source and explicit cancellation ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ResearchPaperId, ResearchTranslation } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PdfSelection, PdfTranslation } from '../src/client/pdf/highlights.ts'
import { useTranslationRequests } from '../src/client/pdf/translation-requests.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const selection: PdfSelection = { text: 'policy', anchor: { x: 40, y: 60 },
  start: { page: 1, item: 2, offset: 4 }, end: { page: 1, item: 2, offset: 10 },
  rects: [{ page: 1, x: 0.1, y: 0.2, width: 0.1, height: 0.02 }] }

function result(key: string): ResearchTranslation {
  return { key, paperId: 'paper' as ResearchPaperId, sourceSha256: 'original',
    context: { selected: 'policy', sentence: 'The policy acts.', selectionStart: 4, before: [], after: [],
      startPage: 1, endPage: 1, limited: true },
    result: { kind: 'word', lemma: 'policy', partOfSpeech: '名词', meanings: ['策略'], contextualMeaning: '动作策略',
      explanation: '根据原文解释', translation: '该策略执行动作。' },
    pronunciation: { status: 'unavailable', phonetics: [], sourceUrl: '' } }
}

function deferred() {
  let resolve!: (value: ResearchTranslation) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<ResearchTranslation>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

function commands(translate: PdfTranslation['translate'], key = 'paper:original'): PdfTranslation {
  return { translate, history: { key, list: async () => [] }, save: async () => {}, ask: async () => {} }
}

it('shares pending translation work when the same source occurrence is selected at another viewport position', async () => {
  const work = deferred(), translate = vi.fn<PdfTranslation['translate']>(() => work.promise)
  const view = renderHook(() => useTranslationRequests(commands(translate)))
  act(() => { view.result.current.start(selection) })
  act(() => { view.result.current.start({ ...selection, anchor: { x: 200, y: 300 },
    start: { offset: 4, item: 2, page: 1 }, end: { offset: 10, page: 1, item: 2 },
    rects: [{ page: 1, x: 0.2, y: 0.4, width: 0.2, height: 0.04 }] }) })
  expect(translate).toHaveBeenCalledTimes(1)
  expect(view.result.current.requests).toHaveLength(1)
  expect(view.result.current.requests[0]?.kind).toBe('loading')
  await act(async () => { work.resolve(result('saved')) })
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'ready', value: result('saved') })
})

it('retains independent translations when different occurrences finish out of order', async () => {
  const first = deferred(), second = deferred()
  const translate = vi.fn<PdfTranslation['translate']>().mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  const view = renderHook(() => useTranslationRequests(commands(translate)))
  const elsewhere: PdfSelection = { ...selection, anchor: { x: 40, y: 200 },
    start: { page: 2, item: 2, offset: 4 }, end: { page: 2, item: 2, offset: 10 } }
  act(() => { view.result.current.start(selection); view.result.current.start(elsewhere) })
  expect(view.result.current.requests).toHaveLength(2)
  await act(async () => { second.resolve(result('second')) })
  expect(view.result.current.requests.map(request => request.kind)).toEqual(['loading', 'ready'])
  expect(translate.mock.calls[0]?.[1].aborted).toBe(false)
  await act(async () => { first.resolve(result('first')) })
  expect(view.result.current.requests).toMatchObject([
    { kind: 'ready', selection, value: result('first') },
    { kind: 'ready', selection: elsewhere, value: result('second') },
  ])
})

it('keeps pending work across callback replacement and uses the current model callback for a later explicit translation', async () => {
  const first = deferred(), second = deferred()
  const original = vi.fn<PdfTranslation['translate']>(() => first.promise)
  const replacement = vi.fn<PdfTranslation['translate']>(() => second.promise)
  const view = renderHook(({ translate }) => useTranslationRequests(commands(translate)), { initialProps: { translate: original } })
  act(() => { view.result.current.start(selection) })
  view.rerender({ translate: replacement })
  expect(original.mock.calls[0]?.[1].aborted).toBe(false)
  expect(replacement).not.toHaveBeenCalled()
  await act(async () => { first.resolve(result('original-route')) })
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'ready', value: result('original-route') })
  act(() => { view.result.current.start(selection) })
  expect(replacement).toHaveBeenCalledTimes(1)
  expect(view.result.current.requests).toHaveLength(1)
  expect(view.result.current.requests[0]?.kind).toBe('loading')
  await act(async () => { second.resolve(result('replacement-route')) })
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'ready', value: result('replacement-route') })
})

it('cancels work from the old PDF and ignores its late completion after a source change', async () => {
  const old = deferred(), current = deferred()
  const translate = vi.fn<PdfTranslation['translate']>().mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise)
  const view = renderHook(({ key }) => useTranslationRequests(commands(translate, key)), { initialProps: { key: 'paper:original' } })
  act(() => { view.result.current.start(selection) })
  view.rerender({ key: 'paper:revised' })
  expect(translate.mock.calls[0]?.[1].aborted).toBe(true)
  expect(view.result.current.requests).toEqual([])
  act(() => { view.result.current.start(selection) })
  await act(async () => { current.resolve(result('revised')) })
  await act(async () => { old.resolve(result('original')) })
  expect(view.result.current.requests).toHaveLength(1)
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'ready', value: result('revised') })
})

it('cancels pending requests when translation becomes unavailable', async () => {
  const work = deferred(), translate = vi.fn<PdfTranslation['translate']>(() => work.promise)
  const view = renderHook(({ available }) => useTranslationRequests(available ? commands(translate) : undefined),
    { initialProps: { available: true } })
  act(() => { view.result.current.start(selection) })
  view.rerender({ available: false })
  expect(translate.mock.calls[0]?.[1].aborted).toBe(true)
  await act(async () => { work.resolve(result('retired')) })
  expect(view.result.current.requests).toEqual([])
})

it('cancels every owned request when its reader unmounts', async () => {
  const first = deferred(), second = deferred()
  const translate = vi.fn<PdfTranslation['translate']>().mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  const view = renderHook(() => useTranslationRequests(commands(translate)))
  act(() => { view.result.current.start(selection); view.result.current.start({ ...selection, text: 'another word' }) })
  view.unmount()
  expect(translate.mock.calls.every(([_selection, signal]) => signal.aborted)).toBe(true)
  await act(async () => { first.resolve(result('late')); second.reject(new Error('cancelled')) })
})

it('allows an explicitly cancelled occurrence to retry without a late original result overwriting the retry', async () => {
  const old = deferred(), retry = deferred()
  const translate = vi.fn<PdfTranslation['translate']>().mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => retry.promise)
  const view = renderHook(() => useTranslationRequests(commands(translate)))
  act(() => { view.result.current.start(selection) })
  const key = view.result.current.requests[0]!.key
  act(() => { view.result.current.cancel(key) })
  expect(translate.mock.calls[0]?.[1].aborted).toBe(true)
  expect(view.result.current.requests).toEqual([])
  act(() => { view.result.current.start(selection) })
  await act(async () => { retry.resolve(result('retry')) })
  await act(async () => { old.resolve(result('old')) })
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'ready', value: result('retry') })
})

it('retains structured failure information and replaces it after an explicit retry', async () => {
  const work = deferred()
  const translate = vi.fn<PdfTranslation['translate']>().mockImplementationOnce(() => work.promise)
    .mockResolvedValue(result('retry'))
  const view = renderHook(() => useTranslationRequests(commands(translate)))
  act(() => { view.result.current.start(selection) })
  await act(async () => { work.reject({ code: 'research/translation-failed', details: { reason: 'timeout' } }) })
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'failed', selection, reason: 'timeout' })
  await act(async () => { view.result.current.start(selection) })
  expect(view.result.current.requests[0]).toMatchObject({ kind: 'ready', value: result('retry') })
})
