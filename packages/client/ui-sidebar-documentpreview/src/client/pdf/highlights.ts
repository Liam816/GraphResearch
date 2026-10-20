/** Page-relative PDF selection geometry shared by marker rendering and persistence callbacks. */
import type { ResearchHighlight, ResearchHighlightRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchTextPosition, ResearchTranslation, ResearchTranslationRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Paper-owned translation and notebook commands; the generic reader supplies only selection positions. */
export interface PdfTranslation {
  readonly translate: (selection: Omit<ResearchTranslationRequest, 'paperId'>, signal: AbortSignal) => Promise<ResearchTranslation>
  readonly save: (translation: ResearchTranslation) => Promise<void>
  readonly ask: (translation: ResearchTranslation) => Promise<void>
}

/** Confirmed annotations and the paper owner's idempotent mutation callback. */
export interface PdfAnnotations {
  /** Whether the current Host advertises its annotation write API. */
  readonly available: boolean
  readonly highlights: readonly ResearchHighlight[]
  readonly change: (change: ResearchHighlightRequest['change']) => Promise<void>
}

/** Text and normalized rectangles captured before the browser selection loses focus. */
export interface PdfSelection {
  readonly text: string
  readonly rects: ResearchHighlight['rects']
  readonly anchor: { readonly x: number; readonly y: number }
  readonly start?: ResearchTextPosition
  readonly end?: ResearchTextPosition
}

/**
 * Capture only selected text belonging to this reader, clipping rectangles to their individual pages.
 * @param root - the current reader's page container.
 * @param selection - native browser selection.
 * @returns page-relative text geometry, or undefined for collapsed or unrelated selections.
 */
export function collectPdfSelection(root: HTMLElement, selection: Selection | null): PdfSelection | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  const textParent = (node: Node): Element | null => node instanceof Element ? node : node.parentElement
  const start = textParent(range.startContainer)?.closest('[data-pdf-text]')
  const end = textParent(range.endContainer)?.closest('[data-pdf-text]')
  if (start === undefined || start === null || end === undefined || end === null || !root.contains(start) || !root.contains(end)) return
  const rects: ResearchHighlight['rects'][number][] = []
  const fragments: string[] = []
  let anchor: PdfSelection['anchor'] | undefined
  let startPosition: ResearchTextPosition | undefined, endPosition: ResearchTextPosition | undefined
  for (const page of root.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
    const surface = page.querySelector<HTMLElement>('[data-document-zoom-surface]')
    const layer = page.querySelector('[data-pdf-text]')
    if (surface === null || layer === null) continue
    const bounds = surface.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) continue
    const walker = root.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue
      const fragment = root.ownerDocument.createRange()
      fragment.selectNodeContents(node)
      if (range.compareBoundaryPoints(Range.START_TO_START, fragment) > 0) fragment.setStart(range.startContainer, range.startOffset)
      if (range.compareBoundaryPoints(Range.END_TO_END, fragment) < 0) fragment.setEnd(range.endContainer, range.endOffset)
      if (fragment.collapsed) continue
      fragments.push(fragment.toString())
      const item = node.parentElement?.closest<HTMLElement>('[data-pdf-text-item]')
      if (item !== null && item !== undefined) {
        const position = { page: Number(page.dataset['pdfPage']), item: Number(item.dataset['pdfTextItem']) }
        startPosition ??= { ...position, offset: fragment.startOffset }
        endPosition = { ...position, offset: fragment.endOffset }
      }
      for (const box of Array.from(fragment.getClientRects())) {
        const left = Math.max(bounds.left, box.left), top = Math.max(bounds.top, box.top)
        const right = Math.min(bounds.right, box.right), bottom = Math.min(bounds.bottom, box.bottom)
        if (right <= left || bottom <= top) continue
        anchor ??= { x: left, y: top }
        rects.push({ page: Number(page.dataset['pdfPage']), x: (left - bounds.left) / bounds.width,
          y: (top - bounds.top) / bounds.height, width: (right - left) / bounds.width, height: (bottom - top) / bounds.height })
      }
    }
  }
  const text = fragments.join(' ').replace(/\s+/g, ' ').trim()
  if (rects.length === 0 || text === '' || anchor === undefined) return
  return { text, rects, anchor, ...startPosition === undefined ? {} : { start: startPosition },
    ...endPosition === undefined ? {} : { end: endPosition } }
}

/**
 * Locate a marker beneath the selectable text layer without intercepting ordinary selection gestures.
 * @param root - current reader.
 * @param highlights - confirmed markers.
 * @param x - viewport pointer coordinate.
 * @param y - viewport pointer coordinate.
 * @returns the newest overlapping selection, if any.
 */
export function highlightAtPoint(
  root: HTMLElement, highlights: readonly ResearchHighlight[], x: number, y: number,
): ResearchHighlight | undefined {
  for (const page of root.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
    const surface = page.querySelector<HTMLElement>('[data-document-zoom-surface]')
    if (surface === null) continue
    const bounds = surface.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0 || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue
    const relativeX = (x - bounds.left) / bounds.width, relativeY = (y - bounds.top) / bounds.height
    return [...highlights].reverse().find(item => item.rects.some(rect => rect.page === Number(page.dataset['pdfPage'])
      && relativeX >= rect.x && relativeX <= rect.x + rect.width && relativeY >= rect.y && relativeY <= rect.y + rect.height))
  }
  return undefined
}
