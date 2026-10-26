/** React-free research catalog, retaining the last confirmed data after failures. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ResearchFileRequest, ResearchDirectoryListing, ResearchFileContent, ResearchSaveFileRequest, ResearchRenameTopicRequest,
} from '../research-types.ts'
import type { ResearchCreateConversationRequest, ResearchUpdateConversationRequest } from '../research-types.ts'
import type { ResearchReorderPapersRequest } from '../research-types.ts'
import type { WorkspaceRemote } from './model.ts'
import type { ResearchTranslation, ResearchTranslationRequest, ResearchTranslationHistoryEntry } from '../research-translation-types.ts'
import type {
  ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchSaveNoteRequest, ResearchPaperId,
  ResearchDeletePaperRequest, ResearchDeleteTopicRequest,
  ResearchDirectoryRequest, ResearchImportPaperRequest, ResearchHighlightRequest,
} from '../research-types.ts'

/** Confirmed catalog and explicit transport lifecycle. */
export interface ResearchSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly catalog: ResearchCatalog
}

/** Host commands with revision-ordered response publication. */
export class ClientResearchModel {
  /** Confirmed catalog and recoverable read status. */
  readonly state: SnapshotStore<ResearchSnapshot> = createSnapshotStore<ResearchSnapshot>({
    phase: 'loading', catalog: { revision: 0, topics: [], papers: [] },
  })

  /**
   * @param remote - generated Workspace namespace.
   */
  constructor(private readonly remote: Pick<WorkspaceRemote,
    'researchReorderPapers' | 'researchCreateConversation' | 'researchUpdateConversation' | 'researchRenameTopic' | 'researchDeleteTopic' | 'researchDeletePaper' | 'researchListFiles' | 'researchReadFile' | 'researchSaveFile' | 'researchList' | 'researchCreateTopic' | 'researchCreatePaper' | 'researchSaveNote' | 'researchMentions' | 'researchConfigure' | 'researchImportPaper' | 'researchHighlight' | 'researchExtractMarkdown' | 'researchTranslate' | 'researchSaveTranslation' | 'researchListTranslations'>) {}

