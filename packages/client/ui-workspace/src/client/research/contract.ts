/** Public Slot inputs; component code receives only snapshots, actions, and standard props. */
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchSnapshot, ResearchCreateTopicRequest, ResearchCreatePaperRequest, ResearchSaveNoteRequest, ResearchPaperId, ResearchDirectoryRequest, ResearchHighlightRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchViewStore } from './store.ts'
import type { ResearchKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

/** Research commands installed by the plugin assembly. */
export interface ResearchInjected {
  hooks: { research: HostObservable<ResearchSnapshot> }
  refresh: () => Promise<void>
  open: (sessionId: SessionId) => void
  createTopic: (request: Pick<ResearchCreateTopicRequest, 'title'>) => Promise<void>
  createPaper: (request: Omit<ResearchCreatePaperRequest, 'sessionId'>) => Promise<void>
  highlight: (request: ResearchHighlightRequest) => Promise<void>
  saveNote: (request: ResearchSaveNoteRequest) => Promise<void>
  configureDirectory: (request: ResearchDirectoryRequest) => Promise<void>
  mentions: (paperIds: readonly ResearchPaperId[]) => Promise<readonly string[]>
}

/** Root-owned preferences passed into the session-bound paper workbench. */
export interface ResearchViewOwner {
  view: ReturnType<ReturnType<ResearchViewStore['create']>['getSnapshot']>
  viewActions: PropsStore<ResearchViewStore>['actions']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Research tree preceding the ordinary Workspace browser. */
    'sidebar.workspaces.research': { kind: 'single'; scope: 'root' }
    /** Session-bound research main view. */
    'main.research': { kind: 'single'; scope: 'session-maybe'; owner: ResearchViewOwner }
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
/** Session-maybe workbench props, using reusable conversation and PDF factories. */
export type ResearchWorkbenchProps = PropsRuntime<'main.research'> & PropsRenderFactories & Omit<ResearchSeats, 'useStore' | 'actions'>
