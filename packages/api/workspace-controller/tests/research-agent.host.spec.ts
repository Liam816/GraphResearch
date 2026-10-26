/** Main Agent tools expose the complete research library through confirmed commands and bounded readers. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { unsupportedInbox } from '../../../test-support/agent-loop-testkit/src/inbox.ts'
import { createSessionTestController } from '../../session-controller/tests/test-remote.ts'
import type { SessionProjectionsValue } from '../../session-controller/src/types.ts'
import WorkspaceController from '../src/index.ts'
import { ResearchCatalogHost } from '../src/research.ts'

const fixtures: { root: string; ctx: Context }[] = []
afterEach(async () => {
  for (const { root, ctx } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function text(result: ToolExecutionResult): string {
  if (result.isError) throw new Error(result.error.message)
  if (typeof result.value !== 'string') throw new Error('Research tool did not return its declared string value')
  return result.value
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-research-agent-')))
  const ctx = new Context()
  fixtures.push({ root, ctx })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domains = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domains)
  ctx.provide('storageDomain', domains)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native-sessions'), compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  const dispose = () => () => {}
  // Type declarations retain the complete Typert service; these tests use only registration callbacks.
  ctx.provide('typert', { lookups: { configure: dispose, register: dispose },
    contexts: { configureHost: dispose, registerHost: dispose } } as never)
  await ctx.plugin(AgentRegistry)
  let currentDirectory = root
  ctx.provide('workingDirectory', {
    defaultDirectory: root, get: () => currentDirectory, ensure: async () => currentDirectory,
    set: async (_agent: Agent, directory: string) => { currentDirectory = directory; return directory },
  })
  const sessions = createSessionTestController(ctx, { cwd: root,
    defaultModelSelection: () => ({ provider: 'test', model: 'test' }) })
  const controller = new WorkspaceController(ctx, { documentsDirectory: root,
    researchDirectory: join(root, 'data'), researchPdfTextBackend: 'pdfjs' })
  await controller.researchList()
  const session = ctx.sessions.create(SessionId('main-agent'), { meta: { cwd: root } })
  {
    await using writer = await ctx.sessionPersistence.create(session.header)
    await writer.flush()
  }
  const unsupported = (): never => { throw new Error('This Agent fixture does not drive model turns') }
  const main: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', inbox: unsupportedInbox(),
    cancel: () => {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal),
    send: unsupported, followup: unsupported, steer: unsupported, inject: unsupported }
  await ctx.agents.register(main)
  let callId = 0
  const call = (name: string, args: Record<string, string | number> = {}) => ctx.tools.execute({ name, arguments: args,
    callId: ToolCallId(`research-${++callId}`), agent: main, signal: new AbortController().signal })
  const workspace = (await controller.create({ path: root })).workspace
  const createTopic = async (title: string) => {
    const id = SessionId(`topic-${ctx.sessions.list().length}`)
    ctx.sessions.create(id, { meta: { cwd: root } })
    await ctx.workspaceRegistry.get(workspace.workspaceId)!.attachSession(id)
    const catalog = await controller.researchCreateTopic({ title, workspaceId: workspace.workspaceId, sessionId: id })
    return catalog.topics.find(topic => topic.sessionId === id)!
  }
  const createPaper = async (topicId: Parameters<WorkspaceController['researchCreatePaper']>[0]['topicId'], title: string) => {
    const id = SessionId(`paper-${ctx.sessions.list().length}`)
    ctx.sessions.create(id, { meta: { cwd: root } })
    await ctx.workspaceRegistry.get(workspace.workspaceId)!.attachSession(id)
    const catalog = await controller.researchCreatePaper({ title, topicId, sessionId: id, repositoryUrl: '' })
    return catalog.papers.find(paper => paper.sessionId === id)!
  }
  return { root, ctx, main, controller, sessions, workspace, call, createTopic, createPaper }
}

it('gives a main Agent research capabilities before any Topic exists and captures later entity adoption once', async () => {
  const capture = vi.spyOn(ResearchCatalogHost.prototype, 'captureSession')
  const view = await fixture()
  expect(view.ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([
    'research_create_topic', 'research_context', 'research_list_files', 'research_read_file', 'research_read_conversation',
  ]))
  const assembly = await view.ctx.systemPrompt.assemble(assembleContextFor(view.main))
  expect(assembly.contexts.find(context => context.name === 'research:library')?.text).toContain('"scope":"library"')
  expect(capture).not.toHaveBeenCalled()
  await view.ctx.workspaceRegistry.get(view.workspace.workspaceId)!.attachSession(view.main.id)
  await view.controller.researchCreateTopic({ title: 'Adopted Topic', workspaceId: view.workspace.workspaceId, sessionId: view.main.id })
  expect(capture).toHaveBeenCalledExactlyOnceWith(view.main.session)
  await view.controller.researchList()
  expect(capture).toHaveBeenCalledTimes(1)
  expect(view.ctx.tools.schemas().filter(tool => tool.name === 'research_create_topic')).toHaveLength(1)
})

it('rejects a blank requested Topic name before allocating any Workspace or Session', async () => {
  const view = await fixture()
  const workspace = vi.spyOn(view.controller, 'create')
  const create = vi.spyOn(view.sessions, 'create')
  const count = view.ctx.sessions.list().length
  const result = await view.call('research_create_topic', { title: ' \t ' })
  if (!result.isError) throw new Error('A blank Topic name must be rejected')
  expect(result.error.message).toContain('nonempty')
  expect(workspace).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(view.ctx.sessions.list()).toHaveLength(count)
})

it('reads notes across the whole library and narrows explicit Topic context without leaking another Topic', async () => {
  const view = await fixture()
  const a = await view.createTopic('Robotics'), b = await view.createTopic('Language')
  const paperA = await view.createPaper(a.id, 'Policy'), paperB = await view.createPaper(b.id, 'Language model')
  await view.controller.researchTopicNote(a.id, 'Robotics research route', 0)
  await view.controller.researchTopicNote(b.id, 'Language research route', 0)
  await view.controller.researchSaveNote({ paperId: paperA.id, kind: 'ai', text: 'Policy architecture notes', expectedRevision: 0 })
  await view.controller.researchSaveNote({ paperId: paperB.id, kind: 'learning', text: 'Language learning notes', expectedRevision: 0 })
  const all = text(await view.call('research_context'))
  for (const expected of ['Robotics research route', 'Language research route', 'Policy architecture notes', 'Language learning notes']) {
    expect(all).toContain(expected)
  }
  const selected = text(await view.call('research_context', { topic_id: a.id }))
  expect(selected).toContain('Policy architecture notes')
  expect(selected).toContain('Robotics research route')
  expect(selected).not.toContain('Language learning notes')
  expect(selected).not.toContain('Language research route')
  expect(await view.call('research_context', { topic_id: a.id, paper_id: paperA.id })).toMatchObject({ isError: true })
})

it('reads associated code in another paper and rejects paper-directory traversal', async () => {
  const view = await fixture()
  const topic = await view.createTopic('Robotics'), paper = await view.createPaper(topic.id, 'Policy')
  await mkdir(join(paper.directory!, 'code'))
  await writeFile(join(paper.directory!, 'code', 'model.py'), 'policy_layers = 24\n')
  await writeFile(join(view.root, 'secret.txt'), 'Outside library')
  expect(text(await view.call('research_list_files', { paper_id: paper.id, path: 'code' }))).toContain('model.py')
  const content = z.object({ kind: z.literal('text'), text: z.string() })
    .parse(JSON.parse(text(await view.call('research_read_file', { paper_id: paper.id, path: 'code/model.py' }))))
  expect(content.text).toBe('policy_layers = 24\n')
  expect(await view.call('research_read_file', { paper_id: paper.id, path: '../secret.txt' })).toMatchObject({ isError: true })
  expect(await view.call('research_list_files', { paper_id: paper.id, path: '..' })).toMatchObject({ isError: true })
  expect(await readFile(join(view.root, 'secret.txt'), 'utf8')).toBe('Outside library')
})

it('rejects conversations outside the catalog before querying Session state or pages', async () => {
  const view = await fixture()
  const state = vi.spyOn(view.sessions, 'projections')
  const page = vi.spyOn(view.sessions, 'page')
  expect(await view.call('research_read_conversation', { session_id: view.main.id })).toMatchObject({ isError: true })
  expect(state).not.toHaveBeenCalled()
  expect(page).not.toHaveBeenCalled()
})

it('reads indexed conversations through the Session projection cut and message-page cursor', async () => {
  const view = await fixture()
  const topic = await view.createTopic('Robotics'), paper = await view.createPaper(topic.id, 'Policy')
  const state = vi.spyOn(view.sessions, 'projections').mockResolvedValue({ kind: 'sequenced', asOfSeq: 8, values: {} })
  const page = vi.spyOn(view.sessions, 'page').mockResolvedValue({ hasMore: true, records: [{ type: 'event',
    event: { type: 'user/message', seq: 4, time: 1, surfaceOp: 'append', data: { text: 'Saved question' } } }] })
  const result = text(await view.call('research_read_conversation', { session_id: paper.sessionId, before_seq: 7, max_messages: 2 }))
  expect(result).toContain('Saved question')
  expect(result).toContain('"nextBeforeSeq": 4')
  expect(state).toHaveBeenCalledWith({ sessionId: paper.sessionId }, expect.any(AbortSignal))
  expect(page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: paper.sessionId }, throughSeq: 8,
    beforeSeq: 7, maxMessages: 2 }, expect.any(AbortSignal))
})

const unavailable: { name: string; state: SessionProjectionsValue }[] = [
  { name: 'missing', state: null }, { name: 'unmigrated', state: { kind: 'migration-required', values: {} } },
]
it.each(unavailable)('retains an explicit failure for $name conversation history', async ({ state }) => {
  const view = await fixture()
  const topic = await view.createTopic('Robotics')
  vi.spyOn(view.sessions, 'projections').mockResolvedValue(state)
  const page = vi.spyOn(view.sessions, 'page')
  expect(await view.call('research_read_conversation', { session_id: topic.sessionId })).toMatchObject({ isError: true })
  expect(page).not.toHaveBeenCalled()
})
