/** Paper conversation ownership and independent backup locations. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchCatalog, ResearchConversation, ResearchPaper } from './research-types.ts'

/**
 * Resolve conversation metadata for current and legacy papers.
 * @param paper - current or legacy paper.
 * @returns its conversations, retaining the original Session as the first entry.
 */
export function paperConversations(paper: ResearchPaper): readonly ResearchConversation[] {
  return paper.conversations ?? [{ sessionId: paper.sessionId, title: '', pinned: false, archived: false, createdAt: 0,
    ...paper.progress === undefined ? {} : { progress: paper.progress } }]
}

/**
 * Find the paper owning a research conversation.
 * @param catalog - confirmed library.
 * @param sessionId - selected Session, if any.
 * @returns its owning paper.
 */
export function paperForSession(catalog: ResearchCatalog, sessionId: SessionId | undefined): ResearchPaper | undefined {
  return sessionId === undefined ? undefined
    : catalog.papers.find(paper => paperConversations(paper).some(item => item.sessionId === sessionId))
}

/**
 * Locate independent conversation backups beneath the paper directory.
 * @param paper - owning paper.
 * @param sessionId - one of its conversation identities.
 * @returns paper-relative snapshot components.
 */
export function conversationBackup(paper: ResearchPaper, sessionId: SessionId): readonly string[] {
  return sessionId === paper.sessionId ? ['session.json'] : ['sessions', `conversation-${encodeURIComponent(sessionId)}`, 'session.json']
}
