/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import { ResearchCatalogHost } from './research.ts'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ResearchAgent from './research-agent.ts'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type {
  ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchSaveNoteRequest, ResearchPaperId,
  ResearchDirectoryRequest, ResearchFollowFrame, ResearchImportPaperRequest, ResearchReadPaperRequest, ResearchPaperText, ResearchTopicId,
  ResearchAttachPdfRequest, ResearchHighlightRequest,
} from './research-types.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

/** First-use directory policy for the Host account. */
export interface Config {
  /** Override the system Documents directory with a fully qualified path. */
  documentsDirectory?: string
  /** Maximum duration of the operating system's Documents lookup. */
  documentsLookupTimeoutMs?: number
  /** Absolute initial research library; the persisted selection takes precedence after first use. */
  researchDirectory?: string
  /** Maximum bytes in one Markdown notebook. */
  researchMaxNoteBytes?: number
  /** Maximum serialized highlight bytes per paper. */
  researchMaxHighlightBytes?: number
  /** Maximum bytes in one imported PDF. */
  researchMaxPdfBytes?: number
  /** PDF download timeout in milliseconds. */
  researchDownloadTimeoutMs?: number
  /** Maximum pages in one Agent reading call. */
  researchMaxReadPages?: number
  /** Maximum original characters returned by one reading call. */
  researchMaxReadCharacters?: number
  /** Whole-paper text backend; auto prefers Poppler and falls back to PDF.js. */
  researchPdfTextBackend?: 'auto' | 'pdfjs' | 'pdftotext'
  /** Maximum UTF-8 bytes in complete generated paper.md, including page headings. */
  researchMaxMarkdownBytes?: number
  /** Whole-paper conversion deadline in milliseconds. */
  researchMarkdownTimeoutMs?: number
  /** Maximum wait for another library writer in milliseconds. */
  researchLockTimeoutMs?: number
  /** File must remain stable for this many milliseconds before external edits are published. */
  researchWatchStabilityMs?: number
  /** File stability polling interval in milliseconds. */
  researchWatchPollMs?: number
}

