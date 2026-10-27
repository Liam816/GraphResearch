/** Searchable conversation navigation shared by paper and global research Agents. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Button, Input, Menu, MenuSurface, Modal, Tooltip, focusWithoutRing, useAnchoredPosition, useDismissOnOutsidePointer,
  IconChevronDownOutlineRegular, IconPlusOutlineRegular, IconEllipsisOutlineRegular, IconEditOutlineRegular,
  IconPinFillRegular, IconArchiveOutlineRegular, IconUnarchiveOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResearchConversation, ResearchUpdateConversationRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchAgentProps } from './contract.ts'
import type { ResearchKey } from './locales.ts'
import css from './Research.module.css'

type ConversationChange = Omit<ResearchUpdateConversationRequest, 'paperId'>
interface ConversationPickerProps extends Pick<ResearchAgentProps, 't'> {
  entries: readonly ResearchConversation[]
  sessionId: SessionId | undefined
  sessions: SessionListState['byId']
  available: boolean
  initialSessionId?: SessionId
  fallbackTitle?: string | undefined
  library?: boolean
  create: () => Promise<void>
  update: (request: ConversationChange) => Promise<void>
  open: (id: SessionId) => void
  remove?: (id: SessionId) => Promise<void>
  deletionAvailable?: boolean
}

/** Shared paper and library conversation controls with searchable history and metadata actions.
 * @param props - independent conversation metadata and navigation commands.
 * @returns the current conversation picker, creation action, and history popup.
 */
