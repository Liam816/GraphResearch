/** File-backed research library, serialized mutations, and live notebook observation. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import { digest, missing, ResearchFiles, researchCatalogSchema } from './research-files.ts'
import type { ResearchFilePolicy } from './research-files.ts'
import { importPdf, readPdfText } from './research-pdf.ts'
import type { ResearchPdfPolicy } from './research-pdf.ts'
import { restoreResearchSessions } from './research-session-backup.ts'
import type {
  ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchDirectoryRequest,
  ResearchFollowFrame, ResearchPaperId, ResearchReadPaperRequest, ResearchPaperText, ResearchSaveNoteRequest, ResearchTopicId,
  ResearchImportPaperRequest, ResearchAttachPdfRequest,
} from './research-types.ts'

const initialCatalog: ResearchCatalog = { revision: 0, topics: [], papers: [] }
const researchDomain = defineDomain({
  name: 'research', version: 1,
  global: { schema: researchCatalogSchema, initial: initialCatalog }, tables: {},
})

/** Validated library deployment choices supplied by the Workspace controller. */
export interface ResearchPolicy extends ResearchFilePolicy, ResearchPdfPolicy {
  readonly directory: string
  readonly watchStabilityMs: number
  readonly watchPollMs: number
}

/** Host-owned library. Interrupted saves retain a recoverable journal and confirmed browser data. */
export class ResearchCatalogHost {
  private readonly domain: Promise<Domain<typeof researchDomain>>
  private readonly ready: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private files!: ResearchFiles
  private watcher: FSWatcher | undefined
  private closed = false
  private snapshot: ResearchCatalog = { revision: 0, topics: [], papers: [] }
  private readonly followers = new Set<ResearchFollower>()
  private readonly archives = new Set<string>()

  /** @param ctx - Host Workspace, Session and storage authorities. @param policy - validated library policy. */
  constructor(private readonly ctx: Context, private readonly policy: ResearchPolicy) {
    this.domain = ctx.storageDomain.open(researchDomain)
    this.ready = this.initialize()
    void this.ready.catch((error: unknown) => { this.report(error) })
    ctx.on('session/event', (session) => { this.queueArchive(session) })
    ctx.effect(() => async () => {
      this.closed = true
      for (const follower of this.followers) follower.close()
      this.followers.clear()
      await this.watcher?.close()
      await this.writes
      const domain = await this.domain
      await domain.close()
    }, 'workspace-controller: research library')
  }

  /**
   * Read the confirmed in-memory library.
   * @returns the current confirmed library without filesystem work, for request-context providers.
   */
  current(): ResearchCatalog { return this.snapshot }

  /**
   * Preserve an entity's initial Session before its first model turn.
   * @param session - newly attached research Agent's Session.
   */
  async captureSession(session: Session): Promise<void> {
    await this.serialized(async () => { await this.archive(session) })
  }

  /**
   * Load canonical notebooks and metadata.
   * @returns the latest canonical files; read failures preserve the last published catalog.
   */
  read(): Promise<ResearchCatalog> {
    return this.serialized(() => this.files.withLock(async () => this.accept(await this.files.read())))
  }

