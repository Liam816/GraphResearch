/** Session-scoped Agent content with paper-local and global conversation navigation. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { paperConversations } from './conversation-records.ts'
import { ConversationPicker } from './ConversationPicker.tsx'
import type { ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchAgentProps, ResearchWorkbenchProps } from './contract.ts'
import css from './Research.module.css'

function ConversationToolbar(props: ResearchAgentProps & { paper: ResearchPaper }) {
  const { paper, sessionId, t } = props
  const available = props.useResearch(value => value.catalog.capabilities?.paperConversations === true)
  const sessions = props.useSessions(value => value.byId)
  return <ConversationPicker entries={paperConversations(paper)} sessionId={sessionId} sessions={sessions}
    initialSessionId={paper.sessionId} available={available} t={t}
    create={() => props.createConversation(paper.id)} update={request => props.updateConversation({ ...request, paperId: paper.id })}
    open={(id) => { props.openConversation(paper.id, id) }} />
}

/**
 * Keep global history and creation available in the compact header, including an empty conversation.
 * @param props - research catalog, current main Session, and library navigation commands.
 * @returns the resident library conversation toolbar.
 */
export function LibraryConversationControls(props: ResearchWorkbenchProps & { sessionId: SessionId | undefined }) {
  const { catalog } = props.useResearch(value => value)
  const sessions = props.useSessions(value => value.byId)
  return <ConversationPicker entries={catalog.libraryConversations ?? []} sessionId={props.sessionId} sessions={sessions}
    available={catalog.capabilities?.libraryConversations === true} t={props.t} library
    fallbackTitle={props.sessionId === undefined || sessions[props.sessionId]?.blank === true
      ? undefined : sessions[props.sessionId]?.displayTitle}
    remove={id => props.deleteLibraryConversation({ sessionId: id })}
    deletionAvailable={catalog.capabilities?.libraryConversationDeletion === true}
    create={props.createLibraryConversation} update={props.updateLibraryConversation} open={props.openLibraryConversation} />
}

/** @param props - selected Session and shared paper metadata. @returns conversation controls and the existing Agent view. */
export function ResearchAgentPane(props: ResearchAgentProps) {
  const { paper, t, sessionId } = props
  const session = props.useSession(value => value)
  const active = props.useConversation(value => value.activeTargets.size > 0) ?? false
  const sessions = props.useSessions(value => value.byId)
  const libraryConversation = props.useResearch(value => value.catalog.libraryConversations?.find(item => item.sessionId === sessionId))
  const conversation = paper === undefined ? libraryConversation : paperConversations(paper).find(item => item.sessionId === sessionId)
  const otherRunning = paper === undefined ? undefined : paperConversations(paper).find(item =>
    item.sessionId !== sessionId && sessions[item.sessionId]?.running === true)
  const settling = sessionId !== undefined && session?.openState !== 'open' && session?.blank !== true
  const hero = sessionId === undefined || (session?.blank === true && !session.running && !active && !session.promptAttempted)
  return <div className={css.conversationPane}>
    {paper !== undefined && <ConversationToolbar {...props} paper={paper} />}
    {otherRunning !== undefined && <p className={css.conversationNotice} role="status">{t('conversationOtherRunning')}
      <Button size="sm" onClick={() => { if (paper !== undefined) props.openConversation(paper.id, otherRunning.sessionId) }}>{t('viewRunningConversation')}</Button></p>}
    {conversation?.archived === true ? <div className={css.allClosed}><p>{t('conversationIsArchived')}</p>
      <Button onClick={() => {
        const request = { sessionId: conversation.sessionId, archived: false }
        void (paper === undefined ? props.updateLibraryConversation(request)
          : props.updateConversation({ ...request, paperId: paper.id })).catch((_error: unknown) => {
          /* The command owner reports recovery through the research notice. */
        })
      }}>{t('restoreConversation')}</Button>
    </div> : props.renderFactorySlot('conversation.content', { variant: 'embedded', workspaceMode: 'managed', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero })}
  </div>
}
