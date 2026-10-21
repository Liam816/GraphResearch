/** Paper-local sorting previews leave all reading bodies mounted until a drop commits the order. */
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { DragDropProvider, DragOverlay } from '@dnd-kit/react'
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { Accessibility, Feedback } from '@dnd-kit/dom'
import type { DragDropManagerInput } from '@dnd-kit/dom'
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable'
import { RestrictToWindow } from '@dnd-kit/dom/modifiers'
import {
  Button, Menu, Tooltip, ReferenceIconRegular, IconCloseOutlineRegular,
  IconChevronsUpDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconEllipsisOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaper, ResearchTranslation } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchWorkbenchProps } from './contract.ts'
import { isResearchPanel, reorderPanels, resolvePanelOrder } from './store.ts'
import type { PaperView, PanelPlacement, ResearchPanel } from './store.ts'
import { PaperFiles } from './Files.tsx'
import { PaperMarkdownStatus } from './MarkdownStatus.tsx'
import css from './Research.module.css'

type PanelSeats = Pick<ResearchWorkbenchProps, 't' | 'viewActions' | 'renderFactorySlot' | 'saveNote' | 'listFiles' | 'readFile' | 'saveFile' | 'refresh' | 'highlight' | 'extractMarkdown' | 'translate' | 'saveTranslation'>
interface PaperPanelsProps extends PanelSeats {
  paper: ResearchPaper
  revision: string
  highlightAvailable: boolean
  translationAvailable: boolean
  askTranslation: (translation: ResearchTranslation) => Promise<void>
  view: PaperView
  id: string
  phase: 'settling' | 'hero' | 'active'
  hero: boolean
}
interface DragPreview {
  source: ResearchPanel
  target: ResearchPanel | null
  placement: PanelPlacement
}


function previewFor(operation: DragEndEvent['operation'], order: readonly ResearchPanel[]): DragPreview | null {
  const source = operation.source?.id, target = operation.target?.id
  if (!isResearchPanel(source)) return null
  return {
    source,
    target: isResearchPanel(target) && target !== source ? target : null,
    placement: isResearchPanel(target) && order.indexOf(target) < order.indexOf(source) ? 'before' : 'after',
  }
}

