/** PDF text-item positions mapped into sentence-readable blocks in page and column order. */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchTranslationContext, ResearchTranslationRequest } from './research-translation-types.ts'

const anchorSchema = z.object({ page: z.number().int().positive(), item: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), length: z.number().int().nonnegative() })
/** Validates the derived cache when it re-enters from disk. */
export const paperTextIndexSchema = z.object({
  version: z.literal(1), sourceSha256: z.string(),
  blocks: z.array(z.object({ kind: z.enum(['body', 'heading', 'caption', 'references']), text: z.string(),
    anchors: z.array(anchorSchema) })),
})
/** Rebuildable text cache; item ordinals count nonempty PDF.js strings only. */
export type PaperTextIndex = z.infer<typeof paperTextIndexSchema>
/** Original text and page coordinates, before reading-order reconstruction. */
export interface PaperTextItem {
  readonly item: number
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
/** One unrotated source page. */
export interface PaperTextPage {
  readonly page: number
  readonly width: number
  readonly height: number
  readonly items: readonly PaperTextItem[]
}

interface Line { items: PaperTextItem[]; x: number; right: number; y: number; height: number }

function linesOf(page: PaperTextPage): Line[] {
  const rows: Line[] = []
  for (const item of [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find(line => Math.abs(line.y - item.y) < Math.min(line.height, item.height) * 0.4)
    if (row === undefined) rows.push({ items: [item], x: item.x, right: item.x + item.width, y: item.y, height: item.height })
    else { row.items.push(item); row.x = Math.min(row.x, item.x); row.right = Math.max(row.right, item.x + item.width) }
  }
  const lines: Line[] = []
  for (const row of rows) {
    let current: Line | undefined
    for (const item of row.items.sort((a, b) => a.x - b.x)) {
      if (current === undefined || item.x - current.right > Math.max(item.height * 2.5, page.width * 0.035)) {
        current = { items: [item], x: item.x, right: item.x + item.width, y: item.y, height: item.height }
        lines.push(current)
      } else { current.items.push(item); current.right = Math.max(current.right, item.x + item.width) }
    }
  }
  return lines.sort((a, b) => b.y - a.y || a.x - b.x)
}

function ordered(lines: Line[], width: number): Line[] {
  const middle = width / 2
  const left = lines.filter(line => line.right < middle && line.right > width * 0.3)
  const right = lines.filter(line => line.x > middle && line.x < width * 0.7)
  if (left.length < 3 || right.length < 3) return lines
  const result: Line[] = [], band: Line[] = []
  const flush = (): void => {
    result.push(...band.filter(line => line.x < middle), ...band.filter(line => line.x >= middle)); band.length = 0
  }
  for (const line of lines) {
    if (line.x < middle && line.right > middle) { flush(); result.push(line) }
    else band.push(line)
  }
  flush()
  return result
}

/**
 * Reconstruct body, heading and caption blocks while preserving exact source-item offsets.
 * @param pages - source text items in their original coordinate system.
 * @param sourceSha256 - identity of the indexed original.
 * @returns a cache with repeated margin text removed and common two-column layouts ordered.
 */
export function buildPaperTextIndex(pages: readonly PaperTextPage[], sourceSha256: string): PaperTextIndex {
  const all = pages.map(page => ({ ...page, lines: linesOf(page) }))
  const margins = new Map<string, Set<number>>()
  for (const page of all) for (const line of page.lines) {
    if (line.y < page.height * 0.05 || line.y > page.height * 0.95) {
      const text = line.items.map(item => item.text).join(' ').replace(/\d+/g, '#').trim()
      const found = margins.get(text) ?? new Set<number>(); found.add(page.page); margins.set(text, found)
    }
  }
  const blocks: PaperTextIndex['blocks'] = []
  let block: PaperTextIndex['blocks'][number] | undefined, references = false
  for (const page of all) {
    const heights = page.items.map(item => item.height).sort((a, b) => a - b)
    const bodyHeight = heights[Math.floor(heights.length / 2)] ?? 10
    let previous: Line | undefined
    for (const line of ordered(page.lines, page.width)) {
      const text = line.items.map(item => item.text).join(' ').trim()
      const margin = line.y < page.height * 0.05 || line.y > page.height * 0.95
      const recurring = (margins.get(text.replace(/\d+/g, '#'))?.size ?? 0) >= Math.max(2, Math.ceil(pages.length * 0.6))
      if (margin && (recurring || /^\d+$/.test(text))) continue
      if (/^\d+$/.test(text) && line.x < page.width * 0.04) continue
      const sectionTitle = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|conclusion|references|bibliography|appendix)\s*$/i
      const heading = line.height > bodyHeight * 1.2 || sectionTitle.test(text)
      if (/^(?:\d+\.?\s+)?(?:references|bibliography)\s*$/i.test(text)) references = true
      else if (/^(?:\d+\.?\s+)?appendix\b/i.test(text)) references = false
      const caption = /^(?:fig(?:ure)?\.?|table)\s*\d+\s*[:.]/i.test(text)
      const gap = previous !== undefined && (previous.y - line.y > line.height * 1.8 || line.y > previous.y + line.height)
      const kind = references ? 'references' : heading ? 'heading' : caption || (block?.kind === 'caption' && !gap) ? 'caption' : 'body'
      if (block === undefined || block.kind !== kind || heading || caption) {
        block = { kind, text: '', anchors: [] }; blocks.push(block)
      }
      let preceding: PaperTextItem | undefined
      for (const item of line.items) {
        if (block.text.endsWith('-') && previous !== line && /^[a-z]/.test(item.text)) {
          block.text = block.text.slice(0, -1)
          const last = block.anchors.at(-1)
          if (last !== undefined) last.end = Math.min(last.end, block.text.length)
        } else if (block.text !== '' && !/\s$/.test(block.text) && !/^\s|^[,.;:!?)]/.test(item.text)
          && (preceding === undefined || item.x - preceding.x - preceding.width > item.height * 0.12)) block.text += ' '
        const start = block.text.length
        block.text += item.text
        block.anchors.push({ page: page.page, item: item.item, start, end: block.text.length, length: item.text.length })
        previous = line
        preceding = item
      }
    }
  }
  return { version: 1, sourceSha256, blocks }
}

