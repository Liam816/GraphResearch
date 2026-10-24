/** Research registrations share one view store and the Host catalog model. */
import type { Context } from '@deepseek-ai/cordis'
import type { UiWorkspace } from '../navigation.ts'
import type { ResearchInjected } from './contract.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { paperConversations, paperForSession } from './conversation-records.ts'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { ResearchAgentPane } from './Conversations.tsx'
import type { ResearchCatalog, ResearchPaper, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createResearchViewStore, type ResearchViewStore } from './store.ts'
import { ResearchDirectory } from './Directory.tsx'
import { ResearchWorkbench } from './Workbench.tsx'
import { en, zh } from './locales.ts'
import { ResearchActionToast, type ResearchNotice, type ResearchNoticeInjected } from './ActionToast.tsx'
import { paperDeleteFailure } from './DeletePaper.tsx'
import { topicRenameFailure } from './TopicActions.tsx'
import { topicDeleteFailure } from './DeleteTopic.tsx'

/**
 * Register research navigation, stable reading resources, and Session-scoped conversations.
 * @param ctx - Client services and Slot registry.
 * @param navigation - existing Session navigation owner.
 */
export function applyResearch(ctx: Context, navigation: UiWorkspace): void {
  const panelId = 'research' as MainPanelId
  const rawOpen: ResearchInjected['open'] = (id) => { navigation.openSession(id); ctx.layout.selectPanel(panelId) }
  const handle = createResearchViewStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  const notice = createSnapshotStore<ResearchNotice | null>(null)
  let noticeSeq = 0
  const currentSession = () => Object.values(ctx.sessions.list.getSnapshot().byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id
  const finishRemoval = (paper: ResearchPaper, catalog: ResearchCatalog, wasOpen: boolean): void => {
    instance.actions.forgetPaper(paper.id)
    const current = currentSession()
    if (!paperConversations(paper).some(item => item.sessionId === current) && !(current === undefined && wasOpen)) return
    const topic = catalog.topics.find(item => item.id === instance.getSnapshot().topicId && paper.topicIds.includes(item.id))
      ?? catalog.topics.find(item => paper.topicIds.includes(item.id))
    if (topic !== undefined) { instance.actions.topic(topic.id); open(topic.sessionId) }
  }
  const resources = createSnapshotStore<SessionReference | undefined>(undefined)
  const openConversation: ResearchInjected['openConversation'] = (paperId, id) => {
    instance.actions.conversation(paperId, id)
    rawOpen(id)
  }
  const open: ResearchInjected['open'] = (id) => {
    const paper = paperForSession(ctx.research.state.getSnapshot().catalog, id)
    if (paper === undefined) { rawOpen(id); return }
    const conversations = paperConversations(paper)
    const selected = instance.getSnapshot().papers[paper.id]?.activeSession
    const target = conversations.find(item => item.sessionId === selected && !item.archived)
      ?? conversations.find(item => !item.archived) ?? conversations[0]
    if (target !== undefined) openConversation(paper.id, target.sessionId)
  }
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
  let input: Context['conversation']['input'] | undefined
  const injected = (): ResearchInjected => ({
    hooks: { research: ctx.research.state, resources },
    openConversation,
    insertText: (id, text) => {
      if (currentSession() !== id) return false
      const binding = ctx.sessions.binding(id)
      if (binding === undefined || input === undefined) return false
      const actions = input.for(binding.ctx).actions
      return actions.insertText(text, actions.captureInsertion())
    },
    insertReferences: async (id, ids) => {
      if (currentSession() !== id) return false
      const binding = ctx.sessions.binding(id)
      if (binding === undefined || input === undefined) return false
      const actions = input.for(binding.ctx).actions, span = actions.captureInsertion()
      const mentions = await ctx.research.mentions(ids)
      return currentSession() === id && actions.insertText(`${mentions.join(' ')} `, span)
    },
    open,
    refresh: () => ctx.research.refresh(),
    listFiles: request => ctx.research.listFiles(request),
    readFile: request => ctx.research.readFile(request),
    saveFile: request => ctx.research.saveFile(request),
    highlight: request => ctx.research.highlight(request),
    extractMarkdown: id => ctx.research.extractMarkdown(id),
    translate: (request, signal) => {
      const sessionId = currentSession()
      return ctx.research.translate({ ...request, ...sessionId === undefined ? {} : { sessionId } }, signal)
    },
    saveTranslation: (id, key) => ctx.research.saveTranslation(id, key),
    saveNote: request => ctx.research.saveNote(request),
    configureDirectory: request => ctx.research.configure(request),
    createConversation: async (paperId) => {
      const catalog = ctx.research.state.getSnapshot().catalog
      const paper = catalog.papers.find(item => item.id === paperId)
      const topic = catalog.topics.find(item => paper?.topicIds.includes(item.id))
      if (topic === undefined) throw new Error('The paper Topic is unavailable')
      if (catalog.capabilities?.paperConversations !== true) {
        notice.set({ seq: ++noticeSeq, message: 'conversationBackendRestart', success: false })
        throw new Error('Paper conversation management requires an updated Host')
      }
      const selectedAtStart = currentSession()
      const key = `conversation:${paperId}`
      try {
        const sessionId = await createSession(key, topic.workspaceId)
        await ctx.research.createConversation({ paperId, sessionId })
        pending.delete(key)
        if (currentSession() === selectedAtStart) {
          instance.actions.focus(paperId, 'agent')
          openConversation(paperId, sessionId)
        }
      } catch (error: unknown) {
        notice.set({ seq: ++noticeSeq, message: 'conversationCreateFailed', success: false })
        throw error
      }
    },
    updateConversation: async (request) => {
      try {
        await ctx.research.updateConversation(request)
        if (request.archived === true && currentSession() === request.sessionId) {
          const paper = ctx.research.state.getSnapshot().catalog.papers.find(item => item.id === request.paperId)
          const next = paper === undefined ? undefined : paperConversations(paper).find(item => !item.archived)
          if (next !== undefined) openConversation(request.paperId, next.sessionId)
        }
        notice.set({ seq: ++noticeSeq, message: request.archived === true ? 'conversationArchived' : 'conversationSaved', success: true })
      } catch (error: unknown) {
        notice.set({ seq: ++noticeSeq, message: 'conversationUpdateFailed', success: false })
        throw error
      }
    },
    renameTopic: async (request) => {
      try { await ctx.research.renameTopic(request) }
      catch (error: unknown) {
        notice.set({ seq: ++noticeSeq, message: topicRenameFailure(error), success: false })
        try { await ctx.research.refresh() }
        catch (refreshError: unknown) { console.error('Research refresh after Topic rename failed:', refreshError) }
        throw error
      }
      notice.set({ seq: ++noticeSeq, message: 'topicRenamed', success: true })
    },
    deleteTopic: async (request) => {
      const before = ctx.research.state.getSnapshot().catalog
      const topic = before.topics.find(item => item.id === request.topicId)
      const owned = before.papers.filter(item => item.topicIds.includes(request.topicId) && item.topicIds.length === 1)
      const selected = currentSession()
      const wasOpen = (topic !== undefined && selected === topic.sessionId)
        || owned.some(paper => paperConversations(paper).some(item => item.sessionId === selected))
      const finish = (): void => {
        const after = ctx.research.state.getSnapshot().catalog
        if (after.topics.some(item => item.id === request.topicId)) return
        instance.actions.forgetTopic(request.topicId)
        for (const paper of owned) if (!after.papers.some(item => item.id === paper.id)) instance.actions.forgetPaper(paper.id)
        const current = currentSession()
        if (!wasOpen || (current !== undefined && current !== selected)) return
        const next = after.topics[0]
        if (next !== undefined) { instance.actions.topic(next.id); open(next.sessionId) }
      }
      try { await ctx.research.deleteTopic(request) }
      catch (error: unknown) {
        notice.set({ seq: ++noticeSeq, message: topicDeleteFailure(error), success: false })
        try { await ctx.research.refresh() }
        catch (refreshError: unknown) { console.error('Research refresh after Topic deletion failed:', refreshError) }
        finish()
        throw error
      }
      finish()
      notice.set({ seq: ++noticeSeq, message: 'topicDeleted', success: true })
    },
    deletePaper: async (request) => {
      const catalog = ctx.research.state.getSnapshot().catalog
      const paper = catalog.papers.find(item => item.id === request.paperId)
      const wasOpen = paper !== undefined && paperConversations(paper).some(item => item.sessionId === currentSession())
      try {
        await ctx.research.deletePaper(request)
      } catch (error: unknown) {
        notice.set({ seq: ++noticeSeq, message: paperDeleteFailure(error), success: false })
        // An interrupted filesystem transaction may have completed; load its confirmed outcome before retry.
        try { await ctx.research.refresh() }
        catch (refreshError: unknown) { console.error('Research refresh after deletion failed:', refreshError) }
        if (paper !== undefined && !ctx.research.state.getSnapshot().catalog.papers.some(item => item.id === paper.id)) {
          finishRemoval(paper, catalog, wasOpen)
        }
        throw error
      }
      if (paper !== undefined) finishRemoval(paper, catalog, wasOpen)
      notice.set({ seq: ++noticeSeq, message: 'paperDeleted', success: true })
    },
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
      open(paper.sessionId)
    },
  })
  ctx.effect(() => ctx.locale.register('research', { zh, en }))
  ctx.slots.inject('sidebar.workspaces.research', () => ctx.slots.register({
    name: 'sidebar.workspaces.research', store, locale: 'research', inject: injected,
  }, ResearchDirectory))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'research.action-toast', locale: 'research',
    inject: (): ResearchNoticeInjected => ({ hooks: { notice }, dismiss: () => { notice.set(null) } }),
  }, ResearchActionToast))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, store, children: { 'main.research': { kind: 'single', scope: 'root' } },
  }, ResearchPanel))
  ctx.slots.inject('main.research', () => ctx.slots.register({
    name: 'main.research', locale: 'research', inject: injected, children: { 'research.agent': { kind: 'single', scope: 'session-maybe' } },
  }, ResearchWorkbench))
  ctx.slots.inject('research.agent', () => ctx.slots.register({
    name: 'research.agent', locale: 'research', inject: injected,
  }, ResearchAgentPane))
  let resourcePaper: string | undefined
  const ownedBlocks = new Map<import('@deepseek-ai/dsh-session/types').SessionId, string>()
  ctx.inject(['conversation'], scope => scope.effect(() => {
    input = scope.conversation.input
    const sync = (): void => {
      const catalog = ctx.research.state.getSnapshot().catalog, list = ctx.sessions.list.getSnapshot().byId
      const wanted = new Map<import('@deepseek-ai/dsh-session/types').SessionId, string>()
      const t = ctx.locale.bind('research')
      for (const paper of catalog.papers) {
        const entries = paperConversations(paper)
        for (const conversation of entries) {
          if (conversation.archived) wanted.set(conversation.sessionId, t('conversationIsArchived'))
          else if (entries.some(other => other.sessionId !== conversation.sessionId && list[other.sessionId]?.running === true)) {
            wanted.set(conversation.sessionId, t('conversationOtherRunning'))
          }
        }
      }
      for (const [id, reason] of ownedBlocks) {
        if (!wanted.has(id) && scope.conversation.blocks.storeFor(id).getSnapshot()?.reason === reason) {
          scope.conversation.blocks.set(id, undefined)
        }
      }
      for (const [id, reason] of wanted) {
        const previous = scope.conversation.blocks.storeFor(id).getSnapshot()
        if (previous === undefined || previous.reason === ownedBlocks.get(id)) scope.conversation.blocks.set(id, { reason })
      }
      ownedBlocks.clear(); for (const [id, reason] of wanted) ownedBlocks.set(id, reason)
      const current = currentSession(), paper = paperForSession(ctx.research.state.getSnapshot().catalog, current)
      if (paper !== undefined && current !== undefined) instance.actions.conversation(paper.id, current)
      if (paper?.id === resourcePaper) return
      const previous = resources.getSnapshot()
      resourcePaper = paper?.id
      const reference = paper === undefined ? undefined : ctx.sessions.retain(paper.sessionId, { source: 'researchResources' })
      resources.set(reference)
      previous?.release()
      void reference?.ready.catch((error: unknown) => {
        if (resources.getSnapshot() === reference) console.error('Paper resource Session failed to open:', error)
      })
    }
    let queued = false, live = true
    const schedule = (): void => {
      if (queued || !live) return
      queued = true
      queueMicrotask(() => { queued = false; if (live) sync() })
    }
    const stopSessions = ctx.sessions.list.subscribe(schedule), stopCatalog = ctx.research.state.subscribe(schedule)
    schedule()
    return () => {
      live = false
      input = undefined
      stopSessions(); stopCatalog(); resources.getSnapshot()?.release(); resources.set(undefined); resourcePaper = undefined
      for (const [id, reason] of ownedBlocks) {
        if (scope.conversation.blocks.storeFor(id).getSnapshot()?.reason === reason) scope.conversation.blocks.set(id, undefined)
      }
      ownedBlocks.clear()
    }
  }))
  let restored = false
  const restore = (): void => {
    if (restored || ctx.research.state.getSnapshot().phase !== 'ready') return
    const catalog = ctx.research.state.getSnapshot().catalog
    const current = Object.values(ctx.sessions.list.getSnapshot().byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id
    if (current === undefined) return
    restored = true
    if (catalog.topics.some(item => item.sessionId === current) || paperForSession(catalog, current) !== undefined) {
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