/** One stable pane owns its drag handle, movement menu, and independently mounted reading body. */
function SortablePanel({ panel, order, preview, ...props }: PaperPanelsProps & {
  panel: ResearchPanel
  order: readonly ResearchPanel[]
  preview: DragPreview | null
  placePanel: ResearchWorkbenchProps['viewActions']['place']
}) {
  const { t, paper, view, viewActions: actions } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const index = order.indexOf(panel)
  const { sourceRef, targetRef, handleRef } = useSortable({
    id: panel, group: paper.id, index, type: 'research-panel', accept: 'research-panel',
    disabled: { draggable: !view.panels[panel] || order.filter(item => view.panels[item]).length < 2, droppable: !view.panels[panel] },
    plugins: [SortableKeyboardPlugin], transition: null,
  })
  const move = (direction: -1 | 1): void => {
    const target = order[index + direction]
    if (target !== undefined) props.placePanel(paper.id, panel, target, direction === -1 ? 'before' : 'after')
    setMenuOpen(false)
  }
  const heading = t(panel)
  return <section id={`${props.id}-${panel}`} className={css.panel}
    hidden={!view.panels[panel]} data-active={view.active === panel} data-research-panel={panel}
    data-drag-source={preview?.source === panel} data-drop-edge={preview?.target === panel ? preview.placement : undefined}
    style={{ '--dsh-paper-panel-width': view.widths[panel] } as CSSProperties} aria-label={heading}>
    <div className={css.panelHeader} ref={targetRef}>
      <div className={css.panelHeading} ref={sourceRef}>
        <Tooltip label={t('dragHandle', { panel: heading })} side="bottom" portal>
          <button type="button" ref={handleRef} className={css.dragHandle} aria-label={t('dragHandle', { panel: heading })}
            aria-roledescription={t('dragRole')} onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true) }}>
            <IconChevronsUpDownOutlineRegular size={14} className={css.dragHandleIcon} />
          </button>
        </Tooltip>
        <strong>{heading}</strong>
      </div>
      <div className={css.panelHeaderActions}>
        <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal dense autoFocus align="end"
          items={[
            { id: 'left', label: t('moveLeft'), icon: <IconChevronLeftOutlineRegular />, disabled: index === 0 },
            { id: 'right', label: t('moveRight'), icon: <IconChevronRightOutlineRegular />, disabled: index === order.length - 1 },
          ]} onSelect={(value) => { if (value === 'left') move(-1); else if (value === 'right') move(1) }}
          anchor={<Tooltip label={t('arrangePanel', { panel: heading })} side="bottom" portal>
            <button type="button" aria-label={t('arrangePanel', { panel: heading })} aria-haspopup="menu" aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(!menuOpen) }}><IconEllipsisOutlineRegular size={14} /></button>
          </Tooltip>} />
        <Tooltip label={t('collapse', { panel: heading })} side="bottom" portal>
          <button type="button" aria-label={t('collapse', { panel: heading })}
            onClick={() => { actions.panel(paper.id, panel) }}><IconCloseOutlineRegular size={14} /></button>
        </Tooltip>
      </div>
    </div>
    <div className={css.panelBody}>
      {panel === 'agent' ? props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: props.phase, hero: props.hero })
        : panel === 'pdf' ? paper.pdfPath === ''
          ? <div className={css.allClosed}><h2>{t('pdfMissing')}</h2><p>{t('pdfMissingHint')}</p></div>
          : <><PaperMarkdownStatus paper={paper} t={t} extractMarkdown={props.extractMarkdown} />
            {props.renderFactorySlot('document.pdf', { path: paper.pdfPath, viewKey: paper.id,
              ...props.translationAvailable ? { translation: {
                translate: (selection, signal) => props.translate({ ...selection, paperId: paper.id }, signal),
                save: result => props.saveTranslation(paper.id, result.key),
                ask: props.askTranslation,
              } } : {}, annotations: {
                available: props.highlightAvailable,
                highlights: paper.highlights ?? [],
                change: change => props.highlight({ paperId: paper.id, change }),
              } })}</>
          : <PaperFiles paper={paper} view={view} t={t} viewActions={actions} saveNote={props.saveNote} refresh={props.refresh}
            listFiles={props.listFiles} readFile={props.readFile} saveFile={props.saveFile}
            renderFactorySlot={props.renderFactorySlot} revision={props.revision} />}
    </div>
  </section>
}

/**
 * Render the ordered paper panels with cancellable drag previews and keyboard-accessible movement.
 * @param props - paper, persisted viewing preferences, and the existing reading factories.
 * @returns the mounted panel bodies, resize separators, and title-only drag overlay.
 */