  /**
   * Follow complete snapshots; slow followers coalesce changes because every frame replaces the catalog.
   * @param signal - caller generation cancellation.
   * @returns baseline, file changes and explicit observation failures.
   */
  async *follow(signal: AbortSignal): AsyncIterable<ResearchFollowFrame> {
    signal.throwIfAborted()
    const follower = new ResearchFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', catalog: await this.read() }
      yield* follower.read(signal)
    } finally { this.followers.delete(follower); follower.close() }
  }

  /**
   * Register a Topic with an independent Session.
   * @param request - Topic identity and its independent Session.
   * @returns the committed file-backed catalog.
   */
  createTopic(request: ResearchCreateTopicRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      this.validateSession(request.workspaceId, request.sessionId)
      const title = requiredText(request.title, 'title')
      const existing = catalog.topics.find(topic => topic.sessionId === request.sessionId)
      if (existing !== undefined && existing.workspaceId === request.workspaceId && existing.title === title) return catalog
      this.requireIndependentSession(catalog, request.sessionId)
      return { ...catalog, topics: [...catalog.topics, {
        ...request, title, id: brandString<ResearchTopicId>(randomUUID()), notes: { text: '', revision: 0 },
      }] }
    })
  }

  /**
   * Register a paper, optionally importing a PDF; matching identity or bytes reuse a paper.
   * @param request - Topic, independent Session and optional source PDF path or URL.
   * @param signal - import cancellation.
   * @param selected - receives the selected identity, including reused papers.
   * @returns committed catalog, including the original Session when a paper is reused.
   */
  createPaper(
    request: ResearchCreatePaperRequest, signal = new AbortController().signal, selected?: (id: ResearchPaperId) => void,
  ): Promise<ResearchCatalog> {
    return this.admitPaper(request, signal, selected)
  }

  /**
   * Register a paper and create its Session after validating any supplied PDF.
   * @param request - Topic, title and optional original PDF source.
   * @param createSession - owning Session controller's creation operation.
   * @param signal - cancellation.
   * @returns selected paper identity and committed catalog.
   */
  async importPaper(
    request: ResearchImportPaperRequest,
    createSession: (workspaceId: ResearchCreateTopicRequest['workspaceId']) => Promise<ResearchCreatePaperRequest['sessionId']>,
    signal: AbortSignal,
  ): Promise<{ readonly catalog: ResearchCatalog; readonly paperId: ResearchPaperId }> {
    let paperId: ResearchPaperId | undefined
    const catalog = await this.admitPaper({
      topicId: request.topicId, title: request.title, pdfPath: request.source ?? '', repositoryUrl: request.repositoryUrl ?? '',
      ...request.sourceId === undefined ? {} : { sourceId: request.sourceId },
    }, signal, (id) => { paperId = id }, createSession)
    if (paperId === undefined) throw new Error('Research import did not select a paper')
    return { catalog, paperId }
  }

  private admitPaper(
    request: Omit<ResearchCreatePaperRequest, 'sessionId'> & Partial<Pick<ResearchCreatePaperRequest, 'sessionId'>>,
    signal: AbortSignal, selected?: (id: ResearchPaperId) => void,
    createSession?: (workspaceId: ResearchCreateTopicRequest['workspaceId']) => Promise<ResearchCreatePaperRequest['sessionId']>,
  ): Promise<ResearchCatalog> {
    return this.mutate(async (catalog) => {
      const topic = catalog.topics.find(item => item.id === request.topicId)
      if (topic === undefined) throw new RemoteError('research/not-found', 'Topic not found', { id: request.topicId })
      if (request.sessionId !== undefined) this.validateSession(topic.workspaceId, request.sessionId)
      const title = requiredText(request.title, 'title'), source = request.pdfPath?.trim() ?? ''
      const repositoryUrl = validateRepository(request.repositoryUrl)
      const sourceId = normalizeSourceId(request.sourceId ?? source)
      const retry = request.sessionId === undefined ? undefined : catalog.papers.find(item => item.sessionId === request.sessionId)
      if (retry !== undefined && retry.title === title && retry.source === source
        && retry.repositoryUrl === repositoryUrl && retry.topicIds.includes(topic.id)) {
        selected?.(retry.id); return catalog
      }
      if (request.sessionId !== undefined) this.requireIndependentSession(catalog, request.sessionId)
      const known = sourceId === '' ? undefined : catalog.papers.find(item => item.sourceId === sourceId)
      if (known !== undefined) { selected?.(known.id); return attachTopic(catalog, known.id, topic.id) }
      const workspace = this.ctx.workspaceRegistry.get(topic.workspaceId)
      if (workspace === undefined) throw new RemoteError('research/invalid', 'Topic workspace is unavailable', { field: 'workspaceId' })
      const bytes = source === '' ? undefined : await importPdf(source, workspace.path, this.policy, signal)
      const pdfSha256 = bytes === undefined ? undefined : digest(bytes)
      const duplicate = pdfSha256 === undefined ? undefined : catalog.papers.find(item => item.pdfSha256 === pdfSha256)
      if (duplicate !== undefined) { selected?.(duplicate.id); return attachTopic(catalog, duplicate.id, topic.id) }
      signal.throwIfAborted()
      const sessionId = request.sessionId ?? await createSession?.(topic.workspaceId)
      if (sessionId === undefined) throw new Error('Paper admission requires a Session owner')
      this.validateSession(topic.workspaceId, sessionId)
      const id = brandString<ResearchPaperId>(randomUUID())
      const directory = await this.files.path('papers', id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const pdfPath = bytes === undefined ? '' : await this.files.path('papers', id, 'paper.pdf')
      if (bytes !== undefined) await writeFile(pdfPath, bytes, { flag: 'wx', mode: 0o600, signal })
      selected?.(id)
      return { ...catalog, papers: [...catalog.papers, {
        id, title, topicIds: [topic.id], sessionId, directory, pdfPath, repositoryUrl, source, sourceId, pdfSha256,
        progress: '', ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 },
      }] }
    })
  }

  /**
   * Download or copy an existing paper's original; a different attached PDF is never replaced.
   * @param request - target paper and source URL or local path, relative to its managed directory.
   * @param signal - download cancellation.
   * @returns committed catalog with the same paper, Session and notebooks.
   */
  attachPdf(request: ResearchAttachPdfRequest, signal: AbortSignal): Promise<ResearchCatalog> {
    return this.mutate(async (catalog) => {
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      const source = requiredText(request.source, 'source')
      const directory = await this.files.path('papers', paper.id)
      const bytes = await importPdf(source, directory, this.policy, signal)
      const pdfSha256 = digest(bytes)
      const pdfPath = await this.files.path('papers', paper.id, 'paper.pdf')
      let existing: Buffer | undefined
      try { existing = await readFile(pdfPath) } catch (error: unknown) { if (!missing(error)) throw error }
      if (existing !== undefined && digest(existing) !== pdfSha256) {
        throw new RemoteError('research/invalid', 'This paper already has a different PDF; create a separate paper for another original', { field: 'source' })
      }
      signal.throwIfAborted()
      if (existing === undefined) await writeFileAtomic(pdfPath, bytes, { mode: 0o600, dirMode: 0o700 })
      if (paper.pdfPath === pdfPath && paper.pdfSha256 === pdfSha256) return catalog
      return { ...catalog, papers: catalog.papers.map(item => item.id === paper.id
        ? { ...item, pdfPath, pdfSha256, source, sourceId: item.sourceId || normalizeSourceId(source) } : item) }
    })
  }

  /**
   * Save Markdown after checking its revision.
   * @param request - Revision-checked notebook edit.
   * @returns the committed catalog; stale edits write nothing.
   */
  saveNote(request: ResearchSaveNoteRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      if (paper[request.kind].revision !== request.expectedRevision) throw new RemoteError('research/note-conflict', 'Read the latest notebook before merging this edit', {
        paperId: paper.id, kind: request.kind, revision: paper[request.kind].revision,
      })
      return { ...catalog, papers: catalog.papers.map(item => item.id === paper.id
        ? { ...item, [request.kind]: { text: request.text, revision: paper[request.kind].revision + 1 } } : item) }
    })
  }

  /**
   * Store the next reading step.
   * @param paperId - Owning paper.
   * @param text - Continuation point and questions.
   * @returns committed catalog.
   */
  progress(paperId: ResearchPaperId, text: string): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      if (!catalog.papers.some(item => item.id === paperId)) {
        throw new RemoteError('research/not-found', 'Paper not found', { id: paperId })
      }
      return { ...catalog, papers: catalog.papers.map(item => item.id === paperId ? { ...item, progress: text } : item) }
    })
  }

  /**
   * Save a revision-checked comparison summary.
   * @param topicId - Owning Topic.
   * @param text - Markdown comparison summary.
   * @param revision - Last read revision.
   * @returns committed catalog.
   */
  topicNote(topicId: ResearchTopicId, text: string, revision: number): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      const topic = catalog.topics.find(item => item.id === topicId)
      if (topic === undefined) throw new RemoteError('research/not-found', 'Topic not found', { id: topicId })
      if (topic.notes?.revision !== revision) {
        throw new RemoteError('research/invalid', 'Read the latest topic summary before editing', { field: 'expectedRevision' })
      }
      return { ...catalog, topics: catalog.topics.map(item => item.id === topicId
        ? { ...item, notes: { text, revision: revision + 1 } } : item) }
    })
  }

  /**
   * Open another library or copy this library to an empty destination. Source files are retained.
   * @param request - absolute destination and explicit operation.
   * @returns the selected library; selection is persisted only after successful preparation.
   */
  configure(request: ResearchDirectoryRequest): Promise<ResearchCatalog> {
    return this.serialized(async () => {
      const destination = await ResearchFiles.open(request.directory, this.policy)
      if (destination.directory === this.files.directory) return this.snapshot
      const source = this.files
      const from = source.directory, to = destination.directory
      if (to.startsWith(`${from}${sep}`) || from.startsWith(`${to}${sep}`)) throw new RemoteError('research/invalid', 'Choose separate library directories', { field: 'directory' })
      await this.watcher?.close()
      try {
        const catalog = await source.withLock(async () => {
          return destination.withLock(async () => {
            if (request.mode === 'migrate') await source.copyTo(destination)
            const loaded = await restoreResearchSessions(this.ctx, destination, await destination.read())
            await destination.write({ ...loaded, revision: Math.max(loaded.revision, this.snapshot.revision) + 1 })
            return destination.read()
          })
        })
        await (await this.domain).global.set({ revision: catalog.revision, directory: destination.directory, topics: [], papers: [] })
        this.files = destination
        await this.watch()
        return this.accept(catalog)
      } catch (error: unknown) { await this.watch(); throw error }
    })
  }

  /**
   * Extract original PDF text with page numbers.
   * @param request - Paper identity and bounded page range.
   * @param signal - cancellation.
   * @returns original text with page numbers.
   */
  readPaper(request: ResearchReadPaperRequest, signal: AbortSignal): Promise<ResearchPaperText> {
    return this.serialized(async () => {
      const catalog = await this.files.withLock(() => this.files.read())
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      if (paper.pdfPath === '') throw new RemoteError('research/invalid', 'No original PDF is attached. Find the paper and use research_attach_pdf before reading it.', { field: 'pdfPath' })
      const result = await readPdfText(paper.pdfPath, request, this.policy, signal)
      await writeFileAtomic(await this.files.path('papers', paper.id, 'extracted', `pages-${request.startPage ?? 1}.json`),
        `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return result
    })
  }

  private async initialize(): Promise<void> {
    const domain = await this.domain
    const previous = domain.global.get()
    this.files = await ResearchFiles.open(previous.directory ?? this.policy.directory, this.policy)
    const catalog = await this.files.withLock(async () => {
      for (const paper of previous.papers) {
        if (paper.pdfPath === '') continue
        const topic = previous.topics.find(item => paper.topicIds.includes(item.id))
        const workspace = topic === undefined ? undefined : this.ctx.workspaceRegistry.get(topic.workspaceId)
        const source = isAbsolute(paper.pdfPath) ? paper.pdfPath : resolve(workspace?.path ?? this.files.directory, paper.pdfPath)
        const target = await this.files.path('papers', paper.id, 'paper.pdf')
        if (source === target) continue
        await mkdir(await this.files.path('papers', paper.id), { recursive: true, mode: 0o700 })
        try { await copyFile(source, target, constants.COPYFILE_EXCL) } catch (error: unknown) {
          // A missing old PDF stays visible as a missing resource; its notebooks still migrate.
          if (!missing(error) && !(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      const loaded = await this.files.read(previous)
      const restored = await restoreResearchSessions(this.ctx, this.files, loaded)
      if (restored !== loaded) await this.files.write(restored)
      return restored
    })
    await domain.global.set({ revision: catalog.revision, directory: this.files.directory, topics: [], papers: [] })
    this.accept(catalog)
    if (!this.closed) await this.watch()
  }

  private async watch(): Promise<void> {
    if (this.closed) return
    this.watcher = chokidar.watch([resolve(this.files.directory, 'papers'), resolve(this.files.directory, 'topics')], {
      ignoreInitial: true, followSymlinks: false,
      ignored: (path) => {
        const parts = relative(this.files.directory, path).split(sep)
        if (parts[0] === 'papers') return parts.length >= 3 && (parts[2] !== 'notes'
          || (parts.length >= 4 && parts[3] !== 'ai.md' && parts[3] !== 'learning.md'))
        if (parts[0] === 'topics') return parts.length >= 3 && parts[2] !== 'notes.md'
        return false
      },
      awaitWriteFinish: { stabilityThreshold: this.policy.watchStabilityMs, pollInterval: this.policy.watchPollMs },
    })
    this.watcher.on('all', (_event, path) => {
      if (!/(?:[\\/]notes[\\/](?:ai|learning)\.md|[\\/]topics[\\/][^\\/]+[\\/]notes\.md)$/.test(path) || this.closed) return
      void this.read().catch((error: unknown) => { this.report(error) })
    })
    this.watcher.on('error', (error) => { this.report(error) })
    const watcher = this.watcher
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => { watcher.off('error', failed); resolve() }
      const failed = (error: unknown): void => {
        watcher.off('ready', ready)
        reject(error instanceof Error ? error : new Error('Research notebook observation failed', { cause: error }))
      }
      watcher.once('ready', ready); watcher.once('error', failed)
    })
  }

  private mutate(update: (catalog: ResearchCatalog) => ResearchCatalog | Promise<ResearchCatalog>): Promise<ResearchCatalog> {
    return this.serialized(() => this.files.withLock(async () => {
      const previous = await this.files.read()
      this.accept(previous)
      const next = await update(previous)
      if (next === previous) return previous
      await this.files.write({ ...next, revision: previous.revision + 1 }, previous)
      if (next.papers.length !== previous.papers.length || next.topics.length !== previous.topics.length) {
        await this.watcher?.close()
        await this.watch()
      }
      return this.accept(await this.files.read())
    }))
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => {
      await this.ready
      if (this.closed) throw new RemoteError('research/storage-failed', 'Library is closing', { operation: 'read', path: this.policy.directory })
      try { return await operation() } catch (error: unknown) {
        if (error instanceof RemoteError) throw error
        throw new RemoteError('research/storage-failed', 'Library operation failed; refresh before retrying an interrupted save', {
          operation: 'library', path: this.files.directory,
        }, { cause: error })
      }
    })
    this.writes = result.then(() => {}, (_error: unknown) => {})
    return result
  }

  private accept(catalog: ResearchCatalog): ResearchCatalog {
    if (catalog.revision !== this.snapshot.revision || catalog.directory !== this.snapshot.directory) {
      this.snapshot = catalog
      for (const follower of this.followers) follower.push({ type: 'changed', catalog })
    }
    return catalog
  }

  private report(error: unknown): void {
    this.ctx.logger.warn('Research library update failed; confirmed data is retained: %s', error)
    for (const follower of this.followers) follower.push({ type: 'error', message: 'research/storage-failed' })
  }

  private ownsSession(id: string): boolean {
    return this.snapshot.topics.some(item => item.sessionId === id) || this.snapshot.papers.some(item => item.sessionId === id)
  }

  private queueArchive(session: Session): void {
    if (!this.ownsSession(session.id) || this.archives.has(session.id) || this.closed) return
    this.archives.add(session.id)
    let archived: number | undefined
    void this.serialized(async () => { archived = await this.archive(session) })
      .catch((error: unknown) => { this.report(error) }).finally(() => {
        this.archives.delete(session.id)
        if (archived !== undefined && session.seq > archived) this.queueArchive(session)
      })
  }

  private async archive(session: Session): Promise<number | undefined> {
    const paper = this.snapshot.papers.find(item => item.sessionId === session.id)
    const topic = this.snapshot.topics.find(item => item.sessionId === session.id)
    if (paper === undefined && topic === undefined) return
    const path = paper !== undefined ? await this.files.path('papers', paper.id, 'session.json')
      : topic !== undefined ? await this.files.path('topics', topic.id, 'session.json') : undefined
    if (path === undefined) return
    for (;;) {
      const end = session.seq
      await this.ctx.sessionPersistence.flush()
      const handle = await this.ctx.sessionPersistence.open(session.id, 'read')
      try {
        const { events } = await handle.read()
        await writeFileAtomic(path, `${JSON.stringify({ header: handle.header, inheritedEventCount: handle.inheritedEventCount, events })}\n`,
          { mode: 0o600, dirMode: 0o700 })
      } finally { await handle.close() }
      if (session.seq === end || this.closed) return end
    }
  }

  private validateSession(workspaceId: ResearchCreateTopicRequest['workspaceId'], sessionId: ResearchCreateTopicRequest['sessionId']): void {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) throw new RemoteError('research/invalid', 'Session must belong to the selected workspace', { field: 'sessionId' })
  }

  private requireIndependentSession(catalog: ResearchCatalog, id: ResearchCreatePaperRequest['sessionId']): void {
    if (catalog.topics.some(item => item.sessionId === id) || catalog.papers.some(item => item.sessionId === id)) {
      throw new RemoteError('research/invalid', 'Each entity requires an independent Session', { field: 'sessionId' })
    }
  }
}

class ResearchFollower {
  private pending: ResearchFollowFrame | undefined
  private wake: (() => void) | undefined
  private closed = false
  push(frame: ResearchFollowFrame): void { this.pending = frame; this.wake?.() }
  close(): void { this.closed = true; this.wake?.() }
  async *read(signal: AbortSignal): AsyncIterable<ResearchFollowFrame> {
    while (!this.closed && !signal.aborted) {
      if (this.pending !== undefined) { const frame = this.pending; this.pending = undefined; yield frame; continue }
      await new Promise<void>((resolve) => {
        const done = (): void => { signal.removeEventListener('abort', done); this.wake = undefined; resolve() }
        this.wake = done; signal.addEventListener('abort', done, { once: true })
        if (signal.aborted || this.closed || this.pending !== undefined) done()
      })
    }
  }
}

function requiredText(value: string, field: string): string {
  const text = value.trim()
  if (text === '') throw new RemoteError('research/invalid', 'This field is required', { field })
  return text
}

function validateRepository(value: string): string {
  const text = value.trim()
  if (text === '') return ''
  let url: URL
  try { url = new URL(text) } catch (error: unknown) { throw new RemoteError('research/invalid', 'Repository URL must be HTTP(S)', { field: 'repositoryUrl' }, { cause: error }) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new RemoteError('research/invalid', 'Repository URL must be HTTP(S)', { field: 'repositoryUrl' })
  return text
}

function normalizeSourceId(value: string): string {
  const text = value.trim().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '')
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(text)) return `arxiv:${text}`
  if (/^(?:https?:\/\/doi\.org\/|doi:)?10\.\d{4,9}\//i.test(text)) return text.replace(/^https?:\/\/doi\.org\//i, 'doi:').replace(/^(?!doi:)/, 'doi:').toLowerCase()
  return /^arxiv:/i.test(text) ? text.toLowerCase() : ''
}

function attachTopic(catalog: ResearchCatalog, paperId: ResearchPaperId, topicId: ResearchTopicId): ResearchCatalog {
  const paper = catalog.papers.find(item => item.id === paperId)
  if (paper?.topicIds.includes(topicId)) return catalog
  return { ...catalog, papers: catalog.papers.map(item => item.id === paperId ? { ...item, topicIds: [...item.topicIds, topicId] } : item) }
}
