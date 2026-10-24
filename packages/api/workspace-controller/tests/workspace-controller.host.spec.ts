import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import WorkspaceController from '../src/index.ts'
import { DEFAULT_WORKSPACE_DIRECTORY } from '../src/default-workspace.ts'
import { WorkspaceFeed } from '../src/feed.ts'
import type { WorkspaceFollowFrame } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { pdfFixture } from '../../../client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import type { ResearchHighlight, ResearchHighlightId, ResearchPaperId } from '../src/research-types.ts'
import { paperConversations, conversationBackup } from '../src/research-conversations.ts'
import { restoreResearchSessions } from '../src/research-session-backup.ts'
import { ResearchFiles, digest } from '../src/research-files.ts'

// The controller relays whatever families the providers report; this suite merges its own.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
    'probe-items': true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'fixture/failure': {}
  }
}

const roots: Context[] = []

/** Workspace roots created per test, removed after their context settles. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function harness(options: { systemDocuments?: boolean; nativeSessions?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-controller-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  if (options.nativeSessions === true) await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native-sessions'), compression: 'none' })
  else ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
  } as never)
  const controller = new WorkspaceController(ctx, {
    ...options.systemDocuments === true ? {} : { documentsDirectory: root }, researchDirectory: join(root, 'data'), researchPdfTextBackend: 'pdfjs',
  })
  return { controller, ctx, root, storageDomain }
}

function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

async function nextFrame(
  iterator: AsyncIterator<WorkspaceFollowFrame>,
): Promise<WorkspaceFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Workspace stream ended before the expected frame')
  return next.value
}

describe('WorkspaceController commands', () => {
  it('serializes concurrent path adoption and preserves an existing title', async () => {
    const { controller, root } = await harness()
    const path = stageDir(root, 'alpha')
    const results = await Promise.all([
      controller.create({ path }),
      controller.create({ path }),
    ])
    const created = results.find(result => result.created)
    const resolved = results.find(result => !result.created)
    expect(created).toMatchObject({ workspace: { path, title: 'alpha' } })
    expect(resolved?.workspace.workspaceId).toBe(created?.workspace.workspaceId)

    const workspaceId = created?.workspace.workspaceId
    if (workspaceId === undefined) throw new Error('fixture did not create a Workspace')
    await controller.rename({ workspaceId, title: 'renamed' })
    await expect(controller.create({ path })).resolves.toMatchObject({
      created: false,
      workspace: { workspaceId, title: 'renamed' },
    })
  })

  it('maps invalid paths, blank names, conflicts, and unknown ids to stable failures', async () => {
    const { controller, root } = await harness()
    const first = await controller.create({ path: stageDir(root, 'first') })
    const second = await controller.create({ path: stageDir(root, 'second') })

    await expect(controller.create({ path: join(root, 'missing') })).rejects.toMatchObject({
      code: 'workspace/invalid-path',
      details: { path: join(root, 'missing') },
    })
    expect(existsSync(join(root, 'missing'))).toBe(false)
    await expect(controller.rename({ workspaceId: first.workspace.workspaceId, title: '  ' }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await controller.rename({ workspaceId: first.workspace.workspaceId, title: 'occupied' })
    await expect(controller.rename({ workspaceId: second.workspace.workspaceId, title: ' occupied ' }))
      .rejects.toMatchObject({ code: 'workspace/name-conflict' })
    await expect(controller.delete({ workspaceId: 'missing' as WorkspaceId }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('preserves Remote failures and propagates unexpected registry failures', async () => {
    const { controller, ctx, root } = await harness()
    const remoteFailure = new RemoteError('fixture/failure', 'already mapped', {})
    const resolveByPath = vi.spyOn(ctx.workspaceRegistry, 'resolveByPath')
      .mockRejectedValueOnce(remoteFailure)
      .mockRejectedValueOnce('plain failure')
    await expect(controller.create({ path: stageDir(root, 'remote-failure') }))
      .rejects.toBe(remoteFailure)
    const plainFailure = controller.create({ path: stageDir(root, 'plain-failure') })
    await expect(plainFailure).rejects.toMatchObject({ code: 'workspace/invalid-path' })
    await expect(plainFailure).rejects.toThrow('plain failure')
    resolveByPath.mockRestore()

    const created = await controller.create({ path: stageDir(root, 'created') })
    const workspace = ctx.workspaceRegistry.get(created.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')

    const orderFailure = new Error('order storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'insertBefore').mockRejectedValueOnce(orderFailure)
    await expect(controller.insertBefore({ workspaceId: created.workspace.workspaceId }))
      .rejects.toBe(orderFailure)

    const moveFailure = new Error('membership storage failed')
    vi.spyOn(workspace, 'insertSessionBefore').mockRejectedValueOnce(moveFailure)
    await expect(controller.insertSessionBefore({
      workspaceId: created.workspace.workspaceId,
      sessionId: SessionId('session'),
    })).rejects.toBe(moveFailure)

    const archiveFailure = new Error('archive storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'archiveSession').mockRejectedValueOnce(archiveFailure)
    await expect(controller.archiveSession({ sessionId: SessionId('session') }))
      .rejects.toBe(archiveFailure)

    const unarchiveFailure = new Error('unarchive storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'unarchiveSession').mockRejectedValueOnce(unarchiveFailure)
    await expect(controller.unarchiveSession({ sessionId: SessionId('session') }))
      .rejects.toBe(unarchiveFailure)

    const pinFailure = new Error('pin storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'pinSession').mockRejectedValueOnce(pinFailure)
    await expect(controller.pinSession({ sessionId: SessionId('session') }))
      .rejects.toBe(pinFailure)

    const unpinFailure = new Error('unpin storage failed')
    vi.spyOn(ctx.workspaceRegistry, 'unpinSession').mockRejectedValueOnce(unpinFailure)
    await expect(controller.unpinSession({ sessionId: SessionId('session') }))
      .rejects.toBe(unpinFailure)
  })

  it('resolves queued Workspace identities when their operation starts', async () => {
    const { controller, ctx, root } = await harness()
    const target = await controller.create({ path: stageDir(root, 'target') })
    const blockerPath = stageDir(root, 'blocker')
    const gate = deferred<undefined>()
    const originalResolveByPath = ctx.workspaceRegistry.resolveByPath.bind(ctx.workspaceRegistry)
    const resolveByPath = vi.spyOn(ctx.workspaceRegistry, 'resolveByPath')
    resolveByPath.mockImplementationOnce(async (path) => {
      await gate.promise
      return originalResolveByPath(path)
    })

    const blocker = controller.create({ path: blockerPath })
    const deletion = controller.delete({ workspaceId: target.workspace.workspaceId })
    const staleRename = controller.rename({
      workspaceId: target.workspace.workspaceId,
      title: 'must-not-land',
    })
    gate.resolve(undefined)
    await blocker
    await expect(deletion).resolves.toEqual({ deleted: true })
    await expect(staleRename).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('reorders Workspaces and Sessions and archives only known Sessions', async () => {
    const { controller, ctx, root } = await harness()
    const first = await controller.create({ path: stageDir(root, 'first') })
    const second = await controller.create({ path: stageDir(root, 'second') })
    await expect(controller.insertBefore({
      workspaceId: first.workspace.workspaceId,
      beforeWorkspaceId: second.workspace.workspaceId,
    })).resolves.toEqual({
      workspaceIds: [first.workspace.workspaceId, second.workspace.workspaceId],
    })
    await expect(controller.insertBefore({ workspaceId: 'missing' as WorkspaceId }))
      .rejects.toMatchObject({ code: 'workspace/not-found' })

    const session = ctx.sessions.create(SessionId('session-one'), {
      meta: { cwd: first.workspace.path },
    })
    const workspace = ctx.workspaceRegistry.get(first.workspace.workspaceId)
    if (workspace === undefined) throw new Error('fixture Workspace disappeared')
    await workspace.attachSession(session.id)
    await expect(controller.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: session.id,
    })).resolves.toMatchObject({ workspace: { sessionIds: [session.id] } })
    await expect(controller.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: SessionId('missing-session'),
    })).rejects.toMatchObject({ code: 'workspace/move-invalid' })
    await expect(controller.insertSessionBefore({
      workspaceId: first.workspace.workspaceId,
      sessionId: session.id,
      beforeSessionId: SessionId('missing-anchor'),
    })).rejects.toMatchObject({
      code: 'workspace/move-invalid',
      details: { beforeSessionId: 'missing-anchor' },
    })
    await expect(controller.insertSessionBefore({
      workspaceId: 'missing' as WorkspaceId,
      sessionId: session.id,
    })).rejects.toMatchObject({ code: 'workspace/not-found' })

    // A session reported active by the registry's activity waterfall is a
    // stable business failure carrying what still runs, and nothing is written.
    const activity = [{ kind: 'probe' as const }, { kind: 'probe-items' as const, items: [{ id: 'item-1', label: 'build' }] }]
    const stopReporting = ctx.on('workspace/session-activity', async ({ sessionId }, next) =>
      sessionId === session.id ? [...activity, ...(await next())] : next())
    await expect(controller.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: 'workspace/session-active',
      details: { sessionId: session.id, activity },
    })
    expect([...ctx.workspaceRegistry.archivedSessionIds]).toEqual([])
    // Asking to stop the work archives the still-active Session and reaches
    // the stop providers first.
    const stops: string[] = []
    const stopListening = ctx.on('workspace/session-stop', ({ sessionId }) => { stops.push(String(sessionId)) })
    await expect(controller.archiveSession({ sessionId: session.id, stopActivity: true }))
      .resolves.toEqual({ archivedSessionIds: [session.id] })
    expect(stops).toEqual([String(session.id)])
    stopListening()
    await expect(controller.unarchiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [] })
    stopReporting()

    await expect(controller.archiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [session.id] })
    await expect(controller.archiveSession({ sessionId: SessionId('unknown') }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(controller.unarchiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [] })
    // Unarchive is idempotent: an id that is not archived is not an error.
    await expect(controller.unarchiveSession({ sessionId: session.id }))
      .resolves.toEqual({ archivedSessionIds: [] })
  })

  it('pins only known unarchived Sessions and unpins idempotently', async () => {
    const { controller, ctx, root } = await harness()
    const created = await controller.create({ path: stageDir(root, 'pins') })
    const session = ctx.sessions.create(SessionId('pin-me'), {
      meta: { cwd: created.workspace.path },
    })

    await expect(controller.pinSession({ sessionId: session.id }))
      .resolves.toEqual({ pinnedSessionIds: [session.id] })
    await expect(controller.pinSession({ sessionId: SessionId('unknown') }))
      .rejects.toMatchObject({ code: 'session/not-found' })

    // Pinning an archived Session is a caller error, not a missing session.
    const archived = ctx.sessions.create(SessionId('stored'), {
      meta: { cwd: created.workspace.path },
    })
    await controller.archiveSession({ sessionId: archived.id })
    await expect(controller.pinSession({ sessionId: archived.id }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })

    await expect(controller.unpinSession({ sessionId: session.id }))
      .resolves.toEqual({ pinnedSessionIds: [] })
    // Unpin is idempotent: an id that is not pinned is not an error.
    await expect(controller.unpinSession({ sessionId: session.id }))
      .resolves.toEqual({ pinnedSessionIds: [] })
  })
})

describe('WorkspaceController follow', () => {
  it('seeds a new feed from existing rows and rejects an inconsistent registry commit', async () => {
    const { ctx, root } = await harness()
    const existing = await ctx.workspaceRegistry.create(stageDir(root, 'existing'))
    const feed = new WorkspaceFeed(ctx)
    expect(feed.baseline()).toMatchObject({
      items: [{ workspaceId: existing.id }],
    })

    expect(() => {
      ctx.emit('domain/changed', {
        domain: 'workspace',
        table: '',
        key: '',
        operation: 'put',
        value: {
          initialized: true,
          workspaceIds: ['missing'],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      })
    }).toThrow('references missing Workspace "missing"')
  })

  it('starts a fresh feed with existing pins and follows their removal', async () => {
    const { controller, ctx, root } = await harness()
    const session = ctx.sessions.create(SessionId('already-pinned'), { meta: { cwd: root } })
    await controller.pinSession({ sessionId: session.id })
    const feed = new WorkspaceFeed(ctx)
    const abort = new AbortController()
    const iterator = feed.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(nextFrame(iterator)).resolves.toMatchObject({
        type: 'baseline', value: { pinnedSessionIds: [session.id] },
      })
      await controller.unpinSession({ sessionId: session.id })
      await expect(nextFrame(iterator)).resolves.toEqual({ type: 'pinned', pinnedSessionIds: [] })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('starts with a complete baseline and emits committed increments in domain order', async () => {
    const { controller, ctx, root } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'baseline',
      value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
    })

    const first = await controller.create({ path: stageDir(root, 'first') })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: first.workspace.workspaceId },
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order', workspaceIds: [first.workspace.workspaceId],
    })
    await controller.rename({ workspaceId: first.workspace.workspaceId, title: 'renamed' })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { title: 'renamed' },
    })

    const second = await controller.create({ path: stageDir(root, 'second') })
    await expect(nextFrame(iterator)).resolves.toMatchObject({
      type: 'upsert', workspace: { workspaceId: second.workspace.workspaceId },
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order', workspaceIds: [second.workspace.workspaceId, first.workspace.workspaceId],
    })
    await controller.insertBefore({
      workspaceId: first.workspace.workspaceId,
      beforeWorkspaceId: second.workspace.workspaceId,
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order',
      workspaceIds: [first.workspace.workspaceId, second.workspace.workspaceId],
    })

    const session = ctx.sessions.create(SessionId('archived'), {
      meta: { cwd: first.workspace.path },
    })
    await controller.archiveSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'archived', archivedSessionIds: [session.id],
    })
    // Unarchive rides the same complete-set increment: no new frame type.
    await controller.unarchiveSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'archived', archivedSessionIds: [],
    })
    await controller.pinSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'pinned', pinnedSessionIds: [session.id],
    })
    // Unpin rides the same complete-set increment: no new frame type.
    await controller.unpinSession({ sessionId: session.id })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'pinned', pinnedSessionIds: [],
    })
    await controller.delete({ workspaceId: second.workspace.workspaceId })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'order', workspaceIds: [first.workspace.workspaceId],
    })
    await expect(nextFrame(iterator)).resolves.toEqual({
      type: 'remove', workspaceId: second.workspace.workspaceId,
    })

    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ignores unrelated domain writes and closes active followers on disposal', async () => {
    const { controller, ctx, root } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    ctx.emit('domain/changed', {
      domain: 'other', table: 'records', key: 'x', operation: 'put', value: {},
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: '', key: '', operation: 'deleted',
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: 'other', key: 'x', operation: 'put', value: {},
    })
    ctx.emit('domain/changed', {
      domain: 'workspace', table: 'workspaces', key: 'unknown', operation: 'deleted',
    })
    const pending = iterator.next()
    const created = await controller.create({ path: stageDir(root, 'visible') })
    await expect(pending).resolves.toMatchObject({ value: { type: 'upsert' } })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'order', workspaceIds: [created.workspace.workspaceId] },
    })

    const closing = iterator.next()
    await ctx.fiber.dispose()
    roots.splice(roots.indexOf(ctx), 1)
    await expect(closing).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('first-use Remote', () => {
  it('reuses an initialized Workspace without looking up system Documents', async () => {
    const { controller, ctx, root } = await harness({ systemDocuments: true })
    const workspace = await ctx.workspaceRegistry.initializeDefault(async () => root)
    const signal = AbortSignal.abort()
    await expect(controller.initializeDefault(signal))
      .resolves.toMatchObject({ workspace: { workspaceId: workspace!.id, path: root, title: basename(root) } })
  })

  it('returns a durable Workspace named after its fixed directory without allocating a Session', async () => {
    const { controller, ctx, root } = await harness()
    const signal = new AbortController().signal
    const result = await controller.initializeDefault(signal)
    expect(result!.workspace.path).toBe(join(root, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY))
    expect(result!.workspace.title).toBe(DEFAULT_WORKSPACE_DIRECTORY)
    expect(existsSync(result!.workspace.path)).toBe(true)
    expect(ctx.sessions.list()).toEqual([])
    expect(await controller.initializeDefault(signal)).toEqual(result)
  })

  it('skips ineligible first use and propagates preparation failures', async () => {
    const { controller, ctx, root } = await harness()
    await ctx.workspaceRegistry.create(root)
    await expect(controller.initializeDefault(new AbortController().signal))
      .resolves.toBeUndefined()
    vi.spyOn(ctx.workspaceRegistry, 'initializeDefault').mockRejectedValueOnce(new Error('permission denied'))
    await expect(controller.initializeDefault(new AbortController().signal))
      .rejects.toThrow('permission denied')
  })
})

describe('Research catalog', () => {
  async function researchFixture(options: { nativeSessions?: boolean } = {}) {
    const fixture = await harness(options)
    const { workspace } = await fixture.controller.create({ path: fixture.root })
    const owner = fixture.ctx.workspaceRegistry.get(workspace.workspaceId)!
    writeFileSync(join(fixture.root, 'a.pdf'), '%PDF-1.7\nResearch fixture\n')
    for (const id of ['topic-agent', 'paper-a', 'paper-b']) {
      fixture.ctx.sessions.create(SessionId(id), { meta: { cwd: fixture.root } })
      await owner.attachSession(SessionId(id))
    }
    const catalog = await fixture.controller.researchCreateTopic({ title: 'Robot VLA', workspaceId: workspace.workspaceId, sessionId: SessionId('topic-agent') })
    return { ...fixture, topic: catalog.topics[0]!, workspace }
  }

  it('adds fresh paper conversations idempotently and retains shared paper resources', async () => {
    const { controller, topic, ctx, root } = await researchFixture()
    const before = await controller.researchCreatePaper({ topicId: topic.id, title: 'Several chats', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = before.papers[0]!
    const created = await controller.researchCreateConversation({ paperId: paper.id, sessionId: SessionId('paper-b') })
    expect(paperConversations(created.papers[0]!).map(item => item.sessionId)).toEqual([paper.sessionId, 'paper-b'])
    expect(created.papers[0]).toMatchObject({ id: paper.id, directory: paper.directory, ai: paper.ai, learning: paper.learning })
    expect(ctx.sessions.get(SessionId('paper-b'))!.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'data', 'agent-lib', 'library.json'), 'utf8'))).toMatchObject({ version: 4 })
    expect((await controller.researchCreateConversation({ paperId: paper.id, sessionId: SessionId('paper-b') })).revision).toBe(created.revision)
  })

  it('rejects conversation adoption of an existing history or another entity Session', async () => {
    const { controller, topic, ctx } = await researchFixture()
    const before = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = before.papers[0]!
    await expect(controller.researchCreateConversation({ paperId: paper.id, sessionId: topic.sessionId })).rejects.toMatchObject({ code: 'research/invalid' })
    ctx.sessions.get(SessionId('paper-b'))!.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Old question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await expect(controller.researchCreateConversation({ paperId: paper.id, sessionId: SessionId('paper-b') })).rejects.toMatchObject({ code: 'research/invalid' })
    expect(paperConversations((await controller.researchList()).papers[0]!)).toHaveLength(1)
  })

  it('persists conversation names, pins, archives and independent continuation points', async () => {
    const { controller, topic, ctx } = await researchFixture()
    const paper = (await controller.researchCreatePaper({ topicId: topic.id, title: 'A', repositoryUrl: '', sessionId: SessionId('paper-a') })).papers[0]!
    await controller.researchCreateConversation({ paperId: paper.id, sessionId: SessionId('paper-b') })
    const renamed = await controller.researchUpdateConversation({ paperId: paper.id, sessionId: SessionId('paper-b'), title: '  Architecture  ', expectedTitle: '', pinned: true })
    expect(renamed.papers[0]?.conversations?.[1]).toMatchObject({ title: 'Architecture', pinned: true })
    await expect(controller.researchUpdateConversation({ paperId: paper.id, sessionId: SessionId('paper-b'), title: 'Stale', expectedTitle: '' }))
      .rejects.toMatchObject({ code: 'research/conversation-conflict' })
    const progressed = await controller.researchProgress(paper.id, 'Review action head', SessionId('paper-b'))
    expect(progressed.papers[0]?.progress).toBe(paper.progress)
    expect(progressed.papers[0]?.conversations?.[1]?.progress).toBe('Review action head')
    const stop = ctx.on('workspace/session-activity', async (_request, next) => [...await next(), { kind: 'probe' as const }])
    await expect(controller.researchUpdateConversation({ paperId: paper.id, sessionId: SessionId('paper-b'), archived: true }))
      .rejects.toMatchObject({ code: 'research/conversation-busy' })
    stop()
    const archived = await controller.researchUpdateConversation({ paperId: paper.id, sessionId: SessionId('paper-b'), archived: true })
    expect(archived.papers[0]?.conversations?.[1]?.archived).toBe(true)
    const restored = await controller.researchUpdateConversation({ paperId: paper.id, sessionId: SessionId('paper-b'), archived: false })
    expect(restored.papers[0]?.conversations?.[1]).toMatchObject({ title: 'Architecture', pinned: true, archived: false, progress: 'Review action head' })
  })

  it('restores both conversation backups without replacing existing native histories', async () => {
    const { controller, topic, ctx, root } = await researchFixture({ nativeSessions: true })
    const paper = (await controller.researchCreatePaper({ topicId: topic.id, title: 'A', repositoryUrl: '', sessionId: SessionId('paper-a') })).papers[0]!
    const catalog = await controller.researchCreateConversation({ paperId: paper.id, sessionId: SessionId('paper-b') })
    for (const id of [paper.sessionId, SessionId('paper-b')]) {
      const session = ctx.sessions.get(id)!
      const filename = join(root, 'data', 'agent-lib', 'papers', paper.id, ...conversationBackup(paper, id))
      mkdirSync(join(filename, '..'), { recursive: true })
      writeFileSync(filename, JSON.stringify({ header: session.header, inheritedEventCount: 0, events: session.snapshotEvents() }))
    }
    const files = await ResearchFiles.open(join(root, 'data'), { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
    await restoreResearchSessions(ctx, files, catalog)
    expect(await ctx.sessionPersistence.stat(paper.sessionId)).toBeDefined()
    const before = await ctx.sessionPersistence.stat(SessionId('paper-b'))
    expect(before).toBeDefined()
    await restoreResearchSessions(ctx, files, catalog)
    expect((await ctx.sessionPersistence.stat(SessionId('paper-b')))?.revision).toBe(before?.revision)
  })

  it('renames a Topic durably while retaining its notes, Session and child-paper associations', async () => {
    const { controller, topic, root } = await researchFixture()
    await controller.researchTopicNote(topic.id, '# Reading order', 0)
    const before = await controller.researchCreatePaper({ topicId: topic.id, title: 'Child paper', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const request = { topicId: topic.id, title: '  VLA foundations  ', expectedTitle: topic.title }
    const renamed = await controller.researchRenameTopic(request)
    expect(renamed.topics[0]).toEqual({ ...before.topics[0], title: 'VLA foundations' })
    expect(renamed.papers).toEqual(before.papers)
    expect(renamed.revision).toBe(before.revision + 1)
    expect(JSON.parse(readFileSync(join(root, 'data', 'agent-lib', 'topics', topic.id, 'metadata.json'), 'utf8')))
      .toMatchObject({ id: topic.id, title: 'VLA foundations', sessionId: topic.sessionId })
    expect(readFileSync(join(root, 'data', 'topics', topic.id, 'notes.md'), 'utf8')).toBe('# Reading order')
    expect(JSON.parse(readFileSync(join(root, 'data', 'agent-lib', 'library.json'), 'utf8')))
      .toMatchObject({ topics: [{ id: topic.id, title: 'VLA foundations' }] })
    expect((await controller.researchList()).topics[0]?.title).toBe('VLA foundations')
    expect((await controller.researchRenameTopic(request)).revision).toBe(renamed.revision)
  })

  it('rejects blank, missing and stale Topic renames without replacing the current title', async () => {
    const { controller, topic } = await researchFixture()
    await expect(controller.researchRenameTopic({ topicId: topic.id, title: '   ', expectedTitle: topic.title }))
      .rejects.toMatchObject({ code: 'research/invalid', details: { field: 'title' } })
    await expect(controller.researchRenameTopic({ topicId: 'missing' as typeof topic.id, title: 'New name', expectedTitle: topic.title }))
      .rejects.toMatchObject({ code: 'research/not-found' })
    const renamed = await controller.researchRenameTopic({ topicId: topic.id, title: 'Another window', expectedTitle: topic.title })
    await expect(controller.researchRenameTopic({ topicId: topic.id, title: 'Stale edit', expectedTitle: topic.title }))
      .rejects.toMatchObject({ code: 'research/topic-conflict', details: { topicId: topic.id, title: 'Another window' } })
    expect(await controller.researchList()).toEqual(renamed)
  })

  it('deletes Topic-owned directories and conversations while retaining shared papers and their notes', async () => {
    const { controller, ctx, topic, root, workspace } = await researchFixture()
    ctx.sessions.create(SessionId('other-topic'), { meta: { cwd: root } })
    await ctx.workspaceRegistry.get(workspace.workspaceId)!.attachSession(SessionId('other-topic'))
    const otherCatalog = await controller.researchCreateTopic({ title: 'Other topic', workspaceId: workspace.workspaceId, sessionId: SessionId('other-topic') })
    const other = otherCatalog.topics.find(item => item.id !== topic.id)!
    const first = await controller.researchCreatePaper({ topicId: topic.id, title: 'Owned', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const owned = first.papers[0]!
    const second = await controller.researchCreatePaper({ topicId: topic.id, title: 'Shared', sourceId: '2406.09246', repositoryUrl: '', sessionId: SessionId('paper-b') })
    const shared = second.papers.find(item => item.id !== owned.id)!
    await controller.researchImportPaper({ topicId: other.id, title: 'Shared', sourceId: '2406.09246' }, new AbortController().signal)
    await controller.researchSaveNote({ paperId: shared.id, kind: 'ai', text: '# Retain me', expectedRevision: 0 })
    writeFileSync(join(root, 'data', 'topics', topic.id, 'notes.md'), '# Topic summary')
    const remaining = await controller.researchDeleteTopic({ topicId: topic.id, directory: join(root, 'data', 'topics', topic.id), papers: [{ paperId: owned.id, directory: owned.directory! }] })
    expect(remaining.topics.map(item => item.id)).toEqual([other.id])
    expect(remaining.papers).toHaveLength(1)
    expect(remaining.papers[0]).toMatchObject({ id: shared.id, topicIds: [other.id], ai: { text: '# Retain me' } })
    expect(existsSync(owned.directory!)).toBe(false)
    expect(existsSync(join(root, 'data', 'topics', topic.id))).toBe(false)
    expect(existsSync(join(root, 'data', 'agent-lib', 'topics', topic.id))).toBe(false)
    expect(existsSync(shared.directory!)).toBe(true)
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual(expect.arrayContaining([topic.sessionId, owned.sessionId]))
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(shared.sessionId)
    expect(ctx.sessions.get(owned.sessionId)).toBeDefined()
    expect((await controller.researchList()).papers).toEqual(remaining.papers)
  })

  it('refuses stale Topic contents, invalid paths and running work before archiving or deleting', async () => {
    const { controller, ctx, topic, root } = await researchFixture()
    const request = { topicId: topic.id, directory: join(root, 'data', 'topics', topic.id), papers: [] }
    await expect(controller.researchDeleteTopic({ ...request, directory: root })).rejects.toMatchObject({ code: 'research/delete-path-changed' })
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'New child', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]!
    await expect(controller.researchDeleteTopic(request)).rejects.toMatchObject({ code: 'research/topic-contents-changed' })
    ctx.on('workspace/session-activity', async (_request, next) => [...await next(), { kind: 'probe' as const }])
    await expect(controller.researchDeleteTopic({ ...request, papers: [{ paperId: paper.id, directory: paper.directory! }] }))
      .rejects.toMatchObject({ code: 'research/topic-busy' })
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(topic.sessionId)
    expect(existsSync(paper.directory!)).toBe(true)
    expect((await controller.researchList()).topics).toHaveLength(1)
  })

  it('deletes an empty Topic without removing its Workspace or allocating a replacement Session', async () => {
    const { controller, ctx, topic, root, workspace } = await researchFixture()
    const remaining = await controller.researchDeleteTopic({ topicId: topic.id, directory: join(root, 'data', 'topics', topic.id), papers: [] })
    expect(remaining.topics).toEqual([])
    expect(ctx.workspaceRegistry.get(workspace.workspaceId)).toBeDefined()
    expect(existsSync(root)).toBe(true)
    expect(ctx.sessions.get(topic.sessionId)).toBeDefined()
  })

  it('deletes a confirmed paper, archives its Session and publishes the remaining library', async () => {
    const { controller, ctx, topic } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'Delete me', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]!
    await expect(controller.researchDeletePaper({ paperId: paper.id, directory: topic.title })).rejects.toMatchObject({ code: 'research/delete-path-changed' })
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(paper.sessionId)
    const remaining = await controller.researchDeletePaper({ paperId: paper.id, directory: paper.directory! })
    expect(remaining.papers).toEqual([])
    expect(remaining.topics).toHaveLength(1)
    expect(existsSync(paper.directory!)).toBe(false)
    expect(ctx.workspaceRegistry.archivedSessionIds).toContain(paper.sessionId)
    expect(ctx.sessions.get(paper.sessionId)).toBeDefined()
    await expect(controller.researchList()).resolves.toMatchObject({ papers: [] })
  })

  it('refuses deletion while Session activity is reported and retains the entity and files', async () => {
    const { controller, ctx, topic } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'Busy paper', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]!
    ctx.on('workspace/session-activity', async (_request, next) => [...await next(), { kind: 'probe' as const }])
    await expect(controller.researchDeletePaper({ paperId: paper.id, directory: paper.directory! })).rejects.toMatchObject({ code: 'research/paper-busy' })
    expect(existsSync(paper.directory!)).toBe(true)
    expect((await controller.researchList()).papers.map(item => item.id)).toContain(paper.id)
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(paper.sessionId)
  })

  it('automatically publishes whole-paper Markdown, backfills legacy metadata and retains it on migration', async () => {
    const { controller, topic, root } = await researchFixture()
    writeFileSync(join(root, 'a.pdf'), pdfFixture())
    const created = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = created.papers[0]!, markdownPath = join(paper.directory!, 'paper_A.md')
    const expected = '## Page 1\n\nSelectable PDF text\n\n## Page 2\n\nSelectable PDF text\n'
    expect(readFileSync(markdownPath, 'utf8')).toBe(expected)
    expect(paper.markdown).toMatchObject({ status: 'ready', pages: 2, backend: 'pdfjs', sourceSha256: paper.pdfSha256 })
    const unchanged = await Promise.all([controller.researchList(), controller.researchList()])
    expect(unchanged.map(item => item.revision)).toEqual([created.revision, created.revision])
    const indexPath = join(root, 'data', 'agent-lib', 'library.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { papers: Array<{ markdown?: unknown; pdfSha256?: string }> }
    delete index.papers[0]!.markdown; delete index.papers[0]!.pdfSha256
    writeFileSync(indexPath, JSON.stringify(index)); rmSync(markdownPath)
    const backfilled = await controller.researchList()
    expect(backfilled.papers[0]?.markdown).toMatchObject({ status: 'ready', path: 'paper_A.md' })
    expect(readFileSync(markdownPath, 'utf8')).toBe(expected)
    expect((await controller.researchList()).revision).toBe(backfilled.revision)
    const moved = await controller.researchConfigure({ directory: join(root, 'markdown-library'), mode: 'migrate' })
    expect(moved.papers[0]?.markdown).toEqual(backfilled.papers[0]?.markdown)
    expect(readFileSync(join(moved.papers[0]!.directory!, 'paper_A.md'), 'utf8')).toBe(expected)
  })

  it('detaches a deleted original without recreating files and resumes after explicit attachment', async () => {
    const { controller, topic, root } = await researchFixture()
    const bytes = pdfFixture()
    writeFileSync(join(root, 'a.pdf'), bytes)
    const created = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = created.papers[0]!, markdownPath = join(paper.directory!, 'paper_A.md')
    await controller.researchSaveNote({ paperId: paper.id, kind: 'ai', text: 'Existing notes', expectedRevision: 0 })
    rmSync(paper.pdfPath); rmSync(markdownPath)
    const failed = await controller.researchList()
    expect(failed.papers[0]?.pdfPath).toBe('')
    expect(failed.papers[0]?.markdown).toBeUndefined()
    writeFileSync(paper.pdfPath, bytes)
    expect((await controller.researchList()).revision).toBe(failed.revision)
    expect(existsSync(markdownPath)).toBe(false)
    await expect(controller.researchExtractMarkdown(paper.id)).rejects.toMatchObject({ code: 'research/invalid' })
    const retried = await controller.researchAttachPdf({ paperId: paper.id, source: paper.pdfPath, abbreviation: 'A' }, new AbortController().signal)
    expect(retried.papers[0]).toMatchObject({ id: paper.id, sessionId: paper.sessionId,
      ai: { text: 'Existing notes', revision: 1 }, markdown: { status: 'ready', pages: 2 } })
    expect(readFileSync(markdownPath, 'utf8')).toContain('## Page 2')
    expect(readFileSync(paper.pdfPath)).toEqual(Buffer.from(bytes))
    await expect(controller.researchExtractMarkdown('missing' as ResearchPaperId)).rejects.toMatchObject({ code: 'research/not-found' })
  })

  it('preserves an unparseable PDF and notebooks while recording the extraction failure', async () => {
    const { controller, topic, root } = await researchFixture()
    const created = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = created.papers[0]!
    expect(paper.markdown).toMatchObject({ status: 'failed', code: 'conversion-failed' })
    expect(readFileSync(paper.pdfPath)).toEqual(readFileSync(join(root, 'a.pdf')))
    expect(existsSync(join(paper.directory!, 'paper_A.md'))).toBe(false)
    await controller.researchSaveNote({ paperId: paper.id, kind: 'learning', text: 'Retained draft', expectedRevision: 0 })
    expect((await controller.researchExtractMarkdown(paper.id)).papers[0]?.learning.text).toBe('Retained draft')
  })

  it('creates distinct papers without PDFs and retains their empty original state after migration and reopening', async () => {
    const { controller, topic, root } = await researchFixture()
    const first = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const second = await controller.researchCreatePaper({ topicId: topic.id, title: 'B', pdfPath: '  ', repositoryUrl: '', sessionId: SessionId('paper-b') })
    expect(second.papers).toHaveLength(2)
    expect(second.papers.every(paper => paper.pdfPath === '' && paper.pdfSha256 === undefined)).toBe(true)
    expect(second.papers.every(paper => paper.markdown === undefined)).toBe(true)
    const paper = first.papers[0]!
    expect(readdirSync(paper.directory!)).toEqual([])
    expect(existsSync(join(paper.directory!, 'paper.pdf'))).toBe(false)
    await expect(controller.researchReadPaper({ paperId: paper.id }, new AbortController().signal))
      .rejects.toThrow('research_attach_pdf')
    await controller.researchSaveNote({ paperId: paper.id, kind: 'learning', text: 'Questions before reading', expectedRevision: 0 })
    const moved = await controller.researchConfigure({ directory: join(root, 'moved-data'), mode: 'migrate' })
    expect(moved.papers[0]).toMatchObject({ id: paper.id, sessionId: paper.sessionId, pdfPath: '', learning: { text: 'Questions before reading' } })
    await controller.researchConfigure({ directory: join(root, 'data'), mode: 'open' })
    expect((await controller.researchList()).papers.map(item => item.pdfPath)).toEqual(['', ''])
  })

  it('names related originals from the Agent acronym and retains Sessions when user contents are deleted', async () => {
    const { controller, topic, root } = await researchFixture()
    writeFileSync(join(root, 'a.pdf'), pdfFixture())
    const empty = await controller.researchCreatePaper({ topicId: topic.id, title: 'A long robotics paper title',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = empty.papers[0]!, signal = new AbortController().signal
    expect((await controller.researchListFiles({ paperId: paper.id, path: '' })).entries).toEqual([])
    await expect(controller.researchAttachPdf({ paperId: paper.id, source: join(root, 'a.pdf'), abbreviation: '../escape' }, signal))
      .rejects.toMatchObject({ code: 'research/invalid', details: { field: 'abbreviation' } })
    const attached = await controller.researchAttachPdf({ paperId: paper.id, source: join(root, 'a.pdf'), abbreviation: 'OpenVLA' }, signal)
    expect(attached.papers[0]?.pdfPath).toBe(join(paper.directory!, 'paper_OpenVLA.pdf'))
    expect(attached.papers[0]?.markdown).toMatchObject({ status: 'ready', path: 'paper_OpenVLA.md' })
    expect((await controller.researchListFiles({ paperId: paper.id, path: '' })).entries.map(item => item.name))
      .toEqual(['paper_OpenVLA.json', 'paper_OpenVLA.md', 'paper_OpenVLA.pdf'])
    expect(JSON.parse(readFileSync(join(paper.directory!, 'paper_OpenVLA.json'), 'utf8'))).toEqual({
      title: paper.title, abbreviation: 'OpenVLA', sourceId: '', source: join(root, 'a.pdf'), repositoryUrl: '',
      pdf: 'paper_OpenVLA.pdf', markdown: 'paper_OpenVLA.md',
    })
    mkdirSync(join(paper.directory!, 'experiments', 'trial-1'), { recursive: true })
    writeFileSync(join(paper.directory!, 'experiments', 'trial-1', 'custom.md'), '# Custom organization')
    rmSync(join(paper.directory!, 'paper_OpenVLA.md'))
    rmSync(join(paper.directory!, 'paper_OpenVLA.json'))
    const refreshed = await controller.researchList()
    expect(refreshed.papers[0]).toMatchObject({ id: paper.id, sessionId: paper.sessionId })
    expect(readdirSync(paper.directory!)).toEqual(['experiments', 'paper_OpenVLA.pdf'])
    expect((await controller.researchReadFile({ paperId: paper.id, path: 'experiments/trial-1/custom.md' })))
      .toMatchObject({ kind: 'text', text: '# Custom organization', editable: true })
    await controller.researchExtractMarkdown(paper.id)
    expect(existsSync(join(paper.directory!, 'paper_OpenVLA.md'))).toBe(true)
    rmSync(join(paper.directory!, 'paper_OpenVLA.pdf'))
    expect((await controller.researchList()).papers[0]?.pdfPath).toBe('')
    const suppliedAgain = await controller.researchImportPaper({ topicId: topic.id, title: paper.title,
      source: join(root, 'a.pdf'), abbreviation: 'OpenVLA' }, signal)
    expect(suppliedAgain.paperId).toBe(paper.id)
    expect(suppliedAgain.catalog.papers).toHaveLength(1)
    expect(suppliedAgain.catalog.papers[0]?.pdfPath).toBe(join(paper.directory!, 'paper_OpenVLA.pdf'))
  })

  it('retains a same-named user Markdown document until the reader moves it before conversion', async () => {
    const { controller, topic, root } = await researchFixture()
    const original = pdfFixture()
    writeFileSync(join(root, 'a.pdf'), original)
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'Core paper',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]!, destination = join(paper.directory!, 'paper_Core.md')
    writeFileSync(destination, '# My own notes')
    const attached = await controller.researchAttachPdf({ paperId: paper.id, source: join(root, 'a.pdf'), abbreviation: 'Core' }, new AbortController().signal)
    expect(attached.papers[0]?.markdown).toMatchObject({ status: 'failed', code: 'output-conflict' })
    expect(readFileSync(destination, 'utf8')).toBe('# My own notes')
    expect((await controller.researchList()).papers[0]?.markdown).toEqual(attached.papers[0]?.markdown)
    renameSync(destination, join(paper.directory!, 'my-notes.md'))
    const recovered = await controller.researchExtractMarkdown(paper.id)
    expect(recovered.papers[0]?.markdown).toMatchObject({ status: 'ready', path: 'paper_Core.md' })
    expect(readFileSync(join(paper.directory!, 'my-notes.md'), 'utf8')).toBe('# My own notes')
    expect(readFileSync(destination, 'utf8')).toContain('Selectable PDF text')
  })

  it('keeps original documents in user-selected folders and reassociates moved originals without root copies', async () => {
    const { controller, topic, root } = await researchFixture()
    writeFileSync(join(root, 'a.pdf'), pdfFixture())
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'Flexible paper',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]!, signal = new AbortController().signal
    await expect(controller.researchAttachPdf({ paperId: paper.id, source: join(root, 'a.pdf'), folder: '../../outside', abbreviation: 'VLA' }, signal))
      .rejects.toMatchObject({ code: 'research/invalid-library' })
    const attached = await controller.researchAttachPdf({ paperId: paper.id, source: join(root, 'a.pdf'), folder: 'originals', abbreviation: 'VLA' }, signal)
    expect(attached.papers[0]?.pdfPath).toBe(join(paper.directory!, 'originals', 'paper_VLA.pdf'))
    expect(attached.papers[0]?.markdown).toMatchObject({ status: 'ready', path: 'originals/paper_VLA.md' })
    expect(readdirSync(paper.directory!)).toEqual(['originals'])
    expect(readdirSync(join(paper.directory!, 'originals'))).toEqual(['paper_VLA.json', 'paper_VLA.md', 'paper_VLA.pdf'])
    renameSync(join(paper.directory!, 'originals'), join(paper.directory!, 'sources'))
    await controller.researchList()
    const moved = await controller.researchAttachPdf({ paperId: paper.id, source: 'sources/paper_VLA.pdf', abbreviation: 'VLA' }, signal)
    expect(moved.papers[0]).toMatchObject({ id: paper.id, sessionId: paper.sessionId, markdown: { status: 'ready', path: 'sources/paper_VLA.md' } })
    expect(moved.papers[0]?.pdfPath).toBe(join(paper.directory!, 'sources', 'paper_VLA.pdf'))
    expect(readdirSync(paper.directory!)).toEqual(['sources'])
  })

  it('attaches an original to the same paper and preserves notebooks on invalid sources, retries and replacement attempts', async () => {
    const { controller, topic, root } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]!, signal = new AbortController().signal
    await controller.researchSaveNote({ paperId: paper.id, kind: 'ai', text: 'Existing analysis', expectedRevision: 0 })
    writeFileSync(join(root, 'invalid.pdf'), '<html>Download page</html>')
    await expect(controller.researchAttachPdf({ paperId: paper.id, source: join(root, 'invalid.pdf') }, signal))
      .rejects.toMatchObject({ code: 'research/invalid' })
    expect((await controller.researchList()).papers[0]?.pdfPath).toBe('')
    const original = pdfFixture(3)
    const source = join(paper.directory!, 'download.pdf')
    writeFileSync(source, original)
    const attached = await controller.researchAttachPdf({ paperId: paper.id, source: 'download.pdf' }, signal)
    expect(attached.papers).toHaveLength(1)
    expect(attached.papers[0]).toMatchObject({ id: paper.id, sessionId: paper.sessionId, directory: paper.directory,
      ai: { text: 'Existing analysis', revision: 1 }, pdfSha256: digest(original) })
    expect(readFileSync(attached.papers[0]!.pdfPath)).toEqual(Buffer.from(original))
    expect(attached.papers[0]?.markdown).toMatchObject({ status: 'ready', path: 'paper_A.md', pages: 2, sourceSha256: digest(original) })
    expect(readFileSync(join(paper.directory!, 'paper_A.md'), 'utf8')).toContain('## Page 2\n\nSelectable PDF text')
    expect((await controller.researchReadPaper({ paperId: paper.id, startPage: 1, pageCount: 1 }, signal)).pages[0]?.text).toContain('Selectable PDF text')
    expect(await controller.researchAttachPdf({ paperId: paper.id, source }, signal)).toEqual(attached)
    writeFileSync(source, pdfFixture(4))
    await expect(controller.researchAttachPdf({ paperId: paper.id, source }, signal)).rejects.toMatchObject({ code: 'research/invalid' })
    expect(readFileSync(attached.papers[0]!.pdfPath)).toEqual(Buffer.from(original))
    expect((await controller.researchList()).papers[0]?.ai.text).toBe('Existing analysis')
  })

  it('keeps topic and paper sessions independent and rejects reusing another entity session', async () => {
    const { controller, topic } = await researchFixture()
    await expect(controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: topic.sessionId }))
      .rejects.toMatchObject({ code: 'research/invalid' })
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    expect(catalog.papers[0]!.sessionId).not.toBe(topic.sessionId)
    expect(catalog.papers[0]).toMatchObject({ topicIds: [topic.id], ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } })
    const retry = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    expect(retry).toEqual(catalog)
  })

  it('persists independent highlights, handles retries, and carries them with migrated paper metadata', async () => {
    const { controller, topic, root } = await researchFixture()
    const created = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = created.papers[0]!
    const make = (id: string): ResearchHighlight => ({ id: id as ResearchHighlightId, color: 'yellow', text: 'Selected method',
      rects: [{ page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, { page: 2, x: 0.1, y: 0.1, width: 0.3, height: 0.04 }] })
    const first = make('first'), second = make('second')
    await Promise.all([first, second].map(highlight => controller.researchHighlight({ paperId: paper.id, change: { type: 'add', highlight } })))
    const confirmed = await controller.researchList()
    expect(confirmed.capabilities).toMatchObject({ pdfHighlights: true, paperConversations: true })
    expect(JSON.parse(readFileSync(join(root, 'data', 'agent-lib', 'library.json'), 'utf8')) as { capabilities?: object }).not.toHaveProperty('capabilities')
    expect(confirmed.papers[0]?.highlights).toEqual([first, second])
    expect((JSON.parse(readFileSync(join(root, 'data', 'agent-lib', 'papers', paper.id, 'metadata.json'), 'utf8')) as { highlights: ResearchHighlight[] }).highlights).toEqual([first, second])
    expect((await controller.researchHighlight({ paperId: paper.id, change: { type: 'add', highlight: first } })).revision).toBe(confirmed.revision)
    await expect(controller.researchHighlight({ paperId: paper.id, change: { type: 'add', highlight: { ...first, color: 'blue' } } }))
      .rejects.toMatchObject({ code: 'research/invalid' })
    const moved = await controller.researchConfigure({ directory: join(root, 'highlight-library'), mode: 'migrate' })
    expect(moved.papers[0]?.highlights).toEqual([first, second])
    await controller.researchHighlight({ paperId: paper.id, change: { type: 'remove', id: first.id } })
    const remaining = await controller.researchList()
    expect(remaining.papers[0]?.highlights).toEqual([second])
    expect((await controller.researchHighlight({ paperId: paper.id, change: { type: 'remove', id: first.id } })).revision).toBe(remaining.revision)
    const reopened = await controller.researchConfigure({ directory: join(root, 'data'), mode: 'open' })
    expect(reopened.papers[0]?.highlights).toEqual([first, second])
  })

  it('rejects highlights outside page coordinates or the configured budget and preserves confirmed data', async () => {
    const { controller, topic } = await researchFixture()
    const created = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = created.papers[0]!
    const valid: ResearchHighlight = { id: 'bounded' as ResearchHighlightId, color: 'green', text: 'Method',
      rects: [{ page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] }
    for (const rect of [{ ...valid.rects[0]!, page: 0 }, { ...valid.rects[0]!, x: -0.1 }, { ...valid.rects[0]!, width: 1 }]) {
      await expect(controller.researchHighlight({ paperId: paper.id, change: { type: 'add', highlight: { ...valid, rects: [rect] } } }))
        .rejects.toMatchObject({ code: 'research/invalid' })
    }
    await expect(controller.researchHighlight({ paperId: paper.id, change: { type: 'add', highlight: { ...valid, text: 'x'.repeat(4 * 1024 * 1024) } } }))
      .rejects.toMatchObject({ code: 'research/invalid' })
    expect((await controller.researchList()).papers[0]?.highlights).toBeUndefined()
    await expect(controller.researchHighlight({ paperId: 'missing' as ResearchPaperId, change: { type: 'add', highlight: valid } }))
      .rejects.toMatchObject({ code: 'research/not-found' })
    const blank = await controller.researchCreatePaper({ topicId: topic.id, title: 'B', repositoryUrl: '', sessionId: SessionId('paper-b') })
    await expect(controller.researchHighlight({ paperId: blank.papers.find(item => item.title === 'B')!.id, change: { type: 'add', highlight: valid } }))
      .rejects.toMatchObject({ code: 'research/invalid', details: { field: 'pdfPath' } })
  })

  it('saves AI and learning notebooks separately and rejects stale concurrent writes without losing saved data', async () => {
    const { controller, topic } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paperId = catalog.papers[0]!.id
    const concurrent = await Promise.allSettled([
      controller.researchSaveNote({ paperId, kind: 'learning', text: '# My reading notes', expectedRevision: 0 }),
      controller.researchSaveNote({ paperId, kind: 'learning', text: 'Stale edit', expectedRevision: 0 }),
    ])
    expect(concurrent.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(concurrent[1]).toMatchObject({ reason: { code: 'research/note-conflict' } })
    await controller.researchSaveNote({ paperId, kind: 'ai', text: 'Agent explanation', expectedRevision: 0 })
    expect((await controller.researchList()).papers[0]).toMatchObject({ learning: { text: '# My reading notes', revision: 1 }, ai: { text: 'Agent explanation', revision: 1 } })
  })

  it('returns canonical references to paper sessions and rejects missing papers and unsafe metadata', async () => {
    const { controller, topic } = await researchFixture()
    await expect(controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: 'javascript:alert(1)', sessionId: SessionId('paper-a') }))
      .rejects.toMatchObject({ code: 'research/invalid', details: { field: 'repositoryUrl' } })
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf', repositoryUrl: 'https://github.com/example/vla', sessionId: SessionId('paper-a') })
    const [mention] = await controller.researchMentions([catalog.papers[0]!.id])
    expect(mention).toBe('@[A](dsh-session:InBhcGVyLWEi)')
    await expect(controller.researchMentions(Array(4).fill(catalog.papers[0]!.id))).rejects.toMatchObject({ code: 'research/invalid' })
  })

  it('copies original PDFs and stores notebook bodies only in the managed Markdown files', async () => {
    const { controller, topic, root } = await researchFixture()
    const source = join(root, 'a.pdf')
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: source,
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]
    if (paper === undefined) throw new Error('paper must be created')
    expect(paper.directory).toBe(join(root, 'data', 'papers', 'A'))
    expect(readFileSync(paper.pdfPath)).toEqual(readFileSync(source))
    await controller.researchSaveNote({ paperId: paper.id, kind: 'ai', text: '# Agent notebook', expectedRevision: 0 })
    expect(readFileSync(join(paper.directory!, 'notes', 'ai.md'), 'utf8')).toBe('# Agent notebook')
    expect(readFileSync(join(root, 'data', 'agent-lib', 'library.json'), 'utf8')).not.toContain('# Agent notebook')
    expect(readFileSync(source, 'utf8')).toContain('Research fixture')
  })

  it('pushes external Markdown edits and rejects an edit based on the previous revision', async () => {
    const { controller, topic } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]
    if (paper === undefined) throw new Error('paper must be created')
    const lifetime = new AbortController()
    const stream = controller.researchFollow(lifetime.signal)[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ type: 'baseline' })
      const next = stream.next()
      mkdirSync(join(paper.directory!, 'notes'), { recursive: true })
      writeFileSync(join(paper.directory!, 'notes', 'ai.md'), '# External notebook')
      const update = await next
      expect(update.value).toMatchObject({ type: 'changed', catalog: { papers: [{ ai: { text: '# External notebook', revision: 1 } }] } })
      await expect(controller.researchSaveNote({ paperId: paper.id, kind: 'ai', text: 'Old draft', expectedRevision: 0 }))
        .rejects.toMatchObject({ code: 'research/note-conflict' })
      expect(readFileSync(join(paper.directory!, 'notes', 'ai.md'), 'utf8')).toBe('# External notebook')
    } finally { lifetime.abort(); await stream.return?.() }
  })

  it('migrates a library to an empty directory while retaining the source and paper identities', async () => {
    const { controller, topic, root } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]
    if (paper === undefined) throw new Error('paper must be created')
    await controller.researchSaveNote({ paperId: paper.id, kind: 'learning', text: 'Portable notes', expectedRevision: 0 })
    const moved = await controller.researchConfigure({ directory: join(root, 'moved-data'), mode: 'migrate' })
    expect(moved.directory).toBe(join(root, 'moved-data'))
    expect(moved.papers[0]).toMatchObject({ id: paper.id, sessionId: paper.sessionId, learning: { text: 'Portable notes' } })
    expect(moved.papers[0]?.pdfPath).toBe(join(root, 'moved-data', 'papers', 'A', 'paper_A.pdf'))
    expect(readFileSync(join(paper.directory!, 'notes', 'learning.md'), 'utf8')).toBe('Portable notes')
    const reopened = await controller.researchConfigure({ directory: join(root, 'data'), mode: 'open' })
    expect(reopened.papers[0]?.id).toBe(paper.id)
    await expect(controller.researchConfigure({ directory: join(root, 'data', 'nested'), mode: 'migrate' }))
      .rejects.toMatchObject({ code: 'research/invalid' })
  })

  it('reuses matching PDF bytes across topics and extracts original text with page numbers', async () => {
    const { controller, topic, root, workspace, ctx } = await researchFixture()
    writeFileSync(join(root, 'a.pdf'), pdfFixture(3))
    const first = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const nextTopic = await controller.researchCreateTopic({ title: 'Other topic', workspaceId: workspace.workspaceId, sessionId: SessionId('paper-b') })
    const other = nextTopic.topics.find(item => item.title === 'Other topic')
    const paper = first.papers[0]
    if (other === undefined || paper === undefined) throw new Error('both research entities must exist')
    ctx.sessions.create(SessionId('paper-c'), { meta: { cwd: root } })
    const owner = ctx.workspaceRegistry.get(workspace.workspaceId)
    if (owner === undefined) throw new Error('the fixture workspace must exist')
    await owner.attachSession(SessionId('paper-c'))
    const reused = await controller.researchCreatePaper({ topicId: other.id, title: 'Duplicate', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-c') })
    expect(reused.papers).toHaveLength(1)
    expect(reused.papers[0]?.topicIds).toEqual([topic.id, other.id])
    const text = await controller.researchReadPaper({ paperId: paper.id, startPage: 1, pageCount: 2 }, new AbortController().signal)
    expect(text.totalPages).toBe(2)
    expect(text.pages.map(page => page.page)).toEqual([1, 2])
    expect(text.pages.every(page => page.text.includes('Selectable PDF text'))).toBe(true)
    expect(existsSync(join(root, 'data', 'agent-lib', 'papers', paper.id, 'extracted', 'pages-1.json'))).toBe(true)
  })

  it('restores a missing native Session from the library snapshot without replacing a stored log', async () => {
    const { controller, topic, root, ctx } = await researchFixture({ nativeSessions: true })
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0], existing = ctx.sessions.get(SessionId('paper-a'))
    if (paper === undefined || existing === undefined) throw new Error('the paper Session must exist')
    const detached = Session.fromRestore(existing.id, [], existing.header, SessionLogOffset(0), 'detached')
    detached.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Explain the method' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    writeFileSync(join(root, 'data', 'agent-lib', 'papers', paper.id, 'session.json'), JSON.stringify({
      header: detached.header, inheritedEventCount: 0, events: detached.snapshotEvents(),
    }))
    await controller.researchConfigure({ directory: join(root, 'empty-library'), mode: 'open' })
    await controller.researchConfigure({ directory: join(root, 'data'), mode: 'open' })
    const handle = await ctx.sessionPersistence.open(paper.sessionId, 'read')
    try { expect((await handle.read()).events).toEqual(detached.snapshotEvents()) } finally { await handle.close() }
    const before = await ctx.sessionPersistence.stat(paper.sessionId)
    await controller.researchConfigure({ directory: join(root, 'empty-library'), mode: 'open' })
    await controller.researchConfigure({ directory: join(root, 'data'), mode: 'open' })
    expect((await ctx.sessionPersistence.stat(paper.sessionId))?.revision).toBe(before?.revision)
  })

  it('rejects an external edit made after a mutation read without overwriting its Markdown', async () => {
    const { controller, topic, root } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]
    if (paper === undefined) throw new Error('the paper must exist')
    const path = join(paper.directory!, 'notes', 'ai.md')
    const files = await ResearchFiles.open(join(root, 'data'), { maxNoteBytes: 1024, lockTimeoutMs: 1000 })
    await files.withLock(async () => {
      const previous = await files.read()
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'External editor text')
      await expect(files.write({ ...previous, papers: previous.papers.map(item => ({ ...item, ai: { text: 'Stale Agent text', revision: 1 } })) }, previous))
        .rejects.toMatchObject({ code: 'research/invalid-library' })
      expect(readFileSync(path, 'utf8')).toBe('External editor text')
    })
  })

  it('recovers interrupted notebook publication and retains conflicting external edits', async () => {
    const { controller, topic, root } = await researchFixture()
    const catalog = await controller.researchCreatePaper({ topicId: topic.id, title: 'A', pdfPath: 'a.pdf',
      repositoryUrl: '', sessionId: SessionId('paper-a') })
    const paper = catalog.papers[0]
    if (paper === undefined) throw new Error('the paper must exist')
    const directory = join(root, 'data'), path = join(paper.directory!, 'notes', 'ai.md')
    const files = await ResearchFiles.open(directory, { maxNoteBytes: 1024, lockTimeoutMs: 1000 })
    await files.withLock(async () => {
      const index: unknown = JSON.parse(readFileSync(join(directory, 'agent-lib', 'library.json'), 'utf8'))
      const journalPath = join(directory, 'agent-lib', '.transaction.json')
      const journal = { index, writes: [{ kind: 'ai', id: paper.id, previous: null, text: 'Recovered analysis' }] }
      writeFileSync(journalPath, JSON.stringify(journal))
      expect((await files.read()).papers[0]?.ai.text).toBe('Recovered analysis')
      expect(existsSync(journalPath)).toBe(false)
      writeFileSync(journalPath, JSON.stringify(journal))
      writeFileSync(path, 'External edit after the interrupted write')
      await expect(files.read()).rejects.toMatchObject({ code: 'research/invalid-library' })
      expect(readFileSync(path, 'utf8')).toBe('External edit after the interrupted write')
      expect(existsSync(journalPath)).toBe(true)
    })
  })
})