export function ResearchPaperPanels(props: PaperPanelsProps) {
  const { paper, view, t, viewActions: actions } = props
  const order = resolvePanelOrder(view)
  const visible = order.filter(panel => view.panels[panel])
  const body = useRef<HTMLDivElement>(null)
  const resizeDrag = useRef<{ x: number; width: number }>()
  const scrollPositions = useRef<{ element: Element; top: number; left: number }[]>([])
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const placePanel: ResearchWorkbenchProps['viewActions']['place'] = (paperId, source, target, placement) => {
    // Moving an existing DOM subtree can reset its descendant scroll offsets.
    scrollPositions.current = Array.from(body.current?.querySelectorAll('*') ?? [], element => ({
      element, top: element.scrollTop, left: element.scrollLeft,
    })).filter(position => position.top !== 0 || position.left !== 0)
    actions.place(paperId, source, target, placement)
  }
  useLayoutEffect(() => {
    for (const { element, top, left } of scrollPositions.current) {
      element.scrollTop = top; element.scrollLeft = left
    }
    scrollPositions.current = []
  }, [order])
  const plugins = useMemo<NonNullable<DragDropManagerInput['plugins']>>(() => defaults => [
    ...defaults,
    Feedback.configure({ dropAnimation: null, keyboardTransition: null }),
    Accessibility.configure({
      screenReaderInstructions: { draggable: t('dragInstructions') },
      announcements: {
        dragstart: (event: DragStartEvent) => {
          const next = previewFor(event.operation, order)
          return next === null ? undefined : t('dragStart', { panel: t(next.source) })
        },
        dragover: (event: DragOverEvent) => {
          const next = previewFor(event.operation, order)
          return next?.target === null || next === null ? undefined
            : t(next.placement === 'before' ? 'dragBefore' : 'dragAfter', { panel: t(next.source), target: t(next.target) })
        },
        dragend: (event: DragEndEvent) => {
          if (event.canceled) return t('dragCanceled')
          const next = previewFor(event.operation, order)
          if (next === null || next.target === null) return undefined
          const moved = reorderPanels(order, next.source, next.target, next.placement)
          return t('dragSaved', { order: moved.map(panel => t(panel)).join(t('orderSeparator')) })
        },
      },
    }),
  ], [order, t])
  return <DragDropProvider plugins={plugins} modifiers={[RestrictToWindow]}
    onBeforeDragStart={(event) => { if ((body.current?.clientWidth ?? 0) <= 860) event.preventDefault() }}
    onDragStart={(event) => { setPreview(previewFor(event.operation, order)) }}
    onDragOver={(event) => { setPreview(previewFor(event.operation, order)) }}
    onDragEnd={(event) => {
      const next = previewFor(event.operation, order)
      setPreview(null)
      if (!event.canceled && next !== null && next.target !== null) placePanel(paper.id, next.source, next.target, next.placement)
    }}>
    <div className={css.panels} ref={body} data-panel-sorting={preview !== null}>
      {visible.length === 0 && <div className={css.allClosed}><h2>{t('hidden')}</h2><p>{t('hiddenHint')}</p>
        <Button onClick={() => { actions.reset(paper.id) }}>{t('reset')}</Button></div>}
      {order.map((panel) => {
        const next = visible[visible.indexOf(panel) + 1]
        return <Fragment key={panel}>
          <SortablePanel {...props} panel={panel} order={order} preview={preview} placePanel={placePanel} />
          {view.panels[panel] && next !== undefined && <div className={css.divider} role="separator" tabIndex={0} aria-orientation="vertical"
            aria-label={t('resize', { left: t(panel), right: t(next) })} aria-valuenow={Math.round(view.widths[panel])} aria-valuemin={12} aria-valuemax={88}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault(); actions.widths(paper.id, panel, next, event.key === 'ArrowLeft' ? -2 : 2)
              }
            }} onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              resizeDrag.current = { x: event.clientX, width: body.current?.clientWidth ?? 1 }
            }} onPointerMove={(event) => {
              if (resizeDrag.current === undefined || !event.currentTarget.hasPointerCapture(event.pointerId)) return
              const total = visible.reduce((sum, item) => sum + view.widths[item], 0)
              const delta = (event.clientX - resizeDrag.current.x) / resizeDrag.current.width * total
              actions.widths(paper.id, panel, next, delta); resizeDrag.current.x = event.clientX
            }} onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); resizeDrag.current = undefined }}
            onLostPointerCapture={() => { resizeDrag.current = undefined }} />}
        </Fragment>
      })}
    </div>
    <DragOverlay className={clsx(css.dragOverlay)} dropAnimation={null}>
      {preview !== null && <div className={css.dragGhost} aria-hidden="true">
        <ReferenceIconRegular kind={preview.source === 'agent' ? 'session' : 'file'} size={16} />
        <span>{t(preview.source)}</span>
      </div>}
    </DragOverlay>
  </DragDropProvider>
}
