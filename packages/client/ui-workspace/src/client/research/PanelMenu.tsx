/** Shared Agent reference actions and paper-panel arrangement menu. */
import {
  Menu, Tooltip, ReferenceIconRegular, IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular, IconEllipsisOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchSeats } from './contract.ts'
import type { ResearchPanel } from './store.ts'

/**
 * Keep paper references in the Agent menu while retaining panel movement actions.
 * @param props - controlled menu state, optional references and available movement directions.
 * @returns an anchored, keyboard-accessible actions menu.
 */
export function ResearchPanelMenu({ panel, t, open, setOpen, onReference, movement }: Pick<ResearchSeats, 't'> & {
  panel: ResearchPanel
  open: boolean
  setOpen: (open: boolean) => void
  onReference: (() => void) | undefined
  movement?: { left: (() => void) | undefined; right: (() => void) | undefined }
}) {
  const references = panel === 'agent' && onReference !== undefined
  if (!references && movement === undefined) return null
  const label = t(panel === 'agent' ? 'panelActions' : 'arrangePanel', { panel: t(panel) })
  return <Menu open={open} onClose={() => { setOpen(false) }} portal dense autoFocus align="end"
    items={[
      ...references ? [{ id: 'reference', label: t('context'), icon: <ReferenceIconRegular kind="session" size={16} /> }] : [],
      ...references && movement !== undefined ? [{ id: 'movement-separator', type: 'separator' as const }] : [],
      ...movement === undefined ? [] : [
        { id: 'left', label: t('moveLeft'), icon: <IconChevronLeftOutlineRegular />, disabled: movement.left === undefined },
        { id: 'right', label: t('moveRight'), icon: <IconChevronRightOutlineRegular />, disabled: movement.right === undefined },
      ],
    ]} onSelect={(value) => {
      setOpen(false)
      if (value === 'reference') onReference?.()
      else if (value === 'left') movement?.left?.()
      else if (value === 'right') movement?.right?.()
    }}
    anchor={<Tooltip label={label} side="bottom" portal>
      <button type="button" data-dsh-action-menu="" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open) }}><IconEllipsisOutlineRegular size={14} /></button>
    </Tooltip>} />
}
