/** File-backed research library, serialized mutations, and live notebook observation. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { digest, missing, ResearchFiles, researchCatalogSchema, researchHighlightSchema } from './research-files.ts'
import type { ResearchFilePolicy } from './research-files.ts'
import { listPaperContents, readPaperContent, savePaperContent } from './research-contents.ts'
import type {
  ResearchFileRequest, ResearchDirectoryListing, ResearchFileContent, ResearchSaveFileRequest, ResearchRenameTopicRequest,
} from './research-types.ts'
import { importPdf, readPdfText } from './research-pdf.ts'
import type { ResearchPdfPolicy } from './research-pdf.ts'
import { extractPaperMarkdown } from './research-markdown.ts'
import type { ResearchMarkdownPolicy } from './research-markdown.ts'
import { restoreResearchSessions } from './research-session-backup.ts'
import type {
  ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchDirectoryRequest, ResearchDeletePaperRequest,
  ResearchFollowFrame, ResearchPaperId, ResearchReadPaperRequest, ResearchPaperText, ResearchSaveNoteRequest, ResearchTopicId,
  ResearchImportPaperRequest, ResearchAttachPdfRequest, ResearchHighlightRequest,
} from './research-types.ts'

const initialCatalog: ResearchCatalog = { revision: 0, topics: [], papers: [] }
const researchDomain = defineDomain({
  name: 'research', version: 1,
  global: { schema: researchCatalogSchema, initial: initialCatalog }, tables: {},
})

/** Validated library deployment choices supplied by the Workspace controller. */
export interface ResearchPolicy extends ResearchFilePolicy, ResearchPdfPolicy, ResearchMarkdownPolicy {
  readonly directory: string
  readonly watchStabilityMs: number
  readonly watchPollMs: number
  readonly maxHighlightBytes: number
}

/** Host-owned library. Interrupted saves retain a recoverable journal and confirmed browser data. */
export class ResearchCatalogHost {
  private readonly domain: Promise<Domain<typeof researchDomain>>
  private readonly ready: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private files!: ResearchFiles
  private watcher: FSWatcher | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private snapshot: ResearchCatalog = { revision: 0, topics: [], papers: [] }
  private readonly followers = new Set<ResearchFollower>()
  private readonly archives = new Set<string>()

  /**
   * @param ctx - Host Workspace, Session and storage authorities.
   * @param policy - validated library policy.
   */
  constructor(private readonly ctx: Context, private readonly policy: ResearchPolicy) {
    this.domain = ctx.storageDomain.open(researchDomain)
    this.ready = this.initialize()
    void this.ready.catch((error: unknown) => { this.report(error) })
    ctx.on('session/event', (session) => { this.queueArchive(session) })
    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      for (const follower of this.followers) follower.close()
      this.followers.clear()
      await this.watcher?.close()
      await this.ready.then(() => {}, (_error: unknown) => {})
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
    return this.serialized(() => this.files.withLock(async () => {
      return this.accept(await this.ensureMarkdown(this.files, await this.files.read()))
    }))
  }

