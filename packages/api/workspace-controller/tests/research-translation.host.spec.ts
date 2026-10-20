/** Real inference preparation, JSONL audits, paper-owned caches and explicit learning-note publication. */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { PaperTranslations, PAPER_TRANSLATION_PROMPT } from '../src/research-translation.ts'
import type { PaperTranslationPolicy } from '../src/research-translation.ts'
import type { ResearchCatalog, ResearchPaperId, ResearchSaveNoteRequest } from '../src/research-types.ts'
import { translationPdfFixture } from '../../../client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const explanation = { kind: 'word', lemma: 'policy', partOfSpeech: '名词', meanings: ['政策；方针；策略'],
  contextualMeaning: '机器人动作策略', explanation: '这里描述根据观测生成动作的方法。', translation: '该策略预测动作。' }
const policy: PaperTranslationPolicy = { timeoutMs: 60_000, maxContextCharacters: 16_000, maxOutputTokens: 2048, maxResponseBytes: 262_144,
  maxStoredBytes: 8_388_608, maxIndexBytes: 33_554_432, maxPdfBytes: 67_108_864,
  dictionaryEndpoint: '', dictionaryTimeoutMs: 4000, maxNoteBytes: 8_388_608, lockTimeoutMs: 10_000 }

class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  response = JSON.stringify(explanation)
  finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
  gate: ((options: GenerateOptions) => Promise<void>) | undefined
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'model', name: 'Test' }]) }
  override resolveModel(provider: string, id: string) { return Promise.resolve({ provider, id, name: id, contextWindow: 128_000 }) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    await this.gate?.(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.response } }
    yield this.finish
  }
}

async function fixture(overrides: Partial<PaperTranslationPolicy> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-paper-translation-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore); await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' }); await ctx.plugin(LlmRuntime)
  const adapter = new Adapter(); ctx.effect(() => ctx.llm.registerAdapter(['test'], adapter))
  const session = ctx.sessions.create(SessionId('paper-translation'))
  const writer = await ctx.sessionPersistence.create(session.header)
  cleanups.push(() => writer.close())
  const directory = join(root, 'library'), paperDirectory = join(directory, 'papers', 'Paper')
  await mkdir(join(paperDirectory, 'notes'), { recursive: true })
  await writeFile(join(paperDirectory, 'paper.pdf'), translationPdfFixture())
  await writeFile(join(paperDirectory, 'notes', 'learning.md'), '')
  const paperId = 'paper' as ResearchPaperId
  let catalog: ResearchCatalog = { revision: 1, topics: [], directory, papers: [{ id: paperId, title: 'Paper', topicIds: [], sessionId: session.id,
    pdfPath: join(paperDirectory, 'paper.pdf'), directory: paperDirectory, repositoryUrl: '', ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }] }
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent: { session, options: { provider: 'test', model: 'model' } } }) } as never)
  const saveNote = vi.fn(async (request: ResearchSaveNoteRequest) => {
    const paper = catalog.papers[0]!
    if (paper.learning.revision !== request.expectedRevision) throw new RemoteError('research/note-conflict', 'Notes changed', { paperId, kind: 'learning', revision: paper.learning.revision })
    await writeFile(join(paperDirectory, 'notes', 'learning.md'), request.text)
    catalog = { ...catalog, revision: catalog.revision + 1,
      papers: [{ ...paper, learning: { text: request.text, revision: paper.learning.revision + 1 } }] }
    return catalog
  })
  const translations = new PaperTranslations(ctx, { ...policy, ...overrides }, { read: async () => catalog, saveNote })
  const request = { paperId, text: 'policy', start: { page: 1, item: 2, offset: 4 }, end: { page: 1, item: 2, offset: 10 } }
  const translate = (signal = new AbortController().signal) => translations.translate(request, signal)
  const events = async () => { await using handle = await ctx.sessionPersistence.open(session.id, 'read'); return (await handle.read()).events }
  return { ctx, adapter, session, paperDirectory, translations, request, translate, events, saveNote }
}

it('logs exact context before inference, saves a reusable result, and leaves conversation messages and notes unchanged', async () => {
  const view = await fixture()
  const result = await view.translate()
  expect(result.context).toEqual({ selected: 'policy', sentence: 'The policy predicts actions.', selectionStart: 4,
    before: ['First context sentence.', 'Second context sentence.'], after: ['Next context sentence.', 'Last context sentence.'], startPage: 1, endPage: 1, limited: false })
  expect(result.result).toEqual(explanation)
  expect(result.pronunciation.status).toBe('unavailable')
  const audits = await view.events()
  expect(audits.map(event => event.type)).toEqual(['research/translation-request', 'research/translation-result'])
  expect(audits[0]).toMatchObject({ data: { modelRequest: { system: PAPER_TRANSLATION_PROMPT, config: { provider: 'test', model: 'model', maxTokens: 2048 } } } })
  expect(view.adapter.calls[0]?.messages).toEqual((audits[0]!.data as { modelRequest: { messages: unknown } }).modelRequest.messages)
  expect(view.adapter.calls[0]?.sessionId).toBe(view.session.id)
  expect(view.adapter.calls[0]?.tools).toBeUndefined()
  expect(await readFile(join(view.paperDirectory, 'notes', 'learning.md'), 'utf8')).toBe('')
  const stored = JSON.parse(await readFile(join(view.paperDirectory, 'translations.json'), 'utf8')) as { entries: unknown[] }
  expect(stored.entries).toEqual([result])
  expect(await view.translate()).toEqual(result)
  expect(await view.translations.translate({ ...view.request, start: { item: 2, offset: 4, page: 1 },
    end: { offset: 10, page: 1, item: 2 } }, new AbortController().signal)).toEqual(result)
  expect(view.adapter.calls).toHaveLength(1)
})

