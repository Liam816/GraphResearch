/** Research catalog records shared by the Host and browser. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of a research topic. */
export type ResearchTopicId = Branded<'ResearchTopicId'>
/** Stable identity of a paper, independent of its title and directory. */
export type ResearchPaperId = Branded<'ResearchPaperId'>
/** Editable notebook classification. */
export type ResearchNoteKind = 'ai' | 'learning'

/** One independently revisioned Markdown notebook. */
export interface ResearchNote {
  readonly text: string
  readonly revision: number
}

/** A topic with its own Agent session and execution workspace. */
export interface ResearchTopic {
  readonly id: ResearchTopicId
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** A paper with its own Agent session, original PDF and notebooks. */
export interface ResearchPaper {
  readonly id: ResearchPaperId
  readonly title: string
  readonly topicIds: readonly ResearchTopicId[]
  readonly sessionId: SessionId
  /** Local PDF path resolved using this paper's Session workspace. */
  readonly pdfPath: string
  readonly repositoryUrl: string
  readonly ai: ResearchNote
  readonly learning: ResearchNote
}

/** Complete durable research catalog; revisions order stream and command replies. */
export interface ResearchCatalog {
  readonly revision: number
  readonly topics: readonly ResearchTopic[]
  readonly papers: readonly ResearchPaper[]
}

/** Attach a newly created independent Session to a topic. */
export interface ResearchCreateTopicRequest {
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** Attach a newly created independent Session and a PDF to a paper. */
export interface ResearchCreatePaperRequest {
  readonly topicId: ResearchTopicId
  readonly title: string
  readonly sessionId: SessionId
  readonly pdfPath: string
  readonly repositoryUrl: string
}

/** Save one notebook only if its acknowledged revision is still current. */
export interface ResearchSaveNoteRequest {
  readonly paperId: ResearchPaperId
  readonly kind: ResearchNoteKind
  readonly text: string
  readonly expectedRevision: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Invalid title, PDF path, execution workspace or notebook revision. */
    'research/invalid': { readonly field: string }
    /** A selected paper or topic no longer exists. */
    'research/not-found': { readonly id: string }
    /** Another writer changed the notebook; the caller must retain its draft. */
    'research/note-conflict': { readonly paperId: ResearchPaperId; readonly kind: ResearchNoteKind; readonly revision: number }
  }
}
