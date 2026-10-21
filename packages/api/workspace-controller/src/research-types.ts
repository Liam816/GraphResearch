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
  | { readonly status: 'ready'; readonly sourceSha256: string; readonly path: 'paper.md'; readonly pages: number; readonly backend: 'pdfjs' | 'pdftotext' }
  | { readonly status: 'failed'; readonly sourceSha256?: string | undefined; readonly code: ResearchMarkdownFailure }

/** Stable extraction failures; the original PDF and notebooks remain available. */
export type ResearchMarkdownFailure = 'no-text' | 'text-limit' | 'timeout' | 'conversion-failed' | 'source-changed'

/** A topic with its own Agent session and execution workspace. */
export interface ResearchTopic {
  readonly id: ResearchTopicId
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  /** Browser projection of the topic's Markdown summary. */
  readonly notes?: ResearchNote | undefined
}

/** A paper with its own Agent session, original PDF and notebooks. */
export interface ResearchPaper {
  readonly id: ResearchPaperId
  readonly title: string
  readonly topicIds: readonly ResearchTopicId[]
  readonly sessionId: SessionId
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
  readonly topics: readonly ResearchTopic[]
  readonly papers: readonly ResearchPaper[]
  /** Runtime capabilities of the responding Host; absent in older backends and never persisted. */
  readonly capabilities?: { readonly pdfHighlights: true; readonly pdfTranslations?: true } | undefined
  /** Absolute managed library root. */
  readonly directory?: string | undefined
}

/** Attach a newly created independent Session to a topic. */
export interface ResearchCreateTopicRequest {
  readonly title: string
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** Register a paper with an independent Session and an optional original. */
export interface ResearchCreatePaperRequest {
  readonly topicId: ResearchTopicId
  readonly title: string
  readonly sessionId: SessionId
  readonly pdfPath?: string
  readonly repositoryUrl: string
  /** Optional external paper identity. */
  readonly sourceId?: string
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
  readonly source?: string
  readonly sourceId?: string
  readonly repositoryUrl?: string
}

/** Supply an existing paper's missing PDF without changing its identity or Session. */
export interface ResearchAttachPdfRequest {
  readonly paperId: ResearchPaperId
  readonly source: string
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
