/** Durable research catalog and serialized notebook mutations. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { ResearchCatalog, ResearchCreatePaperRequest, ResearchCreateTopicRequest, ResearchPaperId, ResearchSaveNoteRequest, ResearchTopicId } from './research-types.ts'

const notebook = z.object({ text: z.string(), revision: z.number().int().nonnegative() })
const catalogSchema: z.ZodType<ResearchCatalog> = z.object({
  revision: z.number().int().nonnegative(),
  topics: z.array(z.object({
    id: z.string().transform(value => brandString<ResearchTopicId>(value)),
    title: z.string(),
    workspaceId: z.string().transform(value => brandString<ResearchCreateTopicRequest['workspaceId']>(value)),
    sessionId: z.string().transform(value => brandString<ResearchCreateTopicRequest['sessionId']>(value)),
  })),
  papers: z.array(z.object({
    id: z.string().transform(value => brandString<ResearchPaperId>(value)),
    title: z.string(),
    topicIds: z.array(z.string().transform(value => brandString<ResearchTopicId>(value))),
    sessionId: z.string().transform(value => brandString<ResearchCreatePaperRequest['sessionId']>(value)),
    pdfPath: z.string(), repositoryUrl: z.string(), ai: notebook, learning: notebook,
  })),
})

const researchDomain = defineDomain({
  name: 'research', version: 1,
  global: { schema: catalogSchema, initial: { revision: 0, topics: [], papers: [] } },
  tables: {},
})

/** Host-owned catalog; failed persistence leaves the previous catalog readable. */
export class ResearchCatalogHost {
  private readonly ready: Promise<Domain<typeof researchDomain>>
  private writes: Promise<void> = Promise.resolve()

  /** @param ctx - Workspace and Session authorities plus the configured storage facility. */
  constructor(private readonly ctx: Context) {
    this.ready = ctx.storageDomain.open(researchDomain)
    ctx.effect(() => async () => {
      await this.writes
      const domain = await this.ready
      await domain.close()
    }, 'workspace-controller: research catalog')
  }

  /**
   * Read the confirmed research catalog.
   * @returns the latest durable catalog.
   */
  async read(): Promise<ResearchCatalog> {
    return (await this.ready).global.get()
  }

  /**
   * Apply the requested research operation.
   * @param request - Topic title and its newly created Session.
   * @returns the committed catalog.
   */
  createTopic(request: ResearchCreateTopicRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      this.validateSession(request.workspaceId, request.sessionId)
      const title = requiredText(request.title, 'title')
      const existing = catalog.topics.find(topic => topic.sessionId === request.sessionId)
      if (existing !== undefined && existing.workspaceId === request.workspaceId && existing.title === title) return catalog
      if (existing !== undefined || catalog.papers.some(paper => paper.sessionId === request.sessionId)) {
        throw new RemoteError('research/invalid', 'Each entity requires an independent Session', { field: 'sessionId' })
      }
      return { ...catalog, topics: [...catalog.topics, { ...request, title, id: brandString<ResearchTopicId>(randomUUID()) }] }
    })
  }

  /**
   * Apply the requested research operation.
   * @param request - Paper metadata and its newly created Session.
   * @returns the committed catalog.
   */
  createPaper(request: ResearchCreatePaperRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      const topic = catalog.topics.find(item => item.id === request.topicId)
      if (topic === undefined) throw new RemoteError('research/not-found', 'Topic not found', { id: request.topicId })
      this.validateSession(topic.workspaceId, request.sessionId)
      const title = requiredText(request.title, 'title')
      const pdfPath = requiredText(request.pdfPath, 'pdfPath')
      if (!pdfPath.toLowerCase().endsWith('.pdf')) throw new RemoteError('research/invalid', 'Select a PDF file', { field: 'pdfPath' })
      const repositoryUrl = request.repositoryUrl.trim()
      if (repositoryUrl !== '') {
        let url: URL
        try { url = new URL(repositoryUrl) } catch (error) {
          throw new RemoteError('research/invalid', 'Repository URL must be an HTTP(S) URL', { field: 'repositoryUrl' }, { cause: error })
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RemoteError('research/invalid', 'Repository URL must be an HTTP(S) URL', { field: 'repositoryUrl' })
      }
      const existing = catalog.papers.find(paper => paper.sessionId === request.sessionId)
      if (existing !== undefined && existing.title === title && existing.pdfPath === pdfPath
        && existing.repositoryUrl === repositoryUrl && existing.topicIds.includes(topic.id)) return catalog
      if (existing !== undefined || catalog.topics.some(item => item.sessionId === request.sessionId)) {
        throw new RemoteError('research/invalid', 'Each entity requires an independent Session', { field: 'sessionId' })
      }
      const paper = {
        id: brandString<ResearchPaperId>(randomUUID()), title, topicIds: [topic.id],
        sessionId: request.sessionId, pdfPath, repositoryUrl,
        ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 },
      }
      return { ...catalog, papers: [...catalog.papers, paper] }
    })
  }

  /**
   * Apply the requested research operation.
   * @param request - Revision-checked notebook edit.
   * @returns the committed catalog; conflicts leave the notebook unchanged.
   */
  saveNote(request: ResearchSaveNoteRequest): Promise<ResearchCatalog> {
    return this.mutate((catalog) => {
      const paper = catalog.papers.find(item => item.id === request.paperId)
      if (paper === undefined) throw new RemoteError('research/not-found', 'Paper not found', { id: request.paperId })
      const note = paper[request.kind]
      if (note.revision !== request.expectedRevision) {
        throw new RemoteError('research/note-conflict', 'The notebook changed in another window', {
          paperId: paper.id, kind: request.kind, revision: note.revision,
        })
      }
      return { ...catalog, papers: catalog.papers.map(item => item.id === paper.id
        ? { ...item, [request.kind]: { text: request.text, revision: note.revision + 1 } }
        : item) }
    })
  }

  private validateSession(workspaceId: ResearchCreateTopicRequest['workspaceId'], sessionId: ResearchCreateTopicRequest['sessionId']): void {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) {
      throw new RemoteError('research/invalid', 'Session must belong to the selected workspace', { field: 'sessionId' })
    }
  }

  private mutate(update: (catalog: ResearchCatalog) => ResearchCatalog): Promise<ResearchCatalog> {
    const operation = this.writes.then(async () => {
      const domain = await this.ready
      const previous = domain.global.get()
      const next = update(previous)
      if (next === previous) return previous
      const committed = { ...next, revision: previous.revision + 1 }
      await domain.global.set(committed)
      return committed
    })
    this.writes = operation.then(() => {}, (_error: unknown) => {
      // The failed write preserved the old domain value; later independent edits may proceed.
    })
    return operation
  }
}

function requiredText(value: string, field: string): string {
  const text = value.trim()
  if (text === '') throw new RemoteError('research/invalid', 'This field is required', { field })
  return text
}