export function ConversationPicker(props: ConversationPickerProps) {
  const { t, sessionId, entries, sessions, available, library = false } = props
  const current = entries.find(item => item.sessionId === sessionId)
  const title = (item: ResearchConversation): string => item.title
    || (library && sessions[item.sessionId]?.blank !== true ? sessions[item.sessionId]?.displayTitle : undefined)
    || t(item.sessionId === props.initialSessionId ? 'initialConversation' : 'newConversation')
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true), selectedSession = useRef(sessionId)
  selectedSession.current = sessionId
  const popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const popupId = useId()
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [archived, setArchived] = useState(false)
  const [actionsFor, setActionsFor] = useState<SessionId>()
  const [renaming, setRenaming] = useState<ResearchConversation>(), [name, setName] = useState('')
  const [deleting, setDeleting] = useState<ResearchConversation>(), [deleteFailure, setDeleteFailure] = useState<ResearchKey>()
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const position = useAnchoredPosition({ open, anchorRef: trigger, panelRef: popup, gap: 6, margin: 12 })
  useDismissOnOutsidePointer(root, open && actionsFor === undefined, setOpen, popup)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { if (open) search.current?.focus() }, [open])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || actionsFor !== undefined) return
      event.preventDefault(); setOpen(false)
      if (trigger.current !== null) focusWithoutRing(trigger.current)
    }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape) }
  }, [open, actionsFor])
  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setFailed(false)
    try { await operation(); return true }
    catch (_error: unknown) { setFailed(true); return false }
    finally { setBusy(false) }
  }
  const filtered = entries.filter(item => item.archived === archived
    && title(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || (sessions[b.sessionId]?.updatedAt ?? b.createdAt) - (sessions[a.sessionId]?.updatedAt ?? a.createdAt))
  const close = (): void => { setOpen(false); setActionsFor(undefined) }
  const saveName = (): void => {
    if (renaming === undefined || name.trim() === '') return
    void run(() => props.update({ sessionId: renaming.sessionId,
      title: name.trim(), expectedTitle: renaming.title })).then((saved) => { if (saved) setRenaming(undefined) })
  }
  const remove = (): void => {
    if (deleting === undefined || props.remove === undefined || busy) return
    const item = deleting, command = props.remove
    setDeleteFailure(undefined)
    void run(async () => {
      try { await command(item.sessionId); setDeleting(undefined) }
      catch (error: unknown) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        setDeleteFailure(code === 'research/conversation-delete-incomplete' ? 'conversationDeleteIncomplete'
          : code === 'research/conversation-busy' ? 'conversationDeleteBusy' : 'conversationDeleteFailed')
        throw error
      }
    })
  }
  return <div className={clsx(css.conversationControls, library && css.libraryConversationControls)} ref={root}>
    <div className={css.conversationToolbar}>
      <button ref={trigger} type="button" className={css.conversationPicker} aria-label={t('chooseConversation')}
        disabled={!available} aria-haspopup="dialog" aria-expanded={open} aria-controls={popupId} onClick={() => { setQuery(''); setOpen(value => !value) }}>
        <span>{current === undefined ? props.fallbackTitle || t('newConversation') : title(current)}</span><IconChevronDownOutlineRegular size={14} />
      </button>
      <Tooltip label={t(available ? 'newConversation' : 'conversationBackendRestart')} portal side="bottom"><Button size="sm" className={css.newConversation}
        disabled={busy || !available} aria-label={t('newConversation')} icon={<IconPlusOutlineRegular size={14} />}
        onClick={() => { void run(() => props.create()) }}><span>{t('newConversation')}</span></Button></Tooltip>
    </div>
    {!available && !library && <p className={css.conversationNotice} role="status">{t('conversationBackendRestart')}</p>}
    {failed && renaming === undefined && !library && <p className={css.conversationNotice} role="alert">{t('conversationUpdateFailed')}</p>}
    {open && createPortal(<MenuSurface ref={popup} id={popupId} role="dialog" aria-label={t(library ? 'libraryConversations' : 'paperConversations')}
      className={css.conversationPopup} data-library-conversations={library || undefined} style={position === null ? { visibility: 'hidden', left: 0, top: 0 } : position}>
      <Input ref={search} aria-label={t(library ? 'searchLibraryConversations' : 'searchConversations')} placeholder={t(library ? 'searchLibraryConversations' : 'searchConversations')} value={query}
        onChange={(event) => { setQuery(event.target.value) }} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
            event.preventDefault(); popup.current?.querySelector<HTMLButtonElement>('[data-conversation-option]')?.focus()
          }
        }} />
      <div className={css.conversationList} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute('data-conversation-option')) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-conversation-option]')]
        const index = options.indexOf(event.target)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        options[next]?.focus()
      }}>
        {filtered.length === 0 && <p className={css.hint}>{t('noConversations')}</p>}
        {filtered.map((item, index) => <div key={item.sessionId}>
          {(index === 0 || filtered[index - 1]?.pinned !== item.pinned) && <p className={css.conversationGroup}>
            {t(item.pinned ? 'pinnedConversations' : archived ? 'archivedConversations' : 'recentConversations')}</p>}
          <div className={css.conversationRow} data-dsh-action-row="">
            <button type="button" data-conversation-option data-dsh-action-label="" aria-current={item.sessionId === sessionId ? 'page' : undefined}
              className={css.conversationOption} onClick={() => {
                close()
                if (item.archived) void run(async () => {
                  await props.update({ sessionId: item.sessionId, archived: false })
                  if (mounted.current && selectedSession.current === sessionId) props.open(item.sessionId)
                })
                else props.open(item.sessionId)
              }}>
              <span>{title(item)}</span>
              {item.pinned && <IconPinFillRegular size={12} />}
              <small>{sessions[item.sessionId]?.running === true ? t('conversationRunning') : item.archived ? t('restoreAndOpen') : item.sessionId === sessionId ? t('currentConversation') : ''}</small>
            </button>
            <Menu open={actionsFor === item.sessionId} portal align="end" autoFocus dense
              onClose={() => { close() }} items={[
                { id: 'rename', label: t('renameConversation'), icon: <IconEditOutlineRegular size={14} /> },
                { id: 'pin', label: t(item.pinned ? 'unpinConversation' : 'pinConversation'), icon: <IconPinFillRegular size={14} /> },
                { id: 'archive', label: t(item.archived ? 'restoreConversation' : 'archiveConversation'),
                  icon: item.archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />,
                  disabled: sessions[item.sessionId]?.running === true },
                ...library && props.remove !== undefined ? [
                  { id: 'delete-separator', type: 'separator' as const },
                  { id: 'delete', label: t('deleteConversation'), icon: <IconTrashOutlineRegular size={14} />, danger: true,
                    disabled: props.deletionAvailable !== true || sessions[item.sessionId]?.running === true },
                ] : [],
              ]} onSelect={(id) => {
                close()
                if (id === 'rename') { setRenaming(item); setName(title(item)); setFailed(false) }
                else if (id === 'delete') { setDeleting(item); setDeleteFailure(undefined) }
                else void run(() => props.update({ sessionId: item.sessionId,
                  ...id === 'pin' ? { pinned: !item.pinned } : { archived: !item.archived } }))
              }} anchor={<button type="button" className={css.conversationMore} data-dsh-action-menu="" disabled={busy}
                aria-haspopup="menu" aria-expanded={actionsFor === item.sessionId}
                aria-label={t('conversationActions', { title: title(item) })}
                onClick={() => { setActionsFor(item.sessionId) }}><IconEllipsisOutlineRegular size={16} /></button>} />
          </div>
        </div>)}
      </div>
      <button type="button" className={css.conversationArchiveFilter} aria-pressed={archived}
        onClick={() => { setArchived(value => !value) }}>{t(archived ? 'showActiveConversations' : 'showArchivedConversations')}</button>
    </MenuSurface>, document.body)}
    <Modal open={renaming !== undefined} title={t('renameConversation')} closeLabel={t('close')}
      onClose={() => { if (!busy) setRenaming(undefined) }} footer={<>
        <Button disabled={busy} onClick={() => { setRenaming(undefined) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || name.trim() === ''} onClick={saveName}>
          {t(busy ? 'saving' : 'saveConversationName')}</Button>
      </>}>
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); saveName() }}>
        <label>{t('conversationName')}<Input data-modal-autofocus value={name}
          onChange={(event) => { setName(event.target.value) }} /></label>
        {failed && <p role="alert" className={css.hint}>{t('conversationUpdateFailed')}</p>}
      </form>
    </Modal>
    <Modal open={deleting !== undefined} title={t('deleteConversation')} closeLabel={t('close')}
      {...deleting === undefined ? {} : { description: t('deleteConversationWarning', { title: title(deleting) }) }}
      onClose={() => { if (!busy) setDeleting(undefined) }} footer={<>
        <Button data-modal-autofocus disabled={busy} onClick={() => { setDeleting(undefined) }}>{t('cancel')}</Button>
        <Button className={css.deleteConfirm} icon={<IconTrashOutlineRegular size={14} />}
          disabled={busy || (deleting !== undefined && sessions[deleting.sessionId]?.running === true)} onClick={remove}>
          {t(busy ? 'deletingPaper' : 'deleteConversation')}</Button>
      </>}>
      {deleteFailure !== undefined && <p role="alert">{t(deleteFailure)}</p>}
    </Modal>
  </div>
}