  /**
   * Save a Topic's reading order and publish only the confirmed response.
   * @param request - complete target order and last confirmed order.
   */
  async reorderPapers(request: ResearchReorderPapersRequest): Promise<void> {
    const result = await this.remote.researchReorderPapers(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Attach an independent conversation and accept its confirmed metadata.
   * @param request - paper and a fresh independent Session.
   */
  async createConversation(request: ResearchCreateConversationRequest): Promise<void> {
    const result = await this.remote.researchCreateConversation(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Update conversation settings and publish the confirmed library.
   * @param request - conversation name, pin or archive changes.
   */
  async updateConversation(request: ResearchUpdateConversationRequest): Promise<void> {
    const result = await this.remote.researchUpdateConversation(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Delete a confirmed Topic and its exclusive papers; shared papers retain their other Topics.
   * @param request - Topic and all displayed exclusive-paper directories.
   */
  async deleteTopic(request: ResearchDeleteTopicRequest): Promise<void> {
    const result = await this.remote.researchDeleteTopic(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Delete a paper after explicit directory confirmation and publish the remaining catalog.
   * @param request - paper identity and confirmed absolute directory.
   */
  async deletePaper(request: ResearchDeletePaperRequest): Promise<void> {
    const result = await this.remote.researchDeletePaper(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * List direct children inside the selected paper.
   * @param request - paper-relative directory.
   * @returns current direct children.
   */
  async listFiles(request: ResearchFileRequest): Promise<ResearchDirectoryListing> {
    const result = await this.remote.researchListFiles(request)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Read a complete file preview inside the selected paper.
   * @param request - paper-relative file.
   * @returns bounded preview contents.
   */
  async readFile(request: ResearchFileRequest): Promise<ResearchFileContent> {
    const result = await this.remote.researchReadFile(request)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Save a Markdown draft without replacing intervening edits.
   * @param request - Markdown draft with base hash.
   * @returns the acknowledged version.
   */
  async saveFile(request: ResearchSaveFileRequest): Promise<ResearchFileContent> {
    const result = await this.remote.researchSaveFile(request)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Translate one explicit PDF selection without replacing catalog state.
   * @param request - owning paper and original text-item positions.
   * @param signal - current selection's lifetime.
   * @returns a confirmed explanation; failures retain the caller's selection.
   */
  async translate(request: ResearchTranslationRequest, signal: AbortSignal): Promise<ResearchTranslation> {
    const result = await this.remote.researchTranslate(request, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Read saved explanations for the current original without changing catalog state.
   * @param paperId - owning paper.
   * @param signal - reader lifetime.
   * @returns saved explanations and their available PDF locations.
   */
  async listTranslations(paperId: ResearchPaperId, signal: AbortSignal): Promise<readonly ResearchTranslationHistoryEntry[]> {
    const result = await this.remote.researchListTranslations(paperId, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Append one saved explanation to learning notes and publish the acknowledged revision.
   * @param paperId - owning paper.
   * @param key - confirmed translation occurrence.
   */
  async saveTranslation(paperId: ResearchPaperId, key: string): Promise<void> {
    const result = await this.remote.researchSaveTranslation(paperId, key)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /** Fetch current durable data; failures preserve existing catalog entries. */
  async refresh(): Promise<void> {
    try {
      const result = await this.remote.researchList()
      if (!result.ok) throw result.error
      this.accept(result.value)
    } catch (error) {
      this.state.set({ ...this.state.getSnapshot(), phase: 'error' })
      throw error
    }
  }

  /**
   * Apply the requested research operation.
   * @param request - Topic identity and session binding.
   */
  async createTopic(request: ResearchCreateTopicRequest): Promise<void> {
    const result = await this.remote.researchCreateTopic(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Rename a Topic and publish the acknowledged catalog revision.
   * @param request - Topic, proposed name, and the editor's last confirmed name.
   */
  async renameTopic(request: ResearchRenameTopicRequest): Promise<void> {
    const result = await this.remote.researchRenameTopic(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Apply the requested research operation.
   * @param request - paper metadata and independent session binding.
   */
  async createPaper(request: ResearchCreatePaperRequest): Promise<void> {
    const result = await this.remote.researchCreatePaper(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Apply the requested research operation.
   * @param request - notebook edit and its last confirmed revision.
   */
  async saveNote(request: ResearchSaveNoteRequest): Promise<void> {
    const result = await this.remote.researchSaveNote(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Persist one PDF annotation change and publish the acknowledged library.
   * @param request - paper identity and addition or removal.
   */
  async highlight(request: ResearchHighlightRequest): Promise<void> {
    const result = await this.remote.researchHighlight(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Retry the paper's complete Markdown extraction and publish its confirmed status.
   * @param paperId - paper with an attached original.
   */
  async extractMarkdown(paperId: ResearchPaperId): Promise<void> {
    const result = await this.remote.researchExtractMarkdown(paperId)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Accept confirmed data while ignoring stale mutation responses.
   * @param catalog - full confirmed snapshot; stale mutation echoes cannot replace a newer snapshot.
   */
  accept(catalog: ResearchCatalog): void {
    const previous = this.state.getSnapshot().catalog
    this.state.set({ phase: 'ready', catalog: catalog.revision >= previous.revision ? catalog : previous })
  }

  /**
   * Replace the catalog at stream reconnection.
   * @param catalog - opening snapshot for a new transport generation.
   */
  replace(catalog: ResearchCatalog): void { this.state.set({ phase: 'ready', catalog }) }

  /** Retain confirmed content while visibly reporting an observation failure. */
  failed(): void { this.state.set({ ...this.state.getSnapshot(), phase: 'error' }) }

  /**
   * Open or migrate a managed library.
   * @param request - selected absolute directory and explicit open or migration mode.
   */
  async configure(request: ResearchDirectoryRequest): Promise<void> {
    const result = await this.remote.researchConfigure(request)
    if (!result.ok) throw result.error
    this.accept(result.value)
  }

  /**
   * Import a source into the managed library.
   * @param request - PDF source and Topic.
   * @returns selected paper, including reused imports.
   */
  async importPaper(request: ResearchImportPaperRequest): Promise<ResearchPaperId> {
    const result = await this.remote.researchImportPaper(request)
    if (!result.ok) throw result.error
    this.accept(result.value.catalog)
    return result.value.paperId
  }

  /**
   * Prepare canonical references for selected paper sessions.
   * @param paperIds - selected papers.
   * @returns canonical session mentions prepared by the Host.
   */
  async mentions(paperIds: readonly ResearchPaperId[]): Promise<readonly string[]> {
    const result = await this.remote.researchMentions(paperIds)
    if (!result.ok) throw result.error
    return result.value
  }
}
