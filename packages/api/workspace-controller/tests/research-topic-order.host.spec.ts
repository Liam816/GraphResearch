/** Topic ordering persists through the existing catalog transaction and rejects stale directory changes. */
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceController from '../src/index.ts'
import { ResearchFiles } from '../src/research-files.ts'
import type { ResearchTopicId } from '../src/research-types.ts'

const fixtures: { root: string; ctx: Context }[] = []
afterEach(async () => {
  for (const { root, ctx } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-topic-order-')))
  const ctx = new Context()
  fixtures.push({ root, ctx })
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domains = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domains)
  ctx.provide('storageDomain', domains)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native-sessions'), compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} },
  } as never)
  const controller = new WorkspaceController(ctx, { documentsDirectory: root,
    researchDirectory: join(root, 'data'), researchPdfTextBackend: 'pdfjs' })
  const { workspace } = await controller.create({ path: root })
  const create = async (title: string) => {
    const sessionId = SessionId(`topic-${ctx.sessions.list().length}`)
    ctx.sessions.create(sessionId, { meta: { cwd: root } })
    await ctx.workspaceRegistry.get(workspace.workspaceId)!.attachSession(sessionId)
    return controller.researchCreateTopic({ title, workspaceId: workspace.workspaceId, sessionId })
  }
  await create('VLA')
  await create('Diffusion')
  const catalog = await create('Memory')
  return { root, ctx, controller, create, catalog }
}

