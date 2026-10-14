/** Research registrations share one view store and the Host catalog model. */
import type { Context } from '@deepseek-ai/cordis'
import type { UiWorkspace } from '../navigation.ts'
import type { ResearchInjected } from './contract.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { createResearchViewStore, type ResearchViewStore } from './store.ts'
import { ResearchDirectory } from './Directory.tsx'
import { ResearchWorkbench } from './Workbench.tsx'
import { en, zh } from './locales.ts'

/**
 * Register research navigation and its session-bound workbench.
 * @param ctx - Client services and Slot registry.
 * @param navigation - existing Session navigation owner.
 */
export function applyResearch(ctx: Context, navigation: UiWorkspace): void {
  const panelId = 'research' as MainPanelId
  const open: ResearchInjected['open'] = (id) => { navigation.openSession(id); ctx.layout.selectPanel(panelId) }
  const handle = createResearchViewStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  const pending = new Map<string, Promise<Parameters<ResearchInjected['open']>[0]>>()
  const createSession = (key: string, workspaceId: WorkspaceId) => {
    let session = pending.get(key)
    if (session === undefined) {
      session = ctx.sessions.create({ workspaceId })
      pending.set(key, session)
      void session.catch(() => { pending.delete(key) })
    }
    return session
  }
  const injected = (): ResearchInjected => ({
    hooks: { research: ctx.research.state },
    open,
    refresh: () => ctx.research.refresh(),
    saveNote: request => ctx.research.saveNote(request),
    configureDirectory: request => ctx.research.configure(request),
    mentions: ids => ctx.research.mentions(ids),
    createTopic: async (request) => {
      const directory = ctx.research.state.getSnapshot().catalog.directory
      if (directory === undefined) throw new Error('Research library directory is not ready')
      const workspace = await ctx.workspaces.create({ path: directory })
      const key = JSON.stringify(['topic', workspace.workspaceId, request.title])
      const sessionId = await createSession(key, workspace.workspaceId)
      await ctx.research.createTopic({ ...request, workspaceId: workspace.workspaceId, sessionId })
      pending.delete(key)
      const topic = ctx.research.state.getSnapshot().catalog.topics.find(item => item.sessionId === sessionId)
      if (topic !== undefined) instance.actions.topic(topic.id)
      open(sessionId)
    },
    createPaper: async (request) => {
      const topic = ctx.research.state.getSnapshot().catalog.topics.find(item => item.id === request.topicId)
      if (topic === undefined) throw new Error('Research Topic no longer exists')
      const paperId = await ctx.research.importPaper({
        topicId: topic.id, title: request.title, source: request.pdfPath ?? '', repositoryUrl: request.repositoryUrl,
        ...request.sourceId === undefined ? {} : { sourceId: request.sourceId },
      })
      instance.actions.topic(topic.id)
      const paper = ctx.research.state.getSnapshot().catalog.papers.find(item => item.id === paperId)
      if (paper === undefined) throw new Error('Imported paper is missing from the confirmed library')
      instance.actions.expand(paper.id, true)
      open(paper.sessionId)
    },
  })
  ctx.effect(() => ctx.locale.register('research', { zh, en }))
  ctx.slots.inject('sidebar.workspaces.research', () => ctx.slots.register({
    name: 'sidebar.workspaces.research', store, locale: 'research', inject: injected,
  }, ResearchDirectory))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, store, children: { 'main.research': { kind: 'single', scope: 'session-maybe' } },
  }, ResearchPanel))
  ctx.slots.inject('main.research', () => ctx.slots.register({
    name: 'main.research', locale: 'research', inject: injected,
  }, ResearchWorkbench))
  let restored = false
  const restore = (): void => {
    if (restored || ctx.research.state.getSnapshot().phase !== 'ready') return
    const catalog = ctx.research.state.getSnapshot().catalog
    const current = Object.values(ctx.sessions.list.getSnapshot().byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id
    if (current === undefined) return
    restored = true
    if (catalog.topics.some(item => item.sessionId === current) || catalog.papers.some(item => item.sessionId === current)) {
      ctx.layout.selectPanel(panelId)
    }
  }
  ctx.effect(() => {
    const stopCatalog = ctx.research.state.subscribe(restore)
    const stopSessions = ctx.sessions.list.subscribe(restore)
    restore()
    return () => { stopSessions(); stopCatalog() }
  })
}

function ResearchPanel({ renderSlot, useStore, actions }: PropsRuntime<'main'> & PropsRenderSlots<'main.research'> & PropsStore<ResearchViewStore>) {
  const view = useStore(value => value)
  return renderSlot('main.research', { view, viewActions: actions })
}