/** Directory policy after schema defaults have been applied. */
type ResolvedConfig = Required<Omit<Config, 'documentsDirectory'>> & Pick<Config, 'documentsDirectory'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'storageDomain', 'sessionController', 'agents', 'sessions', 'sessionPersistence']

  /**
   * Prepare canonical references for selected paper sessions.
   * @param paperIds - up to three paper identities.
   * @returns canonical prompt references for the selected paper sessions.
   */
  @Remote('researchMentions')
  async researchMentions(paperIds: readonly ResearchPaperId[]): Promise<readonly string[]> {
    const catalog = await this.research.read()
    if (paperIds.length > 3) throw new RemoteError('research/invalid', 'Select at most three papers', { field: 'paperIds' })
    return paperIds.map((id) => {
      const paper = catalog.papers.find(item => item.id === id)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Research paper does not exist', { id })
      return formatSessionReferenceMention({ sessionId: paper.sessionId, label: paper.title })
    })
  }

  static Config: z<Config, ResolvedConfig> = z.object({
    documentsDirectory: z.string(),
    documentsLookupTimeoutMs: z.natural().min(1).default(10_000),
    researchDirectory: z.string().default(resolve(process.cwd(), 'data')),
    researchMaxNoteBytes: z.natural().min(1).default(8 * 1024 * 1024),
    researchMaxHighlightBytes: z.natural().min(1).default(4 * 1024 * 1024),
    researchMaxPdfBytes: z.natural().min(1).default(64 * 1024 * 1024),
    researchDownloadTimeoutMs: z.natural().min(1).default(60_000),
    researchMaxReadPages: z.natural().min(1).default(20),
    researchMaxReadCharacters: z.natural().min(1).default(60_000),
    researchPdfTextBackend: z.union(['auto', 'pdfjs', 'pdftotext']).default('auto'),
    researchMaxMarkdownBytes: z.natural().min(1).default(8 * 1024 * 1024),
    researchMarkdownTimeoutMs: z.natural().min(1).default(60_000),
    researchLockTimeoutMs: z.natural().min(1).default(10_000),
    researchWatchStabilityMs: z.natural().min(1).default(250),
    researchWatchPollMs: z.natural().min(1).default(100),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed
  private readonly research: ResearchCatalogHost
  private readonly researchAgents = new WeakSet<Agent>()

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - first-use directory policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    this.research = new ResearchCatalogHost(ctx, {
      directory: this.config.researchDirectory, maxNoteBytes: this.config.researchMaxNoteBytes,
      maxPdfBytes: this.config.researchMaxPdfBytes, downloadTimeoutMs: this.config.researchDownloadTimeoutMs,
      maxReadPages: this.config.researchMaxReadPages, maxReadCharacters: this.config.researchMaxReadCharacters,
      maxHighlightBytes: this.config.researchMaxHighlightBytes,
      pdfTextBackend: this.config.researchPdfTextBackend, maxMarkdownBytes: this.config.researchMaxMarkdownBytes,
      markdownTimeoutMs: this.config.researchMarkdownTimeoutMs,
      lockTimeoutMs: this.config.researchLockTimeoutMs,
      watchStabilityMs: this.config.researchWatchStabilityMs, watchPollMs: this.config.researchWatchPollMs,
    })
    ctx.on('agent/created', async ({ agent }) => {
      const catalog = this.research.current()
      if (catalog.topics.some(item => item.sessionId === agent.id) || catalog.papers.some(item => item.sessionId === agent.id)) {
        await this.bindResearchAgent(agent)
      }
    })
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Initialize or reuse the default Workspace during first-use startup. The
   * directory name is fixed, so the Host never renames or relocates an
   * existing default; its initial title is that same name, which browser
   * consumers label in the reader's language.
   * @param signal - caller lifetime; cancels native directory lookup.
   * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
   */
  @Remote('initializeDefault')
  async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
    const workspace = await this.ctx.workspaceRegistry.initializeDefault(async () => {
      const timeout = AbortSignal.timeout(this.config.documentsLookupTimeoutMs)
      return await defaultWorkspaceDirectory(
        this.config.documentsDirectory, AbortSignal.any([signal, timeout]),
      )
    })
    return workspace === undefined ? undefined : { workspace: workspaceView(workspace) }
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * Surface one known unarchived Session ahead of unpinned Sessions.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('pinSession')
  pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.pinSession(request)
  }

  /**
   * Remove one Session's pin without changing its saved Session order.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('unpinSession')
  unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.unpinSession(request)
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }

  /**
   * Read the confirmed research catalog.
   * @returns the current durable topic, paper and notebook catalog.
   */
  @Remote('researchList')
  async researchList(): Promise<ResearchCatalog> {
    const catalog = await this.research.read()
    await this.bindResearchAgents(catalog)
    return catalog
  }

  /**
   * Apply the requested research operation.
   * @param request - Topic metadata and its independent Session.
   * @returns the committed catalog.
   */
  @Remote('researchCreateTopic')
  async researchCreateTopic(request: ResearchCreateTopicRequest): Promise<ResearchCatalog> {
    const catalog = await this.research.createTopic(request)
    await this.bindResearchAgents(catalog)
    return catalog
  }

  /**
   * Apply the requested research operation.
   * @param request - Paper metadata and its independent Session.
   * @returns the committed catalog.
   */
  @Remote('researchCreatePaper')
  async researchCreatePaper(request: ResearchCreatePaperRequest): Promise<ResearchCatalog> {
    const catalog = await this.research.createPaper(request)
    await this.bindResearchAgents(catalog)
    return catalog
  }

  /**
   * Apply the requested research operation.
   * @param request - Notebook edit and acknowledged revision.
   * @returns the committed catalog; conflicts preserve the previous notebook.
   */
  @Remote('researchSaveNote')
  researchSaveNote(request: ResearchSaveNoteRequest): Promise<ResearchCatalog> {
    return this.research.saveNote(request)
  }

  /**
   * Add or remove a PDF text highlight without replacing concurrent annotations.
   * @param request - owning paper and idempotent change.
   * @returns the committed library snapshot.
   */
  @Remote('researchHighlight')
  researchHighlight(request: ResearchHighlightRequest): Promise<ResearchCatalog> { return this.research.highlight(request) }

  /**
   * Retry full-text Markdown conversion while retaining the attached PDF and notebooks.
   * @param paperId - paper with an attached original.
   * @returns confirmed catalog with ready or failed extraction status.
   */
  @Remote('researchExtractMarkdown')
  researchExtractMarkdown(paperId: ResearchPaperId): Promise<ResearchCatalog> { return this.research.extractMarkdown(paperId) }

  /**
   * Read the confirmed in-memory library.
   * @returns confirmed research context for scoped Agent prompt providers.
   */
  researchCurrent(): ResearchCatalog { return this.research.current() }

  /**
   * Observe library and notebook changes.
   * @param signal - caller lifetime.
   * @returns full library snapshots and file-observation failures.
   */
  @Remote({ mode: 'stream' })
  researchFollow(signal: AbortSignal): AsyncIterable<ResearchFollowFrame> { return this.research.follow(signal) }

  /**
   * Select or migrate the managed library.
   * @param request - absolute destination and open or migrate operation.
   * @returns selected library after durable selection.
   */
  @Remote('researchConfigure')
  researchConfigure(request: ResearchDirectoryRequest): Promise<ResearchCatalog> { return this.research.configure(request) }

  /**
   * Register an independent Session and optionally import a local or downloaded PDF.
   * @param request - Topic, title and optional original source.
   * @param signal - caller cancellation.
   * @returns selected paper identity and its complete library projection.
   */
  @Remote('researchImportPaper')
  async researchImportPaper(
    request: ResearchImportPaperRequest, signal: AbortSignal,
  ): Promise<{ readonly catalog: ResearchCatalog; readonly paperId: ResearchPaperId }> {
    const result = await this.research.importPaper(request, async workspaceId =>
      (await this.ctx.sessionController.create({ workspaceId })).sessionId, signal)
    await this.bindResearchAgents(result.catalog)
    return result
  }

  /**
   * Supply an existing paper's PDF while preserving its Session and notebooks.
   * @param request - target paper and local or HTTP(S) PDF source.
   * @param signal - caller cancellation.
   * @returns committed library with the attached original.
   */
  @Remote('researchAttachPdf')
  researchAttachPdf(request: ResearchAttachPdfRequest, signal: AbortSignal): Promise<ResearchCatalog> {
    return this.research.attachPdf(request, signal)
  }

  /**
   * Read a bounded original page range.
   * @param request - bounded original PDF page range.
   * @param signal - cancellation.
   * @returns extracted text with original page numbers.
   */
  @Remote('researchReadPaper')
  researchReadPaper(request: ResearchReadPaperRequest, signal: AbortSignal): Promise<ResearchPaperText> {
    return this.research.readPaper(request, signal)
  }

  /**
   * Save the paper continuation point.
   * @param paperId - owning paper.
   * @param text - continuation point and questions.
   * @returns committed library.
   */
  @Remote('researchProgress')
  researchProgress(paperId: ResearchPaperId, text: string): Promise<ResearchCatalog> { return this.research.progress(paperId, text) }

  /**
   * Save a revision-checked Topic summary.
   * @param topicId - owning Topic.
   * @param text - Markdown comparison.
   * @param revision - last read revision.
   * @returns committed library.
   */
  @Remote('researchTopicNote')
  researchTopicNote(topicId: ResearchTopicId, text: string, revision: number): Promise<ResearchCatalog> {
    return this.research.topicNote(topicId, text, revision)
  }

  private async bindResearchAgents(catalog: ResearchCatalog): Promise<void> {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return
    for (const item of [...catalog.topics, ...catalog.papers]) {
      const agent = agents.get(item.sessionId)
      if (agent !== undefined) await this.bindResearchAgent(agent)
    }
  }

  private async bindResearchAgent(agent: Agent): Promise<void> {
    if (this.researchAgents.has(agent)) return
    this.researchAgents.add(agent)
    try {
      await this.research.captureSession(agent.session)
      const fiber = await agent.ctx.plugin(ResearchAgent)
      this.ctx.effect(() => () => fiber.dispose(), 'workspace-controller: research Agent tools')
    } catch (error: unknown) { this.researchAgents.delete(agent); throw error }
  }
}

export default WorkspaceController