it('persists directory Topic order without changing Topic identities, notes or Sessions', async () => {
  const { root, ctx, controller, catalog, create } = await fixture()
  const topic = catalog.topics[0]!
  const paperSession = SessionId('paper-owner')
  ctx.sessions.create(paperSession, { meta: { cwd: root } })
  await ctx.workspaceRegistry.get(topic.workspaceId)!.attachSession(paperSession)
  const added = await controller.researchCreatePaper({ topicId: topic.id, title: 'Keep paper', repositoryUrl: '', sessionId: paperSession })
  const paperId = added.papers[0]!.id
  const before = await controller.researchSaveNote({ paperId, kind: 'ai', text: '# Preserve this paper', expectedRevision: 0 })
  const ids = catalog.topics.map(topic => topic.id)
  const request = { topicIds: [ids[2]!, ids[0]!, ids[1]!], expectedTopicIds: ids }
  const saved = await controller.researchReorderTopics(request)
  expect(saved.topics).toEqual([catalog.topics[2], catalog.topics[0], catalog.topics[1]])
  expect(saved.papers).toEqual(before.papers)
  expect(await readFile(join(before.papers[0]!.directory!, 'notes', 'ai.md'), 'utf8')).toBe('# Preserve this paper')
  expect(saved.revision).toBe(before.revision + 1)
  const files = await ResearchFiles.open(join(root, 'data'), { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
  const reopened = await files.withLock(() => files.read())
  expect(reopened.topics).toEqual(saved.topics)
  expect((await controller.researchReorderTopics(request)).revision).toBe(saved.revision)
  const appended = await create('New Topic')
  expect(appended.topics.slice(0, 3)).toEqual(saved.topics)
  expect(appended.topics[3]?.title).toBe('New Topic')
})

it('rejects incomplete, duplicate or foreign Topic permutations without writing', async () => {
  const { root, controller, catalog } = await fixture()
  const ids = catalog.topics.map(topic => topic.id)
  const files = await ResearchFiles.open(join(root, 'data'), { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
  const index = await files.runtimePath('library.json')
  const before = await readFile(index, 'utf8')
  for (const topicIds of [[], ids.slice(0, 2), [ids[0]!, ids[0]!, ids[2]!],
    [ids[0]!, ids[1]!, brandString<ResearchTopicId>('missing-topic')]]) {
    await expect(controller.researchReorderTopics({ topicIds, expectedTopicIds: ids }))
      .rejects.toMatchObject({ code: 'research/invalid', details: { field: 'topicIds' } })
    expect(await readFile(index, 'utf8')).toBe(before)
  }
})

it('rejects a stale Topic order and membership change while accepting an already committed retry', async () => {
  const { controller, catalog, create } = await fixture()
  const ids = catalog.topics.map(topic => topic.id)
  const reversed = [...ids].reverse()
  const saved = await controller.researchReorderTopics({ topicIds: reversed, expectedTopicIds: ids })
  await expect(controller.researchReorderTopics({ topicIds: ids, expectedTopicIds: ids }))
    .rejects.toMatchObject({ code: 'research/topic-order-conflict', details: { topicIds: reversed } })
  expect((await controller.researchReorderTopics({ topicIds: reversed, expectedTopicIds: ids })).revision).toBe(saved.revision)
  const appended = await create('Later Topic')
  await expect(controller.researchReorderTopics({ topicIds: ids, expectedTopicIds: reversed }))
    .rejects.toMatchObject({ code: 'research/topic-order-conflict', details: { topicIds: appended.topics.map(topic => topic.id) } })
  expect((await controller.researchList()).topics).toEqual(appended.topics)
})

it('publishes the confirmed Topic directory order to live followers once', async () => {
  const { controller, catalog } = await fixture()
  const lifetime = new AbortController()
  const frames = controller.researchFollow(lifetime.signal)[Symbol.asyncIterator]()
  try {
    expect((await frames.next()).value).toMatchObject({ type: 'baseline' })
    const next = frames.next()
    const ids = catalog.topics.map(topic => topic.id)
    const saved = await controller.researchReorderTopics({ topicIds: [...ids].reverse(), expectedTopicIds: ids })
    await expect(next).resolves.toMatchObject({ value: { type: 'changed', catalog: { revision: saved.revision,
      topics: saved.topics } } })
  } finally { lifetime.abort(); await frames.return?.() }
})

it('serializes competing Topic moves so one writer cannot overwrite another observed order', async () => {
  const { controller, catalog } = await fixture()
  const ids = catalog.topics.map(topic => topic.id)
  const first = [ids[1]!, ids[2]!, ids[0]!]
  const competing = [ids[2]!, ids[0]!, ids[1]!]
  const results = await Promise.allSettled([
    controller.researchReorderTopics({ topicIds: first, expectedTopicIds: ids }),
    controller.researchReorderTopics({ topicIds: competing, expectedTopicIds: ids }),
  ])
  expect(results[0]?.status).toBe('fulfilled')
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'research/topic-order-conflict', details: { topicIds: first } } })
  expect((await controller.researchList()).topics.map(topic => topic.id)).toEqual(first)
})

it('allows directory Topic changes only through empty targets and preserves paper-order operations', async () => {
  const { controller, catalog } = await fixture()
  const call = { sessionId: undefined, signal: new AbortController().signal }
  const topicIds = catalog.topics.map(topic => topic.id)
  await expect(controller.uiModules.read('research.directory', {}, call)).resolves.toMatchObject({ topicIds })
  const saved = await controller.uiModules.update('research.directory', {}, {
    topicIds: [...topicIds].reverse(), expectedTopicIds: topicIds,
  }, call)
  expect(saved).toMatchObject({ topicIds: [...topicIds].reverse(),
    topics: catalog.topics.toReversed().map(topic => ({ topicId: topic.id })) })
  await expect(controller.uiModules.update('research.directory', { topicId: topicIds[0] }, {
    topicIds, expectedTopicIds: [...topicIds].reverse(),
  }, call)).rejects.toMatchObject({ code: 'ui/invalid-arguments' })
  const reorder = vi.spyOn(controller, 'researchReorderTopics')
  await expect(controller.uiModules.update('research.directory', {}, {
    topicIds, expectedTopicIds: topicIds, paperIds: [], expectedPaperIds: [],
  }, call)).rejects.toMatchObject({ code: 'ui/invalid-arguments' })
  expect(reorder).not.toHaveBeenCalled()
  await expect(controller.uiModules.update('research.directory', { topicId: topicIds[0] }, {
    paperIds: [], expectedPaperIds: [],
  }, call)).resolves.toMatchObject({ topicId: topicIds[0], paperIds: [] })
  await expect(controller.uiModules.update('research.directory', {}, {
    paperIds: [], expectedPaperIds: [],
  }, call)).rejects.toMatchObject({ code: 'ui/invalid-arguments' })
})
