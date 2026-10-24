/** Client projections of current and legacy paper conversations. */
import type { ResearchCatalog, ResearchConversation, ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Include the original conversation for libraries written before multi-conversation support.
 * @param paper - confirmed paper metadata.
 * @returns saved conversations or the original reading conversation.
 */
export function paperConversations(paper: ResearchPaper): readonly ResearchConversation[] {
  if (paper.conversations !== undefined) return paper.conversations
  return [{ sessionId: paper.sessionId, title: '', pinned: false, archived: false, createdAt: 0 }]
}

/**
 * Resolve paper navigation from any of its conversations.
 * @param catalog - confirmed research library.
 * @param sessionId - current navigation selection.
 * @returns owning paper, when a paper conversation is selected.
 */
export function paperForSession(catalog: ResearchCatalog, sessionId: SessionId | undefined): ResearchPaper | undefined {
  return catalog.papers.find(paper => paper.sessionId === sessionId || paper.conversations?.some(item => item.sessionId === sessionId))
}