  /**
   * Delete a paper's files and catalog entry after directory confirmation and Session archival.
   * @param request - selected paper and exact absolute directory confirmed by the user.
   * @returns the committed catalog; active paper or topic work refuses deletion before files change.
   */
  deletePaper(request: ResearchDeletePaperRequest): Promise<ResearchCatalog> {
    return this.serialized(() => this.files.withLock(async () => {
      const catalog = await this.files.read()
      this.accept(catalog)
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      await this.files.confirmDeletion(paper, request.directory)
      const sessions = [paper.sessionId, ...catalog.topics.filter(item => paper.topicIds.includes(item.id)).map(item => item.sessionId)]
      const requireIdle = async (): Promise<void> => {
        const activity = await Promise.all(sessions.map(sessionId => this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))))
        if (activity.some(items => items.length > 0) || sessions.some(id => this.ctx.get('agents')?.get(id)?.status === 'running')) {
          throw new RemoteError('research/paper-busy', 'Stop the paper and topic work before deleting this paper', { paperId: paper.id })
        }
      }
      await requireIdle()
      try { await this.ctx.workspaceRegistry.archiveSession(paper.sessionId) }
      catch (error: unknown) {
        if (error instanceof WorkspaceActiveSessionError) {
          throw new RemoteError('research/paper-busy', 'Stop the paper work before deleting its files', { paperId: paper.id }, { cause: error })
        }
        throw error
      }
      await requireIdle()
      const confirmed = await this.files.deletePaper(paper, request.directory)
      this.accept(confirmed)
      await this.watcher?.close()
      await this.watch()
      return confirmed
    }))
  }

  /**
   * List direct children inside the selected paper.
   * @param request - paper and relative directory.
   * @returns the current directory children.
   */
  listFiles(request: ResearchFileRequest): Promise<ResearchDirectoryListing> {
    return this.fileOperation(request, paper => listPaperContents(this.files, paper, request.path))
  }

  /**
   * Read a complete file preview inside the selected paper.
   * @param request - paper and relative file.
   * @returns complete bounded contents for preview.
   */
  readFile(request: ResearchFileRequest): Promise<ResearchFileContent> {
    return this.fileOperation(request, paper => readPaperContent(this.files, paper, request.path, this.policy.maxNoteBytes))
  }

  /**
   * Save a Markdown draft without replacing intervening edits.
   * @param request - Markdown draft and base version.
   * @returns acknowledged contents; conflicts preserve the draft and disk version.
   */
  saveFile(request: ResearchSaveFileRequest): Promise<ResearchFileContent> {
    return this.fileOperation(request, async (paper) => {
      const content = await savePaperContent(this.files, paper, request, this.policy.maxNoteBytes)
      this.accept(await this.files.read())
      return content
    })
  }

  private fileOperation<T>(request: ResearchFileRequest, operation: (paper: ResearchCatalog['papers'][number]) => Promise<T>): Promise<T> {
    return this.serialized(() => this.files.withLock(async () => {
      const catalog = await this.files.read()
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      return operation(paper)
    }))
  }

  /**
   * Explicitly retry complete Markdown extraction without changing the PDF or notebooks.
   * @param paperId - owning paper with an attached original.
   * @returns confirmed extraction status and catalog; conversion failures remain visible on the paper.
   */
  extractMarkdown(paperId: ResearchPaperId): Promise<ResearchCatalog> {
    return this.serialized(() => this.files.withLock(async () => {
      const catalog = await this.files.read()
      const paper = catalog.papers.find(item => item.id === paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: paperId })
      if (paper.pdfPath === '') throw new RemoteError('research/invalid', 'Attach the original PDF before extracting Markdown', { field: 'pdfPath' })
      return this.accept(await this.ensureMarkdown(this.files, catalog, paperId))
    }))
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
   * Rename a Topic without changing its Session, notes, directory, or child-paper associations.
   * @param request - Topic, replacement title, and title last displayed to the editor.
   * @returns the committed catalog; an already-applied rename succeeds without another write.
   */
  renameTopic(request: ResearchRenameTopicRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      const title = requiredText(request.title, 'title')
      const topic = catalog.topics.find(item => item.id === request.topicId)
      if (topic === undefined) throw new RemoteError('research/not-found', 'Topic not found', { id: request.topicId })
      if (topic.title === title) return catalog
      if (topic.title !== request.expectedTitle) {
        throw new RemoteError('research/topic-conflict', 'The Topic name changed; reopen the editor with the current name', {
          topicId: topic.id, title: topic.title,
        })
      }
      return { ...catalog, topics: catalog.topics.map(item => item.id === topic.id ? { ...item, title } : item) }
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
   * Persist one selection or remove it without replacing other annotations.
   * @param request - paper identity and idempotent annotation change.
   * @returns the committed catalog; failed writes retain previously confirmed highlights.
   */
  highlight(request: ResearchHighlightRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      if (paper.pdfPath === '') throw new RemoteError('research/invalid', 'Attach the original PDF before highlighting it', { field: 'pdfPath' })
      const previous = paper.highlights ?? []
      let highlights: typeof previous
      const change = request.change
      switch (change.type) {
        case 'add': {
          const parsed = researchHighlightSchema.safeParse(change.highlight)
          if (!parsed.success) throw new RemoteError('research/invalid', 'Select text inside the original PDF', { field: 'highlight' })
          const existing = previous.find(item => item.id === parsed.data.id)
          if (existing !== undefined) {
            if (JSON.stringify(existing) === JSON.stringify(parsed.data)) return catalog
            throw new RemoteError('research/invalid', 'This highlight identity already exists', { field: 'highlight' })
          }
          highlights = [...previous, parsed.data]
          if (Buffer.byteLength(JSON.stringify(highlights)) > this.policy.maxHighlightBytes) {
            throw new RemoteError('research/invalid', 'Paper highlights exceed the configured size limit', { field: 'highlight' })
          }
          break
        }
        case 'remove': {
          highlights = previous.filter(item => item.id !== change.id)
          if (highlights.length === previous.length) return catalog
          break
        }
        default: return assertNever(change)
      }
      return { ...catalog, papers: catalog.papers.map(item => item.id === paper.id ? { ...item, highlights } : item) }
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
            return this.ensureMarkdown(destination, await destination.read())
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
      return this.ensureMarkdown(this.files, restored)
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
      if (next === previous) return this.accept(await this.ensureMarkdown(this.files, previous))
      await this.files.write({ ...next, revision: previous.revision + 1 }, previous)
      if (next.papers.length !== previous.papers.length || next.topics.length !== previous.topics.length) {
        await this.watcher?.close()
        await this.watch()
      }
      return this.accept(await this.ensureMarkdown(this.files, await this.files.read()))
    }))
  }

  private async ensureMarkdown(files: ResearchFiles, catalog: ResearchCatalog, retry?: ResearchPaperId): Promise<ResearchCatalog> {
    let confirmed = catalog
    for (const paper of catalog.papers) {
      if (paper.pdfPath === '') continue
      const path = await files.path('papers', paper.id, 'paper.md')
      if (paper.id !== retry && paper.markdown !== undefined && paper.markdown.sourceSha256 === paper.pdfSha256) {
        if (paper.markdown.status === 'failed') continue
        try { if ((await stat(path)).isFile()) continue } catch (error: unknown) { if (!missing(error)) throw error }
      }
      let sourceSha256 = paper.pdfSha256
      let markdown: NonNullable<typeof paper.markdown>
      try {
        const bytes = await importPdf(paper.pdfPath, files.directory, this.policy, this.lifetime.signal)
        const actualSha256 = digest(bytes)
        sourceSha256 = paper.pdfSha256 ?? actualSha256
        if (paper.pdfSha256 !== undefined && paper.pdfSha256 !== actualSha256) {
          throw new RemoteError('research/extraction-failed', 'The managed original changed; restore the attached PDF before retrying', { reason: 'source-changed' })
        }
        const result = await extractPaperMarkdown(paper.pdfPath, bytes, this.policy, this.lifetime.signal)
        this.lifetime.signal.throwIfAborted()
        await writeFileAtomic(path, result.text, { mode: 0o600, dirMode: 0o700 })
        markdown = { status: 'ready', sourceSha256, path: 'paper.md', pages: result.pages, backend: result.backend }
      } catch (error: unknown) {
        this.lifetime.signal.throwIfAborted()
        const failure = remoteErrorOf(error)
        const code = failure?.code === 'research/extraction-failed' ? failure.details.reason : 'conversion-failed'
        markdown = { status: 'failed', ...sourceSha256 === undefined ? {} : { sourceSha256 }, code }
        this.ctx.logger.warn('PDF Markdown extraction failed for %s (%s); original PDF and notes retained. Retry from the PDF panel: %s', paper.id, code, error)
      }
      const next = { ...confirmed, revision: confirmed.revision + 1,
        papers: confirmed.papers.map(item => item.id === paper.id
          ? { ...item, markdown, pdfSha256: item.pdfSha256 ?? sourceSha256 } : item) }
      await files.write(next, confirmed)
      confirmed = await files.read()
    }
    return confirmed
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
    const confirmed: ResearchCatalog = { ...catalog, capabilities: { pdfHighlights: true, pdfTranslations: true } }
    if (catalog.revision !== this.snapshot.revision || catalog.directory !== this.snapshot.directory) {
      this.snapshot = confirmed
      for (const follower of this.followers) follower.push({ type: 'changed', catalog: confirmed })
    }
    return confirmed
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
    return this.files.withLock(async () => {
      // Recover pending deletions before deciding whether this Session still owns a paper folder.
      const catalog = await this.files.read()
      this.accept(catalog)
      return this.archiveCopy(session, catalog)
    })
  }

  private async archiveCopy(session: Session, catalog: ResearchCatalog): Promise<number | undefined> {
    const paper = catalog.papers.find(item => item.sessionId === session.id)
    const topic = catalog.topics.find(item => item.sessionId === session.id)
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

function assertNever(value: never): never { throw new Error(`Unexpected highlight change: ${String(value)}`) }
