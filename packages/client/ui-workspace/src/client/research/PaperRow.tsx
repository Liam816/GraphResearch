/** Paper navigation with delayed overflow reveal and an accessible action menu. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { IconChevronsUpDownOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconEllipsisOutlineRegular, IconTrashOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import { useTitleMarquee } from '../title-marquee.ts'
import css from './Research.module.css'

/** @param props - paper, selection, localized copy, and navigation/deletion callbacks. @returns one paper directory row. */
export function ResearchPaperRow({ paper, selected, t, onOpen, onDelete, sorting }: {
  paper: ResearchPaper
  selected: boolean
  t: ResearchSeats['t']
  onOpen: () => void
  onDelete: () => void
  sorting?: {
    rowRef: Ref<HTMLLIElement>
    handleRef: Ref<HTMLButtonElement>
    disabled: boolean
    active: boolean
    edge: 'before' | 'after' | undefined
    up: (() => void) | undefined
    down: (() => void) | undefined
  }
}) {
  const title = useRef<HTMLSpanElement>(null)
  const marquee = useTitleMarquee(title, 500, true)
  const [menuOpen, setMenuOpen] = useState(false)
  useLayoutEffect(() => {
    const element = title.current
    if (element === null) return
    const measure = (): void => { element.toggleAttribute('data-overflow', element.scrollWidth > element.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => { observer?.disconnect() }
  }, [paper.title])
  const menuLabel = t('paperActions', { title: paper.title })
  return <li ref={sorting?.rowRef} data-dsh-action-row="" className={`${css.treeRow} ${css.paperRow}`}
    data-research-paper={paper.id} data-sortable={sorting !== undefined || undefined}
    data-drag-source={sorting?.active || undefined} data-drop-edge={sorting?.edge} data-menu-open={menuOpen || undefined}>
    {sorting !== undefined && <Tooltip label={t('paperDragHandle', { title: paper.title })} portal side="right">
      <button ref={sorting.handleRef} type="button" className={css.paperGrip} disabled={sorting.disabled}
        aria-label={t('paperDragHandle', { title: paper.title })} aria-roledescription={t('paperDragRole')}>
        <IconChevronsUpDownOutlineRegular size={14} />
      </button>
    </Tooltip>}
    <button type="button" className={css.treeTitle} data-dsh-action-label="" aria-current={selected ? 'page' : undefined} onClick={onOpen}
      onPointerEnter={marquee.enter} onPointerLeave={marquee.leave} onFocus={marquee.enter} onBlur={marquee.leave}>
      <span ref={title} className={css.paperTitle}>{paper.title}</span>
    </button>
    <span className={css.paperActions}>
      <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal autoFocus closeOnPointerLeave align="end" dense
        items={[
          ...sorting === undefined ? [] : [
            { id: 'up', label: t('paperMoveUp'), icon: <IconChevronUpOutlineRegular size={16} />, disabled: sorting.up === undefined },
            { id: 'down', label: t('paperMoveDown'), icon: <IconChevronDownOutlineRegular size={16} />, disabled: sorting.down === undefined },
            { id: 'sort-separator', type: 'separator' as const },
          ],
          { id: 'delete', label: t('deletePaper'), icon: <IconTrashOutlineRegular size={16} />, danger: true },
        ]}
        onSelect={(id) => { setMenuOpen(false); marquee.leave(); if (id === 'up') sorting?.up?.(); else if (id === 'down') sorting?.down?.(); else if (id === 'delete') onDelete() }}
        anchor={<Tooltip label={menuLabel} portal side="right"><button type="button" className={css.paperMore} data-dsh-action-menu=""
          aria-label={menuLabel} aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => { setMenuOpen(value => !value) }}><IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
    </span>
  </li>
}
