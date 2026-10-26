/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import { paperConversations, paperForSession } from './research-conversations.ts'
import type { ResearchCreateConversationRequest, ResearchUpdateConversationRequest } from './research-types.ts'
import { ResearchCatalogHost } from './research.ts'
import { PaperTranslations } from './research-translation.ts'
import type {
  ResearchFileRequest, ResearchDirectoryListing, ResearchFileContent, ResearchSaveFileRequest, ResearchRenameTopicRequest,
} from './research-types.ts'
import type { ResearchTranslation, ResearchTranslationRequest, ResearchTranslationHistoryEntry } from './research-translation-types.ts'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ResearchAgent from './research-agent.ts'
import * as UiAgent from './ui-agent.ts'
import { UiModuleRegistry } from './ui-modules.ts'
import { researchDirectoryModule } from './research-ui.ts'
import type { ResearchReorderPapersRequest, ResearchReorderTopicsRequest } from './research-types.ts'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type {
  ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchSaveNoteRequest, ResearchPaperId,
  ResearchDeletePaperRequest, ResearchDeleteTopicRequest,
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
export type { UiModule, UiModuleContext, UiModuleDescriptor, UiModuleInput, UiModuleValue } from './ui-modules.ts'

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
  /** Auxiliary paper-translation deadline in milliseconds. */
  researchTranslationTimeoutMs?: number
  /** Maximum characters in the complete selected sentence context. */
  researchTranslationMaxContextCharacters?: number
  /** Maximum generated tokens in one structured explanation. */
  researchTranslationMaxOutputTokens?: number
  /** Maximum serialized model or dictionary response bytes. */
  researchTranslationMaxResponseBytes?: number
  /** Maximum translation-history bytes per paper. */
  researchTranslationMaxStoredBytes?: number
  /** Maximum derived PDF text-index bytes per paper. */
  researchTranslationMaxIndexBytes?: number
  /** English dictionary endpoint; empty disables external phonetic lookup. */
  researchDictionaryEndpoint?: string
  /** Optional phonetic-lookup deadline in milliseconds. */
  researchDictionaryTimeoutMs?: number
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
    researchTranslationTimeoutMs: z.natural().min(1).default(60_000),
    researchTranslationMaxContextCharacters: z.natural().min(1).default(16_000),
    researchTranslationMaxOutputTokens: z.natural().min(1).default(2048),
    researchTranslationMaxResponseBytes: z.natural().min(1).default(256 * 1024),
    researchTranslationMaxStoredBytes: z.natural().min(1).default(8 * 1024 * 1024),
    researchTranslationMaxIndexBytes: z.natural().min(1).default(32 * 1024 * 1024),
    researchDictionaryEndpoint: z.string().default('https://api.dictionaryapi.dev/api/v2/entries/en'),
    researchDictionaryTimeoutMs: z.natural().min(1).default(4000),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed
  private readonly research: ResearchCatalogHost
  private readonly translations: PaperTranslations
  private readonly researchAgents = new WeakSet<Agent>()
  private readonly researchEntityAgents = new WeakSet<Agent>()
  /** Explicit interface operations shared by every Agent; contributions register through ctx.effect. */
  readonly uiModules: UiModuleRegistry = new UiModuleRegistry()
  private readonly uiAgents = new WeakSet<Agent>()

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - first-use directory policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    if (this.config.researchDictionaryEndpoint !== '') {
      const url = new URL(this.config.researchDictionaryEndpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        throw new Error('researchDictionaryEndpoint must be an HTTP(S) URL without credentials, query or fragment')
      }
    }
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
    this.translations = new PaperTranslations(ctx, {
      timeoutMs: this.config.researchTranslationTimeoutMs, maxContextCharacters: this.config.researchTranslationMaxContextCharacters,
      maxOutputTokens: this.config.researchTranslationMaxOutputTokens, maxResponseBytes: this.config.researchTranslationMaxResponseBytes,
      maxStoredBytes: this.config.researchTranslationMaxStoredBytes, maxIndexBytes: this.config.researchTranslationMaxIndexBytes,
      maxPdfBytes: this.config.researchMaxPdfBytes,
      dictionaryEndpoint: this.config.researchDictionaryEndpoint, dictionaryTimeoutMs: this.config.researchDictionaryTimeoutMs,
      maxNoteBytes: this.config.researchMaxNoteBytes, lockTimeoutMs: this.config.researchLockTimeoutMs,
    }, { read: () => this.research.read(), saveNote: request => this.research.saveNote(request) })
    ctx.effect(() => this.uiModules.register(researchDirectoryModule({
      list: () => this.researchList(), reorder: request => this.researchReorderPapers(request),
      reorderTopics: request => this.researchReorderTopics(request),
    })))
    ctx.on('agent/created', async ({ agent }) => {
      await this.bindUiAgent(agent)
      const catalog = this.research.current()
      await this.bindResearchAgent(agent,
        catalog.topics.some(item => item.sessionId === agent.id) || paperForSession(catalog, agent.id) !== undefined)
    })
    ctx.inject(['agents'], async () => {
      for (const agent of ctx.agents.list()) {
        await this.bindUiAgent(agent)
        const catalog = this.research.current()
        await this.bindResearchAgent(agent,
          catalog.topics.some(item => item.sessionId === agent.id) || paperForSession(catalog, agent.id) !== undefined)
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
   * Persist a Topic name while retaining its identity and research resources.
   * @param request - Topic, replacement title, and last displayed title for conflict detection.
   * @returns the committed catalog; stale names reject without replacing the latest title.
   */
  @Remote('researchRenameTopic')
  researchRenameTopic(request: ResearchRenameTopicRequest): Promise<ResearchCatalog> { return this.research.renameTopic(request) }

  /**
   * Replace one Topic's complete paper order after checking its last observed order.
   * @param request - current membership in desired and last observed order.
   * @returns committed catalog broadcast to connected readers.
   */
  @Remote('researchReorderPapers')
  researchReorderPapers(request: ResearchReorderPapersRequest): Promise<ResearchCatalog> { return this.research.reorderPapers(request) }

  /**
   * Replace the complete Topic directory order after checking the last observed catalog order.
   * @param request - every Topic in the desired and previously observed order.
   * @returns committed catalog broadcast to all connected readers.
   */
  @Remote('researchReorderTopics')
  researchReorderTopics(request: ResearchReorderTopicsRequest): Promise<ResearchCatalog> { return this.research.reorderTopics(request) }

  /**
   * Remove a Topic and its exclusive papers, preserving shared papers and archived histories.
   * @param request - Topic and every exclusive paper directory confirmed by the user.
   * @returns the remaining catalog after recoverable deletion completes.
   */
  @Remote('researchDeleteTopic')
  researchDeleteTopic(request: ResearchDeleteTopicRequest): Promise<ResearchCatalog> { return this.research.deleteTopic(request) }

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
   * Attach a fresh independent Session to a paper.
   * @param request - paper and the newly created Session.
   * @returns the catalog with the attached conversation.
   */
  @Remote('researchCreateConversation')
  async researchCreateConversation(request: ResearchCreateConversationRequest): Promise<ResearchCatalog> {
    const catalog = await this.research.createConversation(request)
    await this.bindResearchAgents(catalog)
    return catalog
  }

  /**
   * Rename, pin, archive, or restore a paper conversation.
   * @param request - conversation metadata changes.
   * @returns the committed library.
   */
  @Remote('researchUpdateConversation')
  researchUpdateConversation(request: ResearchUpdateConversationRequest): Promise<ResearchCatalog> {
    return this.research.updateConversation(request)
  }

  /**
   * Permanently remove one paper's directory and catalog entry, retaining its archived native Session.
   * @param request - paper identity and the absolute directory confirmed by the user.
   * @returns the remaining library after deletion completes.
   */
  @Remote('researchDeletePaper')
  researchDeletePaper(request: ResearchDeletePaperRequest): Promise<ResearchCatalog> { return this.research.deletePaper(request) }

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
   * List direct children inside the selected paper.
   * @param request - paper identity and relative directory.
   * @returns direct children inside that paper.
   */
  @Remote('researchListFiles')
  researchListFiles(request: ResearchFileRequest): Promise<ResearchDirectoryListing> { return this.research.listFiles(request) }

  /**
   * Read a complete file preview inside the selected paper.
   * @param request - paper identity and relative file.
   * @returns bounded text or image contents for preview.
   */
  @Remote('researchReadFile')
  researchReadFile(request: ResearchFileRequest): Promise<ResearchFileContent> { return this.research.readFile(request) }

  /**
   * Save a Markdown draft without replacing intervening edits.
   * @param request - Markdown edit and last read content version.
   * @returns acknowledged content; stale edits never replace disk contents.
   */
  @Remote('researchSaveFile')
  researchSaveFile(request: ResearchSaveFileRequest): Promise<ResearchFileContent> { return this.research.saveFile(request) }

  /**
   * Add or remove a PDF text highlight without replacing concurrent annotations.
   * @param request - owning paper and idempotent change.
   * @returns the committed library snapshot.
   */
  @Remote('researchHighlight')
  researchHighlight(request: ResearchHighlightRequest): Promise<ResearchCatalog> { return this.research.highlight(request) }

  /**
   * Explain an explicitly selected original passage with two surrounding sentences on each side.
   * @param request - paper identity, selected text and PDF text-item positions.
   * @param signal - caller cancellation.
   * @returns a durably recorded explanation; failures retain the original and notebooks.
   */
  @Remote('researchTranslate')
  researchTranslate(request: ResearchTranslationRequest, signal: AbortSignal): Promise<ResearchTranslation> {
    return this.translations.translate(request, signal)
  }

  /**
   * Read saved explanations and reader locations for the paper's current PDF without inference.
   * @param paperId - owning paper.
   * @param signal - caller lifetime.
   * @returns saved explanations; ambiguous older locations remain absent.
   */
  @Remote('researchListTranslations')
  researchListTranslations(paperId: ResearchPaperId, signal: AbortSignal): Promise<readonly ResearchTranslationHistoryEntry[]> {
    return this.translations.list(paperId, signal)
  }

  /**
   * Append a confirmed translation and original-page link to learning notes exactly once.
   * @param paperId - owning paper.
   * @param key - saved translation occurrence key.
   * @returns confirmed catalog; a conflict preserves the notebook and can be retried.
   */
  @Remote('researchSaveTranslation')
  researchSaveTranslation(paperId: ResearchPaperId, key: string): Promise<ResearchCatalog> {
    return this.translations.saveNote(paperId, key)
  }

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
   * @param sessionId - optional owning conversation; omission updates the original paper continuation.
   * @returns committed library.
   */
  @Remote('researchProgress')
  researchProgress(paperId: ResearchPaperId, text: string, sessionId?: SessionId): Promise<ResearchCatalog> {
    return this.research.progress(paperId, text, sessionId)
  }

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
    const sessions = [...catalog.topics.map(item => item.sessionId),
      ...catalog.papers.flatMap(paper => paperConversations(paper).map(item => item.sessionId))]
    for (const id of sessions) {
      const agent = agents.get(id)
      if (agent !== undefined) await this.bindResearchAgent(agent, true)
    }
  }

  private async bindUiAgent(agent: Agent): Promise<void> {
    if (this.uiAgents.has(agent)) return
    this.uiAgents.add(agent)
    try {
      const fiber = await agent.ctx.plugin(UiAgent)
      this.ctx.effect(() => () => fiber.dispose(), 'workspace-controller: interface Agent tools')
    } catch (error: unknown) { this.uiAgents.delete(agent); throw error }
  }

  private async bindResearchAgent(agent: Agent, entity = false): Promise<void> {
    if (entity && !this.researchEntityAgents.has(agent)) {
      this.researchEntityAgents.add(agent)
      try { await this.research.captureSession(agent.session) }
      catch (error: unknown) { this.researchEntityAgents.delete(agent); throw error }
    }
    if (this.researchAgents.has(agent)) return
    this.researchAgents.add(agent)
    try {
      const fiber = await agent.ctx.plugin(ResearchAgent)
      this.ctx.effect(() => () => fiber.dispose(), 'workspace-controller: research Agent tools')
    } catch (error: unknown) { this.researchAgents.delete(agent); throw error }
  }
}

export default WorkspaceController
