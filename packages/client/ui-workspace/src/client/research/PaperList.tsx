/** Topic-local drag previews commit through the shared, conflict-checked catalog command. */
import { useCallback, useMemo, useRef, useState } from 'react'
import { DragDropProvider, DragOverlay } from '@dnd-kit/react'
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { Accessibility, Feedback, PointerSensor, PointerActivationConstraints } from '@dnd-kit/dom'
import type { DragDropManagerInput } from '@dnd-kit/dom'
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable'
import { RestrictToWindow } from '@dnd-kit/dom/modifiers'
import type { ResearchPaper, ResearchPaperId, ResearchTopicId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import { ResearchPaperRow } from './PaperRow.tsx'
import css from './Research.module.css'

interface PaperListProps extends Pick<ResearchSeats, 't' | 'reorderPapers'> {
  topicId: ResearchTopicId
  papers: readonly ResearchPaper[]
  selectedId: ResearchPaperId | undefined
  filtered: boolean
  onOpen: (paper: ResearchPaper) => void
  onDelete: (paper: ResearchPaper) => void
}
interface Preview { source: ResearchPaperId; target: ResearchPaperId; edge: 'before' | 'after' }

function previewFor(operation: DragEndEvent['operation'], papers: readonly ResearchPaper[]): Preview | null {
  const source = papers.find(paper => paper.id === operation.source?.id)
  const target = papers.find(paper => paper.id === operation.target?.id)
  return source === undefined || target === undefined || source === target ? null
    : { source: source.id, target: target.id, edge: papers.indexOf(target) < papers.indexOf(source) ? 'before' : 'after' }
}

function SortablePaper({ paper, index, busy, preview, move, ...props }: PaperListProps & {
  paper: ResearchPaper
  index: number
  busy: boolean
  preview: Preview | null
  move: (source: ResearchPaperId, target: ResearchPaperId, edge: 'before' | 'after') => Promise<void>
}) {
  const disabled = busy || props.filtered || props.papers.length < 2
  const { sourceRef, targetRef, handleRef } = useSortable({
    id: paper.id, index, group: props.topicId, type: 'research-paper', accept: 'research-paper',
    disabled, plugins: [SortableKeyboardPlugin], transition: null,
  })
  const rowRef = useCallback((element: HTMLLIElement | null) => {
    sourceRef(element); targetRef(element)
  }, [sourceRef, targetRef])
  const previous = props.papers[index - 1], next = props.papers[index + 1]
  return <ResearchPaperRow paper={paper} selected={paper.id === props.selectedId} t={props.t}
    onOpen={() => { props.onOpen(paper) }} onDelete={() => { props.onDelete(paper) }} sorting={{
      rowRef, handleRef, disabled,
      active: preview?.source === paper.id,
      edge: preview?.target === paper.id ? preview.edge : undefined,
      up: previous === undefined || disabled ? undefined : () => { void move(paper.id, previous.id, 'before') },
      down: next === undefined || disabled ? undefined : () => { void move(paper.id, next.id, 'after') },
    }} />
}

/**
 * Keep ordering within this Topic, preserving selection and filenames while saving.
 * @param props - complete visible membership and the shared reorder command; filtering disables movement.
 * @returns sortable paper rows with keyboard controls, live announcements and a title-only overlay.
 */
export function ResearchPaperList(props: PaperListProps) {
  const { papers, t } = props
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const dragPapers = useRef(papers)
  const move = async (source: ResearchPaperId, target: ResearchPaperId, edge: 'before' | 'after', observed = papers): Promise<void> => {
    const order = observed.map(paper => paper.id)
    const next = order.filter(id => id !== source)
    next.splice(next.indexOf(target) + (edge === 'after' ? 1 : 0), 0, source)
    if (next.every((id, index) => id === order[index])) return
    setBusy(true)
    try { await props.reorderPapers({ topicId: props.topicId, paperIds: next, expectedPaperIds: order }) }
    catch (error: unknown) { console.error('Research paper reorder failed:', error) }
    finally { setBusy(false) }
  }
  const plugins = useMemo<NonNullable<DragDropManagerInput['plugins']>>(() => defaults => [
    ...defaults, Feedback.configure({ dropAnimation: null, keyboardTransition: null }),
    Accessibility.configure({
      screenReaderInstructions: { draggable: t('paperDragInstructions') },
      announcements: {
        dragstart: (event: DragStartEvent) => t('paperDragStart', { title: papers.find(paper => paper.id === event.operation.source?.id)?.title ?? '' }),
        dragover: (event: DragOverEvent) => {
          const next = previewFor(event.operation, papers)
          return next === null ? undefined : t(next.edge === 'before' ? 'paperDragBefore' : 'paperDragAfter', {
            title: papers.find(paper => paper.id === next.target)?.title ?? '',
          })
        },
        dragend: (event: DragEndEvent) => t(event.canceled || previewFor(event.operation, papers) === null ? 'dragCanceled' : 'paperOrderSaving'),
      },
    }),
  ], [papers, t])
  return <DragDropProvider plugins={plugins} modifiers={[RestrictToWindow]}
    sensors={defaults => [...defaults.filter(sensor => sensor !== PointerSensor), PointerSensor.configure({
      activationConstraints: event => event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
    })]}
    onDragStart={() => { dragPapers.current = papers }}
    onDragOver={(event) => { setPreview(previewFor(event.operation, dragPapers.current)) }}
    onDragEnd={(event) => {
      const next = previewFor(event.operation, dragPapers.current)
      setPreview(null)
      if (!event.canceled && next !== null) void move(next.source, next.target, next.edge, dragPapers.current)
    }}>
    <ul className={css.children} aria-busy={busy} data-paper-sorting={preview !== null}>
      {papers.map((paper, index) => <SortablePaper key={paper.id} {...props} paper={paper} index={index}
        busy={busy} preview={preview} move={move} />)}
    </ul>
    <DragOverlay>{(source) => {
      const paper = papers.find(item => item.id === source.id)
      return paper === undefined ? null : <div className={css.paperDragOverlay}>{paper.title}</div>
    }}</DragOverlay>
  </DragDropProvider>
}
