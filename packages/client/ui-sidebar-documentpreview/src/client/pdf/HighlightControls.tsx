/** Selection toolbar and confirmed marker overlays for paper-owned PDF annotations. */
import { useEffect, useRef, useState, type ReactNode, type RefObject, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, MenuSurface, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchHighlight, ResearchHighlightColor, ResearchHighlightId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { collectPdfSelection, highlightAtPoint, type PdfAnnotations, type PdfSelection } from './highlights.ts'
import type {} from './locales.ts'
import css from './HighlightControls.module.css'

const COLORS: readonly ResearchHighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'orange']
type PendingChange = Parameters<PdfAnnotations['change']>[0]

/** @param props - reader pages, paper-owned confirmed annotations, and locale. @returns selectable pages and a portalled color toolbar. */
export function AnnotatedPages({ annotations, t, children }: PropsLocale<'sidebarPdf'> & {
  readonly annotations: PdfAnnotations | undefined
  readonly children: ReactNode
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<PdfSelection>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<PendingChange>()
  const operation = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const dismiss = (): void => { if (!operation.current) { setSelection(undefined); setFailure(undefined) } }
  useEffect(() => {
    if (selection === undefined) return
    const outside = (event: PointerEvent): void => {
      if (!operation.current && event.target instanceof Node && !toolbar.current?.contains(event.target)) setSelection(undefined)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !operation.current) { setSelection(undefined); window.getSelection()?.removeAllRanges() }
    }
    const moved = (): void => { if (!operation.current) setSelection(undefined) }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', moved)
    }
  }, [selection])
  const apply = async (change: PendingChange): Promise<void> => {
    if (annotations === undefined || !annotations.available || operation.current) return
    operation.current = true; setBusy(true); setFailure(undefined)
    try {
      await annotations.change(change)
      if (mounted.current) {
        setSelection(undefined)
        window.getSelection()?.removeAllRanges()
      }
    } catch (error: unknown) {
      console.error('PDF highlight change failed:', error)
      if (mounted.current) setFailure(change)
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const capture = (): void => {
    if (annotations === undefined || operation.current || root.current === null) return
    setSelection(collectPdfSelection(root.current, window.getSelection()))
  }
  return <div ref={root} className={css.pages} onClick={(event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-pdf-highlight]') : null
    const highlight = annotations?.highlights.find(item => item.id === button?.dataset['pdfHighlight'])
    if (highlight !== undefined) void apply({ type: 'remove', id: highlight.id })
  }} onPointerUp={capture} onKeyUp={(event) => { if (event.key !== 'Escape') capture() }}
  onDoubleClickCapture={(event) => {
    if (annotations === undefined || root.current === null || operation.current) return
    const hit = highlightAtPoint(root.current, annotations.highlights, event.clientX, event.clientY)
    if (hit === undefined) return
    event.preventDefault()
    void apply({ type: 'remove', id: hit.id })
  }}>
    {children}
    {failure !== undefined && <div className={css.failure} role="alert">
      <span>{t('highlightFailed')}</span>
      <Button size="sm" disabled={busy} onClick={() => { void apply(failure) }}>{t('retry')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={dismiss}>{t('highlightDismiss')}</Button>
    </div>}
    {selection !== undefined && annotations !== undefined && <SelectionToolbar key={`${selection.anchor.x}:${selection.anchor.y}`} selection={selection} busy={busy || failure?.type === 'add'}
      available={annotations.available} toolbarRef={toolbar} t={t} onCancel={dismiss} onPick={(color) => {
        void apply({ type: 'add', highlight: { id: randomUUID() as ResearchHighlightId, color, text: selection.text, rects: selection.rects } })
      }} />}
  </div>
}

function SelectionToolbar({ selection, busy, available, toolbarRef, t, onPick, onCancel }: PropsLocale<'sidebarPdf'> & {
  readonly selection: PdfSelection
  readonly busy: boolean
  readonly available: boolean
  readonly toolbarRef: RefObject<HTMLDivElement>
  readonly onPick: (color: ResearchHighlightColor) => void
  readonly onCancel: () => void
}): ReactNode {
  const anchor = useRef<HTMLSpanElement>(null)
  const position = useAnchoredPosition({ open: true, anchorRef: anchor, panelRef: toolbarRef, side: 'top', gap: 8, margin: 12 })
  return createPortal(<>
    <span ref={anchor} className={css.anchor} aria-hidden="true" style={{ left: selection.anchor.x, top: selection.anchor.y }} />
    <MenuSurface ref={toolbarRef} compact className={css.toolbar} role="toolbar" aria-label={t('highlightColors')}
      aria-busy={busy} style={{ ...position, visibility: position === null ? 'hidden' : 'visible' }}
      onPointerDown={(event) => { event.preventDefault() }}>
      {COLORS.map(color => <Tooltip key={color} label={t(color)} side="top" portal>
        <button type="button" className={css.swatch} data-highlight-color={color} aria-label={t(color)}
          disabled={busy || !available} onClick={() => { onPick(color) }} />
      </Tooltip>)}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('highlightDismiss')}</Button>
      <span className={css.hint} role={available ? undefined : 'alert'}>{t(available ? 'highlightDeleteHint' : 'highlightRestartRequired')}</span>
    </MenuSurface>
  </>, document.body)
}

/** @param props - confirmed selections and one displayed page. @returns normalized marker overlays with keyboard deletion. */
export function HighlightLayer({ annotations, page, t }: PropsLocale<'sidebarPdf'> & {
  readonly annotations: PdfAnnotations | undefined
  readonly page: number
}): ReactNode {
  if (annotations === undefined) return null
  return <div className={css.layer} data-pdf-highlights>
    {annotations.highlights.flatMap(highlight => highlight.rects.filter(rect => rect.page === page).map((rect, index) => {
      const style = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }
      return <HighlightBox key={`${highlight.id}-${index}`} highlight={highlight} style={style} first={index === 0}
        available={annotations.available} t={t} />
    }))}
  </div>
}

function HighlightBox({ highlight, style, first, available, t }: PropsLocale<'sidebarPdf'> & {
  readonly highlight: ResearchHighlight
  readonly style: CSSProperties
  readonly first: boolean
  readonly available: boolean
}): ReactNode {
  return first ? <button type="button" className={css.marker} data-highlight-color={highlight.color} data-pdf-highlight={highlight.id}
    style={style} disabled={!available} aria-label={t('highlightRemove', { text: highlight.text })} />
    : <span className={css.marker} data-highlight-color={highlight.color} data-pdf-highlight={highlight.id} style={style} aria-hidden="true" />
}