/**
 * Parse a bounded original into a rebuildable position index, releasing its worker on every outcome.
 * @param bytes - validated original PDF bytes.
 * @param sourceSha256 - identity of those exact bytes.
 * @param maxBytes - serialized cache budget.
 * @param signal - operation cancellation and deadline.
 * @returns a complete position index; scans and over-limit originals fail explicitly.
 */
export async function extractPaperTextIndex(
  bytes: Uint8Array, sourceSha256: string, maxBytes: number, signal: AbortSignal,
): Promise<PaperTextIndex> {
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: true, verbosity: 0 })
  let closing: Promise<void> | undefined
  const cancel = (): void => { closing ??= task.destroy(); void closing.catch((_error: unknown) => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const document = await task.promise
    const pages: PaperTextPage[] = []
    let size = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted()
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent({ disableNormalization: true })
        const items: PaperTextItem[] = []
        for (const item of content.items) {
          if (!('str' in item) || item.str === '') continue
          // PDF.js exposes transform as any[]; its text matrix contains six numbers.
          const matrix = item.transform as readonly number[]
          items.push({ item: items.length, text: item.str, x: matrix[4] ?? 0, y: matrix[5] ?? 0,
            width: item.width, height: item.height || Math.hypot(matrix[2] ?? 0, matrix[3] ?? 0) || 1 })
        }
        size += Buffer.byteLength(JSON.stringify(items))
        if (size > maxBytes) throw new RemoteError('research/translation-failed', 'The paper text index exceeds its configured limit', { reason: 'limit' })
        const [left = 0, bottom = 0, right = 0, top = 0] = page.view
        pages.push({ page: pageNumber, width: right - left, height: top - bottom, items })
      } finally { page.cleanup() }
    }
    const index = buildPaperTextIndex(pages, sourceSha256)
    if (!index.blocks.some(block => block.text.trim() !== '')) throw new RemoteError('research/translation-failed', 'This PDF needs OCR before text translation', { reason: 'no-text' })
    if (Buffer.byteLength(JSON.stringify(index)) > maxBytes) throw new RemoteError('research/translation-failed', 'The paper text index exceeds its configured limit', { reason: 'limit' })
    return index
  } finally { signal.removeEventListener('abort', cancel); await (closing ?? task.destroy()) }
}

function sentences(text: string): { text: string; start: number; end: number }[] {
  const result: { text: string; start: number; end: number }[] = []
  for (const part of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    const previous = result.at(-1)
    if (previous !== undefined && /\b(?:figs?|eqs?|refs?|secs?|e\.g|i\.e|et al|vs|dr|prof)\.\s*$/i.test(previous.text)) {
      previous.text += part.segment; previous.end = part.index + part.segment.length
    } else result.push({ text: part.segment, start: part.index, end: part.index + part.segment.length })
  }
  return result
}

/**
 * Resolve one exact occurrence and include at most two sentences on either side within its block.
 * @param index - position index of the managed original.
 * @param request - reader text-item positions and selected display text.
 * @param maxCharacters - complete context budget; over-limit selections reject rather than silently truncate.
 * @returns original selected text, containing sentence(s), neighbors, pages and a limited-context marker.
 */
export function paperSelectionContext(
  index: PaperTextIndex, request: ResearchTranslationRequest, maxCharacters: number,
): ResearchTranslationContext {
  for (const block of index.blocks) {
    const start = block.anchors.find(item => item.page === request.start.page && item.item === request.start.item)
    const end = block.anchors.find(item => item.page === request.end.page && item.item === request.end.item)
    if (start === undefined || end === undefined) continue
    if (request.start.offset > start.length || request.end.offset > end.length) break
    let from = Math.min(start.end, start.start + request.start.offset), to = Math.min(end.end, end.start + request.end.offset)
    while (from < to && /\s/.test(block.text[from] ?? '')) from++
    while (to > from && /\s/.test(block.text[to - 1] ?? '')) to--
    const selected = block.text.slice(from, to).trim()
    const comparable = (text: string): string => text.normalize('NFKC').replace(/[\s\u00ad-]/g, '')
    if (from >= to || selected === '' || comparable(selected) !== comparable(request.text)) break
    const parts = sentences(block.text)
    const first = parts.findIndex(part => part.end > from), last = parts.findIndex(part => part.end >= to)
    if (first < 0 || last < first) break
    const originalSentence = parts.slice(first, last + 1).map(part => part.text).join('')
    const sentence = originalSentence.trim()
    const selectionStart = from - (parts[first]?.start ?? 0) - (originalSentence.length - originalSentence.trimStart().length)
    const before = parts.slice(Math.max(0, first - 2), first).map(part => part.text.trim())
    const after = parts.slice(last + 1, last + 3).map(part => part.text.trim())
    if ([...before, sentence, ...after].join(' ').length > maxCharacters) {
      throw new RemoteError('research/translation-failed', 'Select a shorter passage to translate', { reason: 'limit' })
    }
    return { selected, sentence, selectionStart, before, after, startPage: request.start.page, endPage: request.end.page,
      limited: before.length < 2 || after.length < 2 || block.kind !== 'body' }
  }
  throw new RemoteError('research/translation-failed', 'The selected text could not be located in the original; select it again', { reason: 'selection' })
}
