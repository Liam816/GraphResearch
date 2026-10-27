/** Research catalog records shared by the Host and browser. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of a research topic. */
export type ResearchTopicId = Branded<'ResearchTopicId'>
/** Stable identity of a paper, independent of its title and directory. */
export type ResearchPaperId = Branded<'ResearchPaperId'>
/** Stable identity of one text selection, including selections spanning several pages. */
export type ResearchHighlightId = Branded<'ResearchHighlightId'>
/** Named marker colors, rendered against the original PDF page. */
export type ResearchHighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange'

/** A selected text rectangle relative to its displayed page, independent of zoom. */
export interface ResearchHighlightRect {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Persisted text selection; coordinates are fractions of the original page dimensions. */
export interface ResearchHighlight {
  readonly id: ResearchHighlightId
  readonly color: ResearchHighlightColor
  readonly text: string
  readonly rects: readonly ResearchHighlightRect[]
}

/** Idempotent additions and removals preserve other readers' highlights. */
export interface ResearchHighlightRequest {
  readonly paperId: ResearchPaperId
  readonly change: { readonly type: 'add'; readonly highlight: ResearchHighlight }
    | { readonly type: 'remove'; readonly id: ResearchHighlightId }
}
/** Editable notebook classification. */
export type ResearchNoteKind = 'ai' | 'learning'

/** One independently revisioned Markdown notebook. */
export interface ResearchNote {
  readonly text: string
  readonly revision: number
}

/** Complete automatic PDF extraction, or a retained failure that can be explicitly retried. */
export type ResearchMarkdown =
  | { readonly status: 'ready'; readonly sourceSha256: string; readonly path: string; readonly pages: number; readonly backend: 'pdfjs' | 'pdftotext' }
  | { readonly status: 'failed'; readonly sourceSha256?: string | undefined; readonly code: ResearchMarkdownFailure }

/** Stable extraction failures; the original PDF and notebooks remain available. */
export type ResearchMarkdownFailure = 'no-text' | 'text-limit' | 'timeout' | 'conversion-failed' | 'source-changed' | 'output-conflict'

/** A topic with its own Agent session and execution workspace. */
export interface ResearchTopic {
  readonly id: ResearchTopicId
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  /** Topic-local reading order; absent legacy entries retain catalog creation order. */
  readonly paperOrder?: readonly ResearchPaperId[] | undefined
  /** Browser projection of the topic's Markdown summary. */
  readonly notes?: ResearchNote | undefined
}

/** Independent conversation metadata; library or paper resources remain shared. */
export interface ResearchConversation {
  readonly sessionId: SessionId
  /** Empty until the first question supplies a default name. */
  readonly title: string
  readonly pinned: boolean
  readonly archived: boolean
  readonly createdAt: number
  readonly progress?: string | undefined
}

/** Attach a fresh, unseeded Session to an existing paper; retry with the same Session is idempotent. */
export interface ResearchCreateConversationRequest {
  readonly paperId: ResearchPaperId
  readonly sessionId: SessionId
}

/** Change conversation metadata without replacing its transcript or paper files. */
export interface ResearchUpdateConversationRequest extends ResearchCreateConversationRequest {
  readonly title?: string
  readonly expectedTitle?: string
  readonly pinned?: boolean
  readonly archived?: boolean
}

/** Register a fresh or existing top-level main Session once, retaining its transcript. */
export interface ResearchCreateLibraryConversationRequest {
  readonly sessionId: SessionId
  /** Last confirmed library root; a library switch refuses registration before any write. */
  readonly expectedDirectory?: string
}

/** Remove a global conversation from the library while retaining its archived native history. */
export interface ResearchDeleteLibraryConversationRequest extends ResearchCreateLibraryConversationRequest {}

/** Change a global conversation's metadata without changing its transcript or library files. */
export interface ResearchUpdateLibraryConversationRequest extends ResearchCreateLibraryConversationRequest {
  readonly title?: string
  readonly expectedTitle?: string
  readonly pinned?: boolean
  readonly archived?: boolean
}

/** A paper with independent Agent conversations, an original PDF and shared notebooks. */
export interface ResearchPaper {
  readonly id: ResearchPaperId
  readonly title: string
  /** Agent-selected core abbreviation used by newly imported original files. */
  readonly abbreviation?: string | undefined
  readonly topicIds: readonly ResearchTopicId[]
  readonly sessionId: SessionId
  /** Absent in legacy libraries; the original Session remains the first conversation. */
  readonly conversations?: readonly ResearchConversation[] | undefined
  /** Managed PDF path; empty until an original is attached. */
  readonly pdfPath: string
  readonly repositoryUrl: string
  readonly ai: ResearchNote
  readonly learning: ResearchNote
  /** Automatic full-text Markdown publication; absent before a PDF is attached or processed. */
  readonly markdown?: ResearchMarkdown | undefined
  /** PDF text selections stored with the paper metadata; absent in unannotated libraries. */
  readonly highlights?: readonly ResearchHighlight[] | undefined
  /** Absolute managed directory in the Host filesystem. */
  readonly directory?: string | undefined
  /** arXiv or DOI identity used to reuse an existing paper. */
  readonly sourceId?: string | undefined
  /** SHA-256 of the imported original PDF. */
  readonly pdfSha256?: string | undefined
  /** Original import location; the managed PDF is independent of it. */
  readonly source?: string | undefined
  /** Reader's continuation point and unresolved questions. */
  readonly progress?: string | undefined
}

/** Complete durable research catalog; revisions order stream and command replies. */
export interface ResearchCatalog {
  readonly revision: number
  /** Persisted directory order; newly created Topics append. */
  readonly topics: readonly ResearchTopic[]
  readonly papers: readonly ResearchPaper[]
  /** Explicitly registered global conversations, separate from Topic, paper and delegated Sessions. */
  readonly libraryConversations?: readonly ResearchConversation[] | undefined
  /** Runtime capabilities of the responding Host; absent in older backends and never persisted. */
  readonly capabilities?: {
    readonly pdfHighlights: true
    readonly pdfTranslations?: true
    readonly paperConversations?: true
    readonly libraryConversations?: true
    readonly libraryConversationDeletion?: true
  } | undefined
  /** Absolute managed library root. */
  readonly directory?: string | undefined
}

/** Attach a newly created independent Session to a topic. */
export interface ResearchCreateTopicRequest {
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** Delete a Topic and its exclusive papers after confirming every affected directory. */
export interface ResearchDeleteTopicRequest {
  readonly topicId: ResearchTopicId
  /** Absolute Topic directory displayed in the confirmation dialog. */
  readonly directory: string
  /** Complete set of exclusively owned paper directories displayed before deletion. */
  readonly papers: readonly { readonly paperId: ResearchPaperId; readonly directory: string }[]
}

/** Rename one Topic only while its last displayed title is still current. */
export interface ResearchRenameTopicRequest {
  readonly topicId: ResearchTopicId
  readonly title: string
  readonly expectedTitle: string
}

/** Replace one Topic's complete reading order without overwriting intervening moves or membership changes. */
export interface ResearchReorderPapersRequest {
  readonly topicId: ResearchTopicId
  readonly paperIds: readonly ResearchPaperId[]
  readonly expectedPaperIds: readonly ResearchPaperId[]
}

/** Replace the complete Topic directory order without overwriting intervening moves or membership changes. */
export interface ResearchReorderTopicsRequest {
  readonly topicIds: readonly ResearchTopicId[]
  readonly expectedTopicIds: readonly ResearchTopicId[]
}

/** Register a paper with an independent Session and an optional original. */
export interface ResearchCreatePaperRequest {
  readonly topicId: ResearchTopicId
  readonly title: string
  readonly abbreviation?: string
  readonly sessionId: SessionId
  readonly pdfPath?: string
  readonly repositoryUrl: string
  /** Optional external paper identity. */
  readonly sourceId?: string
}

/** Permanently remove one paper after the user confirms its current absolute directory. */
export interface ResearchDeletePaperRequest {
  readonly paperId: ResearchPaperId
  readonly directory: string
}

/** Switch to an existing library or copy the current library into a new directory. */
export interface ResearchDirectoryRequest {
  readonly directory: string
  readonly mode: 'open' | 'migrate'
}

/** Register a paper, optionally importing a local PDF or an HTTP(S) source. */
export interface ResearchImportPaperRequest {
  readonly topicId: ResearchTopicId
  readonly title: string
  readonly abbreviation?: string
  readonly source?: string
  readonly sourceId?: string
  readonly repositoryUrl?: string
}

/** Supply an existing paper's missing PDF without changing its identity or Session. */
export interface ResearchAttachPdfRequest {
  readonly paperId: ResearchPaperId
  readonly source: string
  readonly abbreviation?: string
  /** Optional paper-relative document folder; local originals already inside the paper retain their parent by default. */
  readonly folder?: string
}

/** Page range read by the Agent; returned text retains original page numbers. */
export interface ResearchReadPaperRequest {
  readonly paperId: ResearchPaperId
  readonly startPage?: number
  readonly pageCount?: number
}

/** Extracted original text, cached beneath the owning paper. */
export interface ResearchPaperText {
  readonly paperId: ResearchPaperId
  readonly totalPages: number
  readonly pages: readonly { readonly page: number; readonly text: string }[]
  readonly truncated: boolean
}

/** Complete library snapshots also carry file-observation failures without dropping confirmed data. */
export type ResearchFollowFrame =
  | { readonly type: 'baseline'; readonly catalog: ResearchCatalog }
  | { readonly type: 'changed'; readonly catalog: ResearchCatalog }
  | { readonly type: 'error'; readonly message: string }

/** Save one notebook only if its acknowledged revision is still current. */
export interface ResearchSaveNoteRequest {
  readonly paperId: ResearchPaperId
  readonly kind: ResearchNoteKind
  readonly text: string
  readonly expectedRevision: number
}

/** A paper-relative file address; an empty path denotes its root directory. */
export interface ResearchFileRequest {
  readonly paperId: ResearchPaperId
  readonly path: string
}

/** Direct directory children; links and special files are visible but cannot be opened. */
export interface ResearchDirectoryListing {
  readonly path: string
  readonly entries: readonly { readonly name: string; readonly path: string; readonly kind: 'directory' | 'file' | 'other'; readonly bytes?: number }[]
}

/** Complete bounded preview; unsupported contents are never returned as truncated text. */
export type ResearchFileContent =
  | { readonly kind: 'text'; readonly path: string; readonly text: string; readonly version: string; readonly editable: boolean }
  | { readonly kind: 'image'; readonly path: string; readonly src: string }
  | { readonly kind: 'unsupported'; readonly path: string; readonly reason: 'binary' | 'too-large' }

/** Markdown replacement requires the exact content version last read by the editor. */
export interface ResearchSaveFileRequest extends ResearchFileRequest {
  readonly text: string
  readonly expectedVersion: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Another reader changed the order or membership; reread before moving again. */
    'research/order-conflict': { readonly topicId: ResearchTopicId; readonly paperIds: readonly ResearchPaperId[] }
    /** Another writer moved, added or deleted a Topic; reread before ordering the directory again. */
    'research/topic-order-conflict': { readonly topicIds: readonly ResearchTopicId[] }
    /** Another editor renamed this conversation. */
    'research/conversation-conflict': { readonly sessionId: SessionId }
    /** The library changed while a global conversation was being prepared. */
    'research/library-changed': { readonly expectedDirectory: string; readonly directory: string }
    /** Another conversation for this paper owns the current Agent turn. */
    'research/conversation-busy': { readonly sessionId: SessionId }
    /** Native archival committed; refresh the catalog before deciding whether removal needs retry. */
    'research/conversation-delete-incomplete': { readonly sessionId: SessionId; readonly nativeArchived: true }
    /** Restore the conversation before submitting another prompt. */
    'research/conversation-archived': { readonly sessionId: SessionId }
    /** Another writer renamed the Topic; retain the draft and request a new edit from the current name. */
    'research/topic-conflict': { readonly topicId: ResearchTopicId; readonly title: string }
    /** A directory moved since confirmation; display the current path and request confirmation again. */
    'research/delete-path-changed': { readonly paperId?: ResearchPaperId; readonly directory: string }
    /** Exclusive paper membership or a confirmed directory changed before deletion. */
    'research/topic-contents-changed': { readonly topicId: ResearchTopicId }
    /** A Topic or related paper still has active work; stop it before retrying deletion. */
    'research/topic-busy': { readonly topicId: ResearchTopicId }
    /** A paper or its topic still has active work; stop that work before deleting its files. */
    'research/paper-busy': { readonly paperId: ResearchPaperId }
    /** Another writer changed the file; preserve the editor draft and load the latest contents. */
    'research/file-conflict': { readonly path: string }
    /** Invalid title, PDF path, execution workspace or notebook revision. */
    'research/invalid': { readonly field: string }
    /** A selected paper or topic no longer exists. */
    'research/not-found': { readonly id: string }
    /** Another writer changed the notebook; the caller must retain its draft. */
    'research/note-conflict': { readonly paperId: ResearchPaperId; readonly kind: ResearchNoteKind; readonly revision: number }
    /** Filesystem or download failure; refresh before retrying an interrupted write. */
    'research/storage-failed': { readonly operation: string; readonly path: string }
    /** A library directory contains invalid or unsupported metadata. */
    'research/invalid-library': { readonly path: string }
    /** Full-text extraction failed without changing the original or publishing partial Markdown. */
    'research/extraction-failed': { readonly reason: ResearchMarkdownFailure }
  }
}
