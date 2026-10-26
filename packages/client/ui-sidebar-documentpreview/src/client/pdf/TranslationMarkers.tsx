/** Zoom-independent translation marks and occurrence-history anchors above selectable PDF text. */
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { IconClockOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchHighlightRect, ResearchTranslationHistoryEntry, ResearchTranslationSelection } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from './locales.ts'
import css from './TranslationMarkers.module.css'

interface PageTranslation {
  readonly entry: ResearchTranslationHistoryEntry
  readonly rects: readonly ResearchHighlightRect[]
  readonly first: boolean
}

function groupEntries(entries: readonly ResearchTranslationHistoryEntry[]): readonly ResearchTranslationHistoryEntry[] {
  const groups = new Map<string, ResearchTranslationHistoryEntry>()
  for (const entry of entries) {
    if (entry.selection === undefined) continue
    const { start, end } = entry.selection
    const key = JSON.stringify([entry.translation.sourceSha256, start.page, start.item, start.offset, end.page, end.item, end.offset])
    groups.set(key, entry)
  }
  return [...groups.values()]
}

function nodeAtOffset(root: HTMLElement, offset: number): { node: Node; offset: number } | undefined {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
  }
  return undefined
}

/**
 * Recover legacy geometry from the current page's original text-item offsets.
 * @param surface - displayed page canvas and its PDF.js text layer.
 * @param page - one-based original page number.
 * @param selection - saved occurrence, independent of reader zoom.
 * @returns clipped page-normalized rectangles; absent or stale text items produce no mark.
 */
export function translationPageRects(
  surface: HTMLElement, page: number, selection: ResearchTranslationSelection,
): readonly ResearchHighlightRect[] {
  if (page < selection.start.page || page > selection.end.page) return []
  const saved = selection.rects?.filter(rect => rect.page === page)
  if (saved !== undefined && saved.length > 0) return saved
  const bounds = surface.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return []
  const rects: ResearchHighlightRect[] = []
  for (const item of surface.querySelectorAll<HTMLElement>('[data-pdf-text-item]')) {
    const index = Number(item.dataset['pdfTextItem'])
    if (page === selection.start.page && index < selection.start.item || page === selection.end.page && index > selection.end.item) continue
    const start = nodeAtOffset(item, page === selection.start.page && index === selection.start.item ? selection.start.offset : 0)
    const endOffset = page === selection.end.page && index === selection.end.item ? selection.end.offset : item.textContent.length
    const end = nodeAtOffset(item, endOffset)
    if (start === undefined || end === undefined) continue
    const range = surface.ownerDocument.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    if (range.collapsed) continue
    for (const box of Array.from(range.getClientRects())) {
      const left = Math.max(bounds.left, box.left), top = Math.max(bounds.top, box.top)
      const right = Math.min(bounds.right, box.right), bottom = Math.min(bounds.bottom, box.bottom)
      if (right <= left || bottom <= top) continue
      rects.push({ page, x: (left - bounds.left) / bounds.width, y: (top - bounds.top) / bounds.height,
        width: (right - left) / bounds.width, height: (bottom - top) / bounds.height })
    }
  }
  return rects
}

/**
 * Render one history anchor per translated occurrence while leaving the original text selectable.
 * @param props - saved results, displayed page, mounted surface, readiness, and reader locale.
 * @returns blue occurrence markers and their keyboard-accessible history buttons.
 */
export function TranslationLayer({ entries, page, surfaceRef, ready, t }: PropsLocale<'sidebarPdf'> & {
  readonly entries: readonly ResearchTranslationHistoryEntry[]
  readonly page: number
  readonly surfaceRef: RefObject<HTMLDivElement>
  readonly ready: boolean
}): ReactNode {
  const [marks, setMarks] = useState<readonly PageTranslation[]>([])
  useEffect(() => {
    const surface = surfaceRef.current
    if (!ready || surface === null) { setMarks([]); return }
    const update = (): void => {
      setMarks(groupEntries(entries).flatMap((entry) => {
        const selection = entry.selection
        if (selection === undefined) return []
        const rects = translationPageRects(surface, page, selection)
        return rects.length === 0 ? [] : [{ entry, rects, first: selection.start.page === page }]
      }))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(surface)
    return () => { observer.disconnect() }
  }, [entries, page, ready, surfaceRef])
  return <div className={css.layer} data-pdf-translations>
    {marks.map(({ entry, rects, first }) => <span key={entry.translation.key}>
      {rects.map((rect, index) => <span key={index} className={css.marker} data-pdf-translation={entry.translation.key}
        aria-hidden="true" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}
      {first && rects[0] !== undefined && <Tooltip label={t('translationHistoryOpen', { text: entry.translation.context.selected })} side="top" portal>
        <button type="button" className={css.history} data-pdf-translation-history={entry.translation.key}
          aria-label={t('translationHistoryOpen', { text: entry.translation.context.selected })}
          style={{ left: `clamp(0px, ${rects[0].x * 100}%, calc(100% - 24px))`, top: `max(0px, calc(${rects[0].y * 100}% - 24px))` }}>
          <IconClockOutlineRegular size={14} />
        </button>
      </Tooltip>}
    </span>)}
  </div>
}
