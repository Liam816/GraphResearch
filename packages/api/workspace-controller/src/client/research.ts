/** React-free research catalog, retaining the last confirmed data after failures. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceRemote } from './model.ts'
import type {
  ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchSaveNoteRequest, ResearchPaperId,
  ResearchDirectoryRequest, ResearchImportPaperRequest,
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

  /** @param remote - generated Workspace namespace. */
  constructor(private readonly remote: Pick<WorkspaceRemote,
    'researchList' | 'researchCreateTopic' | 'researchCreatePaper' | 'researchSaveNote' | 'researchMentions' | 'researchConfigure' | 'researchImportPaper'>) {}

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
