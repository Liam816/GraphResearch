/** Public Slot inputs; component code receives only snapshots, actions, and standard props. */
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchSnapshot, ResearchCreateTopicRequest, ResearchCreatePaperRequest, ResearchDeletePaperRequest, ResearchSaveNoteRequest, ResearchPaperId, ResearchDirectoryRequest, ResearchHighlightRequest, ResearchFileRequest, ResearchDirectoryListing, ResearchFileContent, ResearchSaveFileRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResearchPaper, ResearchUpdateConversationRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchTranslation, ResearchTranslationRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchViewStore } from './store.ts'
import type { ResearchRenameTopicRequest, ResearchDeleteTopicRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

/** Research commands installed by the plugin assembly. */
export interface ResearchInjected {
  hooks: { research: HostObservable<ResearchSnapshot>; resources: HostObservable<SessionReference | undefined> }
  createConversation: (paperId: ResearchPaperId) => Promise<void>
  updateConversation: (request: ResearchUpdateConversationRequest) => Promise<void>
  openConversation: (paperId: ResearchPaperId, sessionId: SessionId) => void
  insertText: (sessionId: SessionId, text: string) => boolean
  insertReferences: (sessionId: SessionId, paperIds: readonly ResearchPaperId[]) => Promise<boolean>
  refresh: () => Promise<void>
  listFiles: (request: ResearchFileRequest) => Promise<ResearchDirectoryListing>
  readFile: (request: ResearchFileRequest) => Promise<ResearchFileContent>
  saveFile: (request: ResearchSaveFileRequest) => Promise<ResearchFileContent>
  open: (sessionId: SessionId) => void
  createTopic: (request: Pick<ResearchCreateTopicRequest, 'title'>) => Promise<void>
  renameTopic: (request: ResearchRenameTopicRequest) => Promise<void>
  deleteTopic: (request: ResearchDeleteTopicRequest) => Promise<void>
  createPaper: (request: Omit<ResearchCreatePaperRequest, 'sessionId'>) => Promise<void>
  deletePaper: (request: ResearchDeletePaperRequest) => Promise<void>
  highlight: (request: ResearchHighlightRequest) => Promise<void>
  extractMarkdown: (paperId: ResearchPaperId) => Promise<void>
  translate: (request: ResearchTranslationRequest, signal: AbortSignal) => Promise<ResearchTranslation>
  saveTranslation: (paperId: ResearchPaperId, key: string) => Promise<void>
  saveNote: (request: ResearchSaveNoteRequest) => Promise<void>
  configureDirectory: (request: ResearchDirectoryRequest) => Promise<void>
  mentions: (paperIds: readonly ResearchPaperId[]) => Promise<readonly string[]>
}

/** Root-owned preferences passed into the stable paper workbench. */
export interface ResearchViewOwner {
  view: ReturnType<ReturnType<ResearchViewStore['create']>['getSnapshot']>
  viewActions: PropsStore<ResearchViewStore>['actions']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Research tree preceding the ordinary Workspace browser. */
    'sidebar.workspaces.research': { kind: 'single'; scope: 'root' }
    /** Root-scoped research main view. */
    'main.research': { kind: 'single'; scope: 'root'; owner: ResearchViewOwner }
    /** Only the Agent column changes its Session binding while paper resources remain mounted. */
    'research.agent': { kind: 'single'; scope: 'session-maybe'; owner: { paper: ResearchPaper | undefined } }
  }
  interface LocaleNamespaceMap {
    /** Research navigation, notes, and panel controls. */
    research: ResearchKey
  }
}

/** Shared view, locale, and command seats. */
export type ResearchSeats = PropsStore<ResearchViewStore> & PropsLocale<'research'> & PropsHooks<ResearchInjected['hooks']> & Omit<ResearchInjected, 'hooks'>
/** Root-scoped directory props. */
export type ResearchDirectoryProps = PropsRuntime<'sidebar.workspaces.research'> & ResearchSeats
/** Root workbench props, using a Session-scoped Agent column and stable paper resources. */
export type ResearchWorkbenchProps = PropsRuntime<'main.research'> & PropsRenderFactories & import('@deepseek-ai/dsh-client-ui-slots').PropsRenderSlots<'research.agent'> & Omit<ResearchSeats, 'useStore' | 'actions'>

/** Session-scoped Agent body inside the stable paper workbench. */
export type ResearchAgentProps = PropsRuntime<'research.agent'> & PropsRenderFactories & Omit<ResearchSeats, 'useStore' | 'actions'>

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Stable reading-resource binding across conversations of the same paper. */
    researchResources: unknown
  }
}
