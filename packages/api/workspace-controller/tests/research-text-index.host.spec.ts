/** Sentence windows retain source positions across columns, line breaks and page boundaries. */
import { expect, it } from 'vitest'
import { buildPaperTextIndex, extractPaperTextIndex, paperSelectionContext } from '../src/research-text-index.ts'
import type { PaperTextItem, PaperTextPage } from '../src/research-text-index.ts'
import type { ResearchPaperId } from '../src/research-types.ts'
import { pdfFixture } from '../../../client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'

const paperId = 'paper' as ResearchPaperId
const signal = (): AbortSignal => new AbortController().signal
function item(text: string, index: number, x = 40, y = 700 - index * 20, width = 220): PaperTextItem {
  return { text, item: index, x, y, width, height: 10 }
}
function page(items: readonly PaperTextItem[], number = 1): PaperTextPage { return { page: number, width: 600, height: 800, items } }

it('includes the containing sentence and exactly two available neighbors on either side', () => {
  const text = 'First observation. Second observation. The policy predicts actions. Fourth observation. Fifth observation. Sixth observation.'
  const index = buildPaperTextIndex([page([item(text, 0)])], 'sha')
  const start = text.indexOf('policy')
  const context = paperSelectionContext(index, { paperId, text: 'policy', start: { page: 1, item: 0, offset: start }, end: { page: 1, item: 0, offset: start + 6 } }, 1000)
  expect(context).toEqual({ selected: 'policy', sentence: 'The policy predicts actions.', selectionStart: 4,
    before: ['First observation.', 'Second observation.'],
    after: ['Fourth observation.', 'Fifth observation.'], startPage: 1, endPage: 1, limited: false })
})

it('uses item positions to distinguish repeated occurrences and rejects changed display text', () => {
  const index = buildPaperTextIndex([page([item('The policy starts. A policy ends.', 0)])], 'sha')
  const request = { paperId, text: 'policy', start: { page: 1, item: 0, offset: 21 }, end: { page: 1, item: 0, offset: 27 } }
  expect(paperSelectionContext(index, request, 1000).sentence).toBe('A policy ends.')
  expect(() => paperSelectionContext(index, { ...request, text: 'different' }, 1000)).toThrow(/located/)
  expect(() => paperSelectionContext(index, { ...request, end: { ...request.end, offset: 1000 } }, 1000)).toThrow(/located/)
})

it('reads all left-column lines before the right column and joins a hyphenated word', () => {
  const items = [item('First sentence.', 0, 40, 700), item('Other column one.', 1, 330, 700),
    item('A multi-', 2, 40, 680), item('Other column two.', 3, 330, 680),
    item('modal policy works.', 4, 40, 660), item('Other column three.', 5, 330, 660)]
  const index = buildPaperTextIndex([page(items)], 'sha')
  expect(index.blocks[0]?.text).toBe('First sentence. A multimodal policy works. Other column one. Other column two. Other column three.')
  const context = paperSelectionContext(index, { paperId, text: 'multi- modal', start: { page: 1, item: 2, offset: 2 }, end: { page: 1, item: 4, offset: 5 } }, 1000)
  expect(context.selected).toBe('multimodal')
  expect(context.sentence).toBe('A multimodal policy works.')
})

it('joins sentences across pages while isolating captions and headings', () => {
  const index = buildPaperTextIndex([page([item('Before. The policy', 0)]), page([item('predicts actions. After.', 0)], 2)], 'sha')
  const context = paperSelectionContext(index, { paperId, text: 'policy predicts', start: { page: 1, item: 0, offset: 12 }, end: { page: 2, item: 0, offset: 8 } }, 1000)
  expect(context.sentence).toBe('The policy predicts actions.')
  expect(context.startPage).toBe(1); expect(context.endPage).toBe(2)
  const captionIndex = buildPaperTextIndex([page([item('Body sentence.', 0), item('Fig. 1: A policy.', 1), item('More body.', 2, 40, 620)])], 'sha')
  expect(captionIndex.blocks.map(block => block.kind)).toEqual(['body', 'caption', 'body'])
})

it('keeps academic abbreviations and decimal values inside the selected sentence', () => {
  const text = 'Earlier result. See Fig. 2 for 0.5 accuracy and Smith et al. results. Next result.'
  const index = buildPaperTextIndex([page([item(text, 0)])], 'sha')
  const start = text.indexOf('accuracy')
  expect(paperSelectionContext(index, { paperId, text: 'accuracy', start: { page: 1, item: 0, offset: start }, end: { page: 1, item: 0, offset: start + 8 } }, 1000).sentence)
    .toBe('See Fig. 2 for 0.5 accuracy and Smith et al. results.')
})

it('reports a complete-context limit instead of presenting a truncated sentence', () => {
  const index = buildPaperTextIndex([page([item('The policy predicts actions.', 0)])], 'sha')
  expect(() => paperSelectionContext(index, { paperId, text: 'policy', start: { page: 1, item: 0, offset: 4 }, end: { page: 1, item: 0, offset: 10 } }, 8)).toThrow(/shorter/)
})

it('extracts the real PDF item ordering and releases resources after cancellation or index limits', async () => {
  const index = await extractPaperTextIndex(pdfFixture(), 'sha', 100_000, signal())
  expect(index.blocks[0]?.text).toBe('Selectable PDF text Selectable PDF text')
  expect(index.blocks[0]?.anchors.map(anchor => [anchor.page, anchor.item])).toEqual([[1, 0], [2, 0]])
  await expect(extractPaperTextIndex(pdfFixture(), 'sha', 1, signal())).rejects.toMatchObject({ details: { reason: 'limit' } })
  const stopped = new AbortController(); stopped.abort(new Error('closed'))
  await expect(extractPaperTextIndex(pdfFixture(), 'sha', 100_000, stopped.signal)).rejects.toThrow('closed')
})
