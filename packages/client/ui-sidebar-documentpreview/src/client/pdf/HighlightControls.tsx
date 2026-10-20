/** Selection toolbar and confirmed marker overlays for paper-owned PDF annotations. */
import { useEffect, useRef, useState, type ReactNode, type RefObject, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, MenuSurface, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchHighlight, ResearchHighlightColor, ResearchHighlightId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { collectPdfSelection, highlightAtPoint, type PdfAnnotations, type PdfSelection, type PdfTranslation } from './highlights.ts'
import { TranslationCard } from './TranslationCard.tsx'
import type {} from './locales.ts'
import css from './HighlightControls.module.css'

const COLORS: readonly ResearchHighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'orange']
type PendingChange = Parameters<PdfAnnotations['change']>[0]

/** @param props - reader pages, paper-owned confirmed annotations, and locale. @returns selectable pages and a portalled color toolbar. */
export function AnnotatedPages({ annotations, translation, t, children }: PropsLocale<'sidebarPdf'> & {
  readonly annotations: PdfAnnotations | undefined
  readonly translation?: PdfTranslation | undefined
  readonly children: ReactNode
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<PdfSelection>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<PendingChange>()
  const [pinned, setPinned] = useState(false)
  const [editing, setEditing] = useState<{ highlight: ResearchHighlight; anchor: PdfSelection['anchor'] }>()
  const operation = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const dismiss = (): void => {
    if (!operation.current) { setSelection(undefined); setEditing(undefined); setFailure(undefined); setPinned(false) }
  }
  useEffect(() => {
    if (selection === undefined && editing === undefined) return
    const outside = (event: PointerEvent): void => {
      if (!operation.current && !pinned && event.target instanceof Node && !toolbar.current?.contains(event.target)) {
        setSelection(undefined); setEditing(undefined)
      }
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !operation.current) {
        setSelection(undefined); setEditing(undefined); setPinned(false); window.getSelection()?.removeAllRanges()
      }
    }
    const moved = (event: Event): void => {
      if (!operation.current && !pinned && !(event.target instanceof Node && toolbar.current?.contains(event.target))) {
        setSelection(undefined); setEditing(undefined)
      }
    }
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
  }, [selection, editing, pinned])
  const apply = async (change: PendingChange): Promise<void> => {
    if (annotations === undefined || !annotations.available || operation.current) return
    operation.current = true; setBusy(true); setFailure(undefined)
    try {
      await annotations.change(change)
      if (mounted.current) {
        setSelection(undefined)
        setEditing(undefined)
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
    if ((annotations === undefined && translation === undefined) || operation.current || root.current === null) return
    const next = collectPdfSelection(root.current, window.getSelection())
    if (next === undefined && pinned) return
    setSelection(next); setEditing(undefined); setPinned(false)
  }
  return <div ref={root} className={css.pages} onClick={(event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-pdf-highlight]') : null
    const highlight = annotations?.highlights.find(item => item.id === button?.dataset['pdfHighlight'])
    if (highlight !== undefined) void apply({ type: 'remove', id: highlight.id })
  }} onPointerUp={(event) => {
    if (event.target instanceof Node && !root.current?.contains(event.target)) return
    capture()
    if (annotations === undefined || root.current === null || operation.current || !window.getSelection()?.isCollapsed) return
    const hit = highlightAtPoint(root.current, annotations.highlights, event.clientX, event.clientY)
    if (hit !== undefined) setEditing({ highlight: hit, anchor: { x: event.clientX, y: event.clientY } })
  }} onKeyUp={(event) => {
    if (event.key !== 'Escape' && event.target instanceof Node && root.current?.contains(event.target)) capture()
  }}>
    {children}
    {failure !== undefined && <div className={css.failure} role="alert">
      <span>{t('highlightFailed')}</span>
      <Button size="sm" disabled={busy} onClick={() => { void apply(failure) }}>{t('retry')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={dismiss}>{t('highlightDismiss')}</Button>
    </div>}
    {selection !== undefined && <SelectionToolbar key={JSON.stringify([selection.anchor, selection.start, selection.end, selection.text])}
      selection={selection} busy={busy || failure?.type === 'add'} translation={translation} pinned={pinned} onPin={() => { setPinned(value => !value) }}
      available={annotations?.available === true} toolbarRef={toolbar} t={t} onCancel={dismiss} onPick={(color) => {
        void apply({ type: 'add', highlight: { id: randomUUID() as ResearchHighlightId, color, text: selection.text, rects: selection.rects } })
      }} />}
    {editing !== undefined && selection === undefined && <HighlightMenu anchor={editing.anchor} toolbarRef={toolbar} t={t} busy={busy}
      available={annotations?.available === true} onCancel={dismiss} onRemove={() => { void apply({ type: 'remove', id: editing.highlight.id }) }} />}
  </div>
}

function SelectionToolbar({ selection, busy, available, toolbarRef, t, onPick, onCancel, translation, pinned, onPin }: PropsLocale<'sidebarPdf'> & {
  readonly selection: PdfSelection
  readonly busy: boolean
  readonly available: boolean
  readonly toolbarRef: RefObject<HTMLDivElement>
  readonly onPick: (color: ResearchHighlightColor) => void
  readonly onCancel: () => void
  readonly translation: PdfTranslation | undefined
  readonly pinned: boolean
  readonly onPin: () => void
}): ReactNode {
  const anchor = useRef<HTMLSpanElement>(null)
  const [translated, setTranslated] = useState(false)
  const position = useAnchoredPosition({ open: true, anchorRef: anchor, panelRef: toolbarRef, side: translated ? 'bottom' : 'top', gap: 8, margin: 12 })
  return createPortal(<>
    <span ref={anchor} className={css.anchor} aria-hidden="true" style={{ left: selection.anchor.x, top: selection.anchor.y }} />
    <MenuSurface ref={toolbarRef} compact className={`${css.toolbar} ${translated ? css.withTranslation : ''}`}
      style={{ ...position, visibility: position === null ? 'hidden' : 'visible' }}>
      <div className={css.selectionActions} role="toolbar" aria-label={t('highlightColors')} aria-busy={busy}
        onPointerDown={(event) => { event.preventDefault() }}>
        {COLORS.map(color => <Tooltip key={color} label={t(color)} side="top" portal>
          <button type="button" className={css.swatch} data-highlight-color={color} aria-label={t(color)}
            disabled={busy || !available} onClick={() => { onPick(color) }} />
        </Tooltip>)}
        {translation !== undefined && <Button size="sm" variant={translated ? 'primary' : 'ghost'} disabled={busy || selection.start === undefined || selection.end === undefined}
          onClick={() => { setTranslated(true) }}>{t('translate')}</Button>}
        {translated && <Button size="sm" variant="ghost" aria-pressed={pinned} onClick={onPin}>{t(pinned ? 'translationUnpin' : 'translationPin')}</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('highlightDismiss')}</Button>
      </div>
      <span className={css.hint} role={available ? undefined : 'alert'}>{t(available ? 'highlightDeleteHint' : 'highlightRestartRequired')}</span>
      {translated && translation !== undefined && <TranslationCard selection={selection} translation={translation} t={t} />}
    </MenuSurface>
  </>, document.body)
}

function HighlightMenu({ anchor: point, toolbarRef, t, busy, available, onCancel, onRemove }: PropsLocale<'sidebarPdf'> & {
  readonly anchor: PdfSelection['anchor']
  readonly toolbarRef: RefObject<HTMLDivElement>
  readonly busy: boolean
  readonly available: boolean
  readonly onCancel: () => void
  readonly onRemove: () => void
}): ReactNode {
  const anchor = useRef<HTMLSpanElement>(null)
  const position = useAnchoredPosition({ open: true, anchorRef: anchor, panelRef: toolbarRef, side: 'top', gap: 8, margin: 12 })
  return createPortal(<>
    <span ref={anchor} className={css.anchor} aria-hidden="true" style={{ left: point.x, top: point.y }} />
    <MenuSurface ref={toolbarRef} compact className={css.toolbar} role="toolbar" aria-label={t('highlightActions')}
      style={{ ...position, visibility: position === null ? 'hidden' : 'visible' }}>
      <Button size="sm" disabled={busy || !available} onClick={onRemove}>{t('highlightDelete')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('highlightDismiss')}</Button>
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
