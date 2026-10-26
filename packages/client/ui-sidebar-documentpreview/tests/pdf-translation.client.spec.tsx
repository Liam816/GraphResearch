// @vitest-environment jsdom
/** Translation is an explicit selection action and remains independent of PDF marker writes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchPaperId, ResearchTranslation } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { AnnotatedPages } from '../src/client/pdf/HighlightControls.tsx'
import type { PdfAnnotations, PdfTranslation } from '../src/client/pdf/highlights.ts'
import { en } from '../src/client/pdf/locales.ts'

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
const result: ResearchTranslation = { key: 'translation', paperId: 'paper' as ResearchPaperId, sourceSha256: 'sha',
  context: { selected: 'policy', sentence: 'The policy predicts actions.', selectionStart: 4,
    before: ['First context.', 'Second context.'], after: ['Next context.', 'Last context.'],
    startPage: 1, endPage: 1, limited: false },
  result: { kind: 'word', lemma: 'policy', partOfSpeech: '名词', meanings: ['政策；方针；策略'], contextualMeaning: '机器人动作策略',
    explanation: '这里描述根据观测生成动作的方法。', translation: '该策略预测动作。' },
  pronunciation: { status: 'ready', phonetics: ['/ˈpɒləsi/'], sourceUrl: 'https://dictionaryapi.dev/' },
}

beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [new DOMRect(10, 20, 60, 12)] })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 800))
})
afterEach(() => {
  cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalRects === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects')
  else Object.defineProperty(Range.prototype, 'getClientRects', originalRects)
})

function fixture(history?: PdfTranslation['history']) {
  const translate = vi.fn<PdfTranslation['translate']>(async () => result)
  const save = vi.fn<PdfTranslation['save']>(async () => {})
  const ask = vi.fn<PdfTranslation['ask']>(async () => {})
  const change = vi.fn<PdfAnnotations['change']>(async () => {})
  const view = render(<AnnotatedPages annotations={{ highlights: [], available: true, change }}
    translation={{ translate, save, ask, ...history === undefined ? {} : { history } }} t={makeTranslate(en)}>
    {entries => <><div data-pdf-page="1"><div data-document-zoom-surface><div data-pdf-text>
      <span data-pdf-text-item="0">The policy predicts actions.</span>
    </div></div></div>{entries.map(entry => <button key={entry.translation.key} type="button"
      data-pdf-translation-history={entry.translation.key}>Saved translation: {entry.translation.context.selected}</button>)}</>}
  </AnnotatedPages>)
  const text = view.container.querySelector('[data-pdf-text-item]')!.firstChild!
  const select = (start = 4, end = 10): void => {
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    fireEvent.pointerUp(text.parentElement!)
  }
  return { ...view, translate, save, ask, change, select, text }
}

it('sends no translation when selecting or highlighting and translates only after its button is clicked', async () => {
  const view = fixture(); view.select()
  expect(view.translate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText('机器人动作策略')
  expect(view.translate).toHaveBeenCalledTimes(1)
  expect(view.translate.mock.calls[0]?.[0]).toEqual({ text: 'policy', start: { page: 1, item: 0, offset: 4 }, end: { page: 1, item: 0, offset: 10 },
    rects: [{ page: 1, x: 10 / 600, y: 20 / 800, width: 60 / 600, height: 12 / 800 }] })
  expect(view.change).not.toHaveBeenCalled()
  expect(window.getSelection()?.toString()).toBe('policy')
  fireEvent.click(screen.getByRole('button', { name: en.yellow }))
  await waitFor(() => { expect(view.change).toHaveBeenCalledTimes(1) })
  expect(view.change.mock.calls[0]?.[0]).toMatchObject({ type: 'add', highlight: { text: 'policy', color: 'yellow' } })
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.blue }))
  await waitFor(() => { expect(view.change).toHaveBeenCalledTimes(2) })
  expect(view.translate).toHaveBeenCalledTimes(1)
})

it('shows general meanings before contextual meaning, pronunciation, sentence translation and collapsed original context', async () => {
  const view = fixture(); view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  const region = await screen.findByRole('region', { name: en.translationTitle })
  await screen.findByText(result.result.contextualMeaning)
  expect(region.textContent.indexOf(en.translationMeanings)).toBeLessThan(region.textContent.indexOf(en.translationContextual))
  expect(screen.getByText('/ˈpɒləsi/')).toBeDefined()
  expect(screen.getByText('该策略预测动作。')).toBeDefined()
  const details = region.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('First context.'); expect(details.textContent).toContain('Last context.')
  expect(region.querySelector('mark')?.textContent).toBe('policy')
})

it('retains a failed translation for retry and saves notes or inserts Agent context only on request', async () => {
  const view = fixture(); view.translate.mockRejectedValueOnce({ code: 'research/translation-failed', details: { reason: 'timeout' } })
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText(en.translationTimeout)
  expect(window.getSelection()?.toString()).toBe('policy')
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(result.result.contextualMeaning)
  expect(view.save).not.toHaveBeenCalled(); expect(view.ask).not.toHaveBeenCalled()
  view.save.mockRejectedValueOnce(new Error('note conflict'))
  fireEvent.click(screen.getByRole('button', { name: en.translationSave }))
  await screen.findByText(en.translationSaveFailed)
  fireEvent.click(screen.getByRole('button', { name: en.translationSave }))
  await screen.findByRole('button', { name: en.translationSaved })
  expect(view.save).toHaveBeenCalledWith(result)
  fireEvent.click(screen.getByRole('button', { name: en.translationAsk }))
  await screen.findByText(en.translationInserted)
  expect(view.ask).toHaveBeenCalledWith(result)
})

it('keeps an earlier request running without replacing the card for a more recent selection', async () => {
  const view = fixture()
  let settle!: (value: ResearchTranslation) => void
  view.translate.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await waitFor(() => { expect(view.translate).toHaveBeenCalledTimes(1) })
  const oldSignal = view.translate.mock.calls[0]![1]
  view.select(11, 19)
  expect(oldSignal.aborted).toBe(false)
  expect(screen.queryByRole('region', { name: en.translationTitle })).toBeNull()
  view.translate.mockResolvedValueOnce({ ...result, result: { ...result.result, contextualMeaning: '最新选词解释' } })
  fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText('最新选词解释')
  settle(result)
  await waitFor(() => { expect(screen.queryByText('机器人动作策略')).toBeNull() })
  expect(screen.getByText('最新选词解释')).toBeDefined()
  expect(oldSignal.aborted).toBe(false)
})

it('keeps a pinned card across outside clicks and dismisses it with Escape', async () => {
  const view = fixture(); view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText(result.result.contextualMeaning)
  fireEvent.click(screen.getByRole('button', { name: en.translationPin }))
  fireEvent.pointerDown(document.body)
  window.getSelection()?.removeAllRanges()
  fireEvent.pointerUp(view.container.querySelector('[data-pdf-page]')!)
  expect(screen.getByRole('region', { name: en.translationTitle })).toBeDefined()
  expect(screen.getByRole('button', { name: en.translationUnpin })).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('region', { name: en.translationTitle })).toBeNull()
  expect(view.translate.mock.calls[0]![1].aborted).toBe(false)
})

it.each(['scroll', 'outside', 'escape', 'close'] as const)('finishes and saves a translation after %s hides its card', async (gesture) => {
  const saved = { translation: result, selection: { start: { page: 1, item: 0, offset: 4 }, end: { page: 1, item: 0, offset: 10 } } }
  const list = vi.fn<NonNullable<PdfTranslation['history']>['list']>().mockResolvedValueOnce([]).mockResolvedValue([saved])
  const view = fixture({ key: 'paper:sha', list })
  let settle!: (value: ResearchTranslation) => void
  view.translate.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await waitFor(() => { expect(view.translate).toHaveBeenCalledTimes(1) })
  const signal = view.translate.mock.calls[0]![1]
  if (gesture === 'scroll') fireEvent.scroll(view.container.querySelector('[data-pdf-page]')!)
  else if (gesture === 'outside') fireEvent.pointerDown(document.body)
  else if (gesture === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: en.translationHistoryClose }))
  expect(screen.queryByRole('region', { name: en.translationTitle })).toBeNull()
  expect(signal.aborted).toBe(false)
  expect(screen.getByRole('button', { name: 'Translating “policy”' })).toBeDefined()
  settle(result)
  fireEvent.click(await screen.findByRole('button', { name: 'Saved translation: policy' }))
  await screen.findByRole('region', { name: en.translationHistory })
  expect(screen.getByText('机器人动作策略')).toBeDefined()
  expect(view.translate).toHaveBeenCalledTimes(1)
  expect(signal.aborted).toBe(false)
})

it('reopens pending progress and retries a failed hidden translation without losing the passage', async () => {
  const view = fixture()
  let reject!: (error: unknown) => void
  view.translate.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  fireEvent.pointerDown(document.body)
  fireEvent.click(screen.getByRole('button', { name: 'Translating “policy”' }))
  expect(screen.getByRole('region', { name: en.translationTitle }).getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button', { name: en.translate }).hasAttribute('disabled')).toBe(true)
  expect(view.translate).toHaveBeenCalledTimes(1)
  fireEvent.scroll(view.container.querySelector('[data-pdf-page]')!)
  reject({ code: 'research/translation-failed', details: { reason: 'timeout' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Translation failed: policy' }))
  await screen.findByText(en.translationTimeout)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(result.result.contextualMeaning)
  expect(view.translate).toHaveBeenCalledTimes(2)
})

it('cancels a pending request only through the explicit translation cancel action', async () => {
  const view = fixture()
  let settle!: (value: ResearchTranslation) => void
  view.translate.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  const signal = view.translate.mock.calls[0]![1]
  fireEvent.click(screen.getByRole('button', { name: en.translationCancel }))
  expect(signal.aborted).toBe(true)
  expect(screen.queryByRole('region', { name: en.translationTasks })).toBeNull()
  expect(screen.queryByRole('region', { name: en.translationTitle })).toBeNull()
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText(result.result.contextualMeaning)
  expect(view.translate).toHaveBeenCalledTimes(2)
  settle({ ...result, result: { ...result.result, contextualMeaning: '取消后的旧结果' } })
  await waitFor(() => { expect(screen.queryByText('取消后的旧结果')).toBeNull() })
})

it('reports device speech and Agent insertion failures while retaining the translation', async () => {
  const view = fixture(); view.ask.mockRejectedValueOnce(new Error('composer unavailable'))
  view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText(result.result.contextualMeaning)
  fireEvent.click(screen.getByRole('button', { name: en.translationSpeak }))
  await screen.findByText(en.translationSpeakFailed)
  fireEvent.click(screen.getByRole('button', { name: en.translationAsk }))
  await screen.findByText(en.translationAskFailed)
  expect(screen.getByText(result.result.contextualMeaning)).toBeDefined()
})

it('reads the base word with device English speech and stops its owned utterance on dismissal', async () => {
  const speak = vi.fn(), cancel = vi.fn()
  vi.stubGlobal('speechSynthesis', { speak, cancel })
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    lang = ''
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly text: string) {}
  })
  const view = fixture(); view.select(); fireEvent.click(screen.getByRole('button', { name: en.translate }))
  await screen.findByText(result.result.contextualMeaning)
  fireEvent.click(screen.getByRole('button', { name: en.translationSpeak }))
  expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'policy', lang: 'en-US' }))
  expect(screen.getByRole('button', { name: en.translationStopSpeaking })).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(cancel).toHaveBeenCalledTimes(1)
})
