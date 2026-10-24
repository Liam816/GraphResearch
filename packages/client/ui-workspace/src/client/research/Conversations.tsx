/** Paper-local conversation navigation inside a Session-scoped Agent pane. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, Input, Menu, MenuSurface, Modal, Tooltip, focusWithoutRing, useAnchoredPosition, useDismissOnOutsidePointer,
  IconChevronDownOutlineRegular, IconPlusOutlineRegular, IconEllipsisOutlineRegular, IconEditOutlineRegular,
  IconPinFillRegular, IconArchiveOutlineRegular, IconUnarchiveOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { paperConversations } from './conversation-records.ts'
import type { ResearchConversation, ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchAgentProps } from './contract.ts'
import css from './Research.module.css'

type ToolbarProps = ResearchAgentProps & { paper: ResearchPaper }

function conversationTitle(item: ResearchConversation, paper: ResearchPaper, t: ResearchAgentProps['t']): string {
  return item.title || t(item.sessionId === paper.sessionId ? 'initialConversation' : 'newConversation')
}

function ConversationToolbar(props: ToolbarProps) {
  const { paper, t, sessionId } = props
  const available = props.useResearch(value => value.catalog.capabilities?.paperConversations === true)
  const entries = paperConversations(paper)
  const current = entries.find(item => item.sessionId === sessionId)
  const sessions = props.useSessions(value => value.byId)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const popupId = useId()
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [archived, setArchived] = useState(false)
  const [actionsFor, setActionsFor] = useState<SessionId>()
  const [renaming, setRenaming] = useState<ResearchConversation>(), [name, setName] = useState('')
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const position = useAnchoredPosition({ open, anchorRef: trigger, panelRef: popup, gap: 6, margin: 12 })
  useDismissOnOutsidePointer(root, open && actionsFor === undefined, setOpen, popup)
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
    && conversationTitle(item, paper, t).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  const close = (): void => { setOpen(false); setActionsFor(undefined) }
  const saveName = (): void => {
    if (renaming === undefined || name.trim() === '') return
    void run(() => props.updateConversation({ paperId: paper.id, sessionId: renaming.sessionId,
      title: name.trim(), expectedTitle: renaming.title })).then((saved) => { if (saved) setRenaming(undefined) })
  }
  return <div className={css.conversationControls} ref={root}>
    <div className={css.conversationToolbar}>
      <button ref={trigger} type="button" className={css.conversationPicker} aria-label={t('chooseConversation')}
        disabled={!available} aria-haspopup="dialog" aria-expanded={open} aria-controls={popupId} onClick={() => { setQuery(''); setOpen(value => !value) }}>
        <span>{current === undefined ? t('chooseConversation') : conversationTitle(current, paper, t)}</span><IconChevronDownOutlineRegular size={14} />
      </button>
      <Tooltip label={t(available ? 'newConversation' : 'conversationBackendRestart')} portal side="bottom"><Button size="sm" className={css.newConversation}
        disabled={busy || !available} aria-label={t('newConversation')} icon={<IconPlusOutlineRegular size={14} />}
        onClick={() => { void run(() => props.createConversation(paper.id)) }}><span>{t('newConversation')}</span></Button></Tooltip>
    </div>
    {!available && <p className={css.conversationNotice} role="status">{t('conversationBackendRestart')}</p>}
    {failed && renaming === undefined && <p className={css.conversationNotice} role="alert">{t('conversationUpdateFailed')}</p>}
    {open && createPortal(<MenuSurface ref={popup} id={popupId} role="dialog" aria-label={t('paperConversations')}
      className={css.conversationPopup} style={position === null ? { visibility: 'hidden', left: 0, top: 0 } : position}>
      <Input ref={search} aria-label={t('searchConversations')} placeholder={t('searchConversations')} value={query}
        onChange={(event) => { setQuery(event.target.value) }} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
            event.preventDefault(); popup.current?.querySelector<HTMLButtonElement>('[data-conversation-option]')?.focus()
          }
        }} />
      <div className={css.conversationList}>
        {filtered.length === 0 && <p className={css.hint}>{t('noConversations')}</p>}
        {filtered.map((item, index) => <div key={item.sessionId}>
          {(index === 0 || filtered[index - 1]?.pinned !== item.pinned) && <p className={css.conversationGroup}>
            {t(item.pinned ? 'pinnedConversations' : archived ? 'archivedConversations' : 'recentConversations')}</p>}
          <div className={css.conversationRow}>
            <button type="button" data-conversation-option aria-current={item.sessionId === sessionId ? 'page' : undefined}
              className={css.conversationOption} onClick={() => {
                close()
                if (item.archived) void run(async () => {
                  await props.updateConversation({ paperId: paper.id, sessionId: item.sessionId, archived: false })
                  props.openConversation(paper.id, item.sessionId)
                })
                else props.openConversation(paper.id, item.sessionId)
              }}>
              <span>{conversationTitle(item, paper, t)}</span>
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
              ]} onSelect={(id) => {
                close()
                if (id === 'rename') { setRenaming(item); setName(conversationTitle(item, paper, t)); setFailed(false) }
                else void run(() => props.updateConversation({ paperId: paper.id, sessionId: item.sessionId,
                  ...id === 'pin' ? { pinned: !item.pinned } : { archived: !item.archived } }))
              }} anchor={<button type="button" className={css.conversationMore} disabled={busy}
                aria-label={t('conversationActions', { title: conversationTitle(item, paper, t) })}
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
  </div>
}

/** @param props - selected Session and shared paper metadata. @returns conversation controls and the existing Agent view. */
export function ResearchAgentPane(props: ResearchAgentProps) {
  const { paper, t, sessionId } = props
  const session = props.useSession(value => value)
  const active = props.useConversation(value => value.activeTargets.size > 0) ?? false
  const sessions = props.useSessions(value => value.byId)
  const conversation = paper === undefined ? undefined : paperConversations(paper).find(item => item.sessionId === sessionId)
  const otherRunning = paper === undefined ? undefined : paperConversations(paper).find(item =>
    item.sessionId !== sessionId && sessions[item.sessionId]?.running === true)
  const settling = sessionId !== undefined && session?.openState !== 'open' && session?.blank !== true
  const hero = sessionId === undefined || (session?.blank === true && !session.running && !active && !session.promptAttempted)
  return <div className={css.conversationPane}>
    {paper !== undefined && <ConversationToolbar {...props} paper={paper} />}
    {otherRunning !== undefined && <p className={css.conversationNotice} role="status">{t('conversationOtherRunning')}
      <Button size="sm" onClick={() => { if (paper !== undefined) props.openConversation(paper.id, otherRunning.sessionId) }}>{t('viewRunningConversation')}</Button></p>}
    {conversation?.archived === true && paper !== undefined ? <div className={css.allClosed}><p>{t('conversationIsArchived')}</p>
      <Button onClick={() => { void props.updateConversation({ paperId: paper.id, sessionId: conversation.sessionId, archived: false }).catch((_error: unknown) => { /* The command owner reports recovery through the research notice. */ }) }}>{t('restoreConversation')}</Button>
    </div> : props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero })}
  </div>
}
