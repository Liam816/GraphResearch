/** Responsive file divider preserves separate proportions without remounting the reading surfaces. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import { DEFAULT_FILE_SPLIT, FILE_SPLIT_LIMITS } from './store.ts'
import type { FileSplitAxis, PaperFileView } from './store.ts'
import css from './Files.module.css'

interface FileDrag {
  pointer: number
  axis: FileSplitAxis
  origin: number
  extent: number
  percent: number
}

function layoutAxis(node: HTMLElement): FileSplitAxis {
  return node.parentElement !== null && getComputedStyle(node.parentElement).flexDirection === 'row' ? 'columns' : 'rows'
}

/**
 * Resize the explorer along its CSS layout's current axis.
 * @param props - paper identity, saved proportions, and local view actions.
 * @returns a pointer- and keyboard-adjustable separator.
 */
export function PaperFileDivider({ paperId, split, collapsed, actions, t }: Pick<ResearchSeats, 'actions' | 't'> & {
  paperId: ResearchPaperId
  split: PaperFileView['split']
  collapsed: boolean
}) {
  const node = useRef<HTMLDivElement>(null)
  const drag = useRef<FileDrag>()
  const [axis, setAxis] = useState<FileSplitAxis>('rows')
  const [resizing, setResizing] = useState(false)
  const percent = split?.[axis] ?? DEFAULT_FILE_SPLIT[axis]
  const finish = (cancel = false): void => {
    const current = drag.current
    drag.current = undefined
    setResizing(false)
    if (current === undefined) return
    if (cancel) actions.fileSplit(paperId, current.axis, current.percent)
    if (node.current?.hasPointerCapture(current.pointer) === true) node.current.releasePointerCapture(current.pointer)
  }
  useLayoutEffect(() => {
    const current = node.current
    const parent = current?.parentElement
    if (current === null || parent === null || parent === undefined) return
    const measure = (): void => { setAxis(layoutAxis(current)) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(parent)
    return () => { observer?.disconnect() }
  }, [collapsed])
  useLayoutEffect(() => {
    const current = drag.current
    if (current !== undefined && (collapsed || current.axis !== axis)) finish(true)
  }, [axis, collapsed])
  return <div ref={node} className={css.splitter} role="separator" tabIndex={0} hidden={collapsed}
    aria-label={t('resizeFiles')} title={t('resizeFilesHint')} aria-orientation={axis === 'columns' ? 'vertical' : 'horizontal'}
    aria-valuenow={Math.round(percent)} aria-valuemin={FILE_SPLIT_LIMITS.min} aria-valuemax={FILE_SPLIT_LIMITS.max}
    aria-valuetext={t('filesDirectoryShare', { percent: Math.round(percent) })} data-resizing={resizing}
    onPointerDown={(event) => {
      if (event.button !== 0 || event.isPrimary === false || drag.current !== undefined
        || event.currentTarget.parentElement === null) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      const direction = layoutAxis(event.currentTarget)
      const bounds = event.currentTarget.parentElement.getBoundingClientRect()
      const divider = event.currentTarget.getBoundingClientRect()
      const extent = direction === 'columns' ? bounds.width - divider.width : bounds.height - divider.height
      if (extent <= 0) return
      drag.current = { pointer: event.pointerId, axis: direction, origin: direction === 'columns' ? event.clientX : event.clientY,
        extent, percent: split?.[direction] ?? DEFAULT_FILE_SPLIT[direction] }
      event.currentTarget.setPointerCapture(event.pointerId)
      setResizing(true)
    }}
    onPointerMove={(event) => {
      const current = drag.current
      if (current === undefined || current.pointer !== event.pointerId) return
      if (layoutAxis(event.currentTarget) !== current.axis) { finish(true); return }
      const coordinate = current.axis === 'columns' ? event.clientX : event.clientY
      actions.fileSplit(paperId, current.axis, current.percent + (coordinate - current.origin) / current.extent * 100)
    }}
    onPointerUp={() => { finish() }} onPointerCancel={() => { finish(true) }} onLostPointerCapture={() => { finish(true) }}
    onDoubleClick={() => { actions.fileSplit(paperId, axis, DEFAULT_FILE_SPLIT[axis]) }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && drag.current !== undefined) { event.preventDefault(); finish(true); return }
      const previous = axis === 'columns' ? 'ArrowLeft' : 'ArrowUp'
      const next = axis === 'columns' ? 'ArrowRight' : 'ArrowDown'
      if (![previous, next, 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      actions.fileSplit(paperId, axis, event.key === 'Home' ? FILE_SPLIT_LIMITS.min : event.key === 'End' ? FILE_SPLIT_LIMITS.max
        : percent + (event.key === previous ? -2 : 2))
    }} />
}