it('appends the original excerpt and page link to learning notes once after explicit export', async () => {
  const view = await fixture(), result = await view.translate()
  await view.translations.saveNote(view.request.paperId, result.key)
  await view.translations.saveNote(view.request.paperId, result.key)
  expect(view.saveNote).toHaveBeenCalledTimes(1)
  const note = await readFile(join(view.paperDirectory, 'notes', 'learning.md'), 'utf8')
  expect(note).toContain('机器人动作策略'); expect(note).toContain('First context sentence.'); expect(note).toContain('(../paper.pdf#page=1)')
  await expect(view.translations.saveNote(view.request.paperId, 'missing')).rejects.toMatchObject({ details: { reason: 'selection' } })
})

it('retains only the request when a model returns malformed or incomplete output and permits a fresh retry', async () => {
  const view = await fixture(); view.adapter.response = 'not JSON'
  await expect(view.translate()).rejects.toMatchObject({ details: { reason: 'invalid-response' } })
  expect((await view.events()).map(event => event.type)).toEqual(['research/translation-request'])
  await expect(readFile(join(view.paperDirectory, 'translations.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  view.adapter.response = JSON.stringify(explanation)
  expect((await view.translate()).result).toEqual(explanation)
  expect(view.adapter.calls).toHaveLength(2)
})

it('rejects over-limit context and stale positions before any model dispatch', async () => {
  const view = await fixture({ maxContextCharacters: 10 })
  await expect(view.translate()).rejects.toMatchObject({ details: { reason: 'limit' } })
  expect(view.adapter.calls).toHaveLength(0)
  const ordinary = await fixture()
  await expect(ordinary.translations.translate({ ...ordinary.request, text: 'wrong word' }, new AbortController().signal))
    .rejects.toMatchObject({ details: { reason: 'selection' } })
  expect(ordinary.adapter.calls).toHaveLength(0)
  const oversized = await fixture({ maxPdfBytes: 1 })
  await expect(oversized.translate()).rejects.toMatchObject({ details: { reason: 'limit' } })
  expect(oversized.adapter.calls).toHaveLength(0)
})

it('cancels an accepted translation without publishing a partial result', async () => {
  const view = await fixture()
  const entered = Promise.withResolvers<undefined>()
  view.adapter.gate = options => new Promise<void>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => { reject(new Error('selection closed')) }, { once: true }); entered.resolve(undefined)
  })
  const lifetime = new AbortController(), work = view.translate(lifetime.signal)
  const outcome = work.then(() => undefined, (error: unknown) => error)
  try { await expect.poll(() => view.adapter.calls.length).toBe(1); await entered.promise }
  finally { lifetime.abort(new Error('selection closed')) }
  expect(await outcome).toMatchObject({ message: 'selection closed' })
  expect((await view.events()).map(event => event.type)).toEqual(['research/translation-request'])
  await expect(readFile(join(view.paperDirectory, 'translations.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains a validated result when note export conflicts and allows a subsequent explicit retry', async () => {
  const view = await fixture(), result = await view.translate()
  view.saveNote.mockRejectedValueOnce(new RemoteError('research/note-conflict', 'Notes changed', { paperId: view.request.paperId, kind: 'learning', revision: 1 }))
  await expect(view.translations.saveNote(view.request.paperId, result.key)).rejects.toMatchObject({ code: 'research/note-conflict' })
  expect((await view.translate()).key).toBe(result.key)
  await view.translations.saveNote(view.request.paperId, result.key)
  expect(view.saveNote).toHaveBeenCalledTimes(2)
})

it('reads real phonetics from the configured dictionary and retains the explanation if that service fails', async () => {
  let available = true
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    if (!available) { response.writeHead(503); response.end('Unavailable'); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify([{ phonetic: '/ˈpɒləsi/', phonetics: [{ text: '/ˈpɒləsi/' }, { text: '/ˈpɑːləsi/' }] }]))
  })
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve(); else reject(error)
    }))
    server.closeAllConnections(); await closed
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected private dictionary endpoint')
  const dictionaryEndpoint = `http://127.0.0.1:${address.port}/entries/en`
  const view = await fixture({ dictionaryEndpoint })
  const ready = await view.translate()
  expect(ready.pronunciation).toEqual({ status: 'ready', phonetics: ['/ˈpɒləsi/', '/ˈpɑːləsi/'], sourceUrl: `${dictionaryEndpoint}/policy` })
  expect(paths).toEqual(['/entries/en/policy'])
  available = false
  const other = await fixture({ dictionaryEndpoint })
  const missing = await other.translate()
  expect(missing.pronunciation.status).toBe('unavailable'); expect(missing.result).toEqual(explanation)
})
