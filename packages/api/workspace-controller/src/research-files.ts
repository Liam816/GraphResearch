/** Managed paper files, revision recovery, and atomic Markdown publication. */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchCatalog, ResearchPaper, ResearchPaperId, ResearchTopicId, ResearchHighlight, ResearchHighlightId } from './research-types.ts'

const identity = z.string().regex(/^[A-Za-z0-9_-]+$/)
const topicId = identity.transform(value => brandString<ResearchTopicId>(value))
const paperId = identity.transform(value => brandString<ResearchPaperId>(value))
const note = z.object({ text: z.string(), revision: z.number().int().nonnegative() })
/** Validate annotation geometry at the file and Remote admission points. */
export const researchHighlightSchema: z.ZodType<ResearchHighlight> = z.object({
  id: identity.transform(value => brandString<ResearchHighlightId>(value)),
  color: z.enum(['yellow', 'green', 'blue', 'pink', 'orange']), text: z.string().trim().min(1),
  rects: z.array(z.object({
    page: z.number().int().positive(), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    width: z.number().positive().max(1), height: z.number().positive().max(1),
  }).refine(rect => rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001)).min(1),
})
const topic = z.object({
  id: topicId, title: z.string(), workspaceId: z.string().transform(value => brandString<ResearchCatalog['topics'][number]['workspaceId']>(value)),
  sessionId: z.string().transform(value => brandString<ResearchCatalog['topics'][number]['sessionId']>(value)), notes: note.optional(),
})
const paper = z.object({
  id: paperId, title: z.string(), topicIds: z.array(topicId),
  sessionId: z.string().transform(value => brandString<ResearchPaper['sessionId']>(value)),
  pdfPath: z.string(), repositoryUrl: z.string(), ai: note, learning: note,
  directory: z.string().optional(), sourceId: z.string().optional(), pdfSha256: z.string().optional(),
  source: z.string().optional(), progress: z.string().optional(),
  highlights: z.array(researchHighlightSchema).optional(),
})

/** Existing storage-domain records remain readable during first-use file migration. */
export const researchCatalogSchema: z.ZodType<ResearchCatalog> = z.object({
  revision: z.number().int().nonnegative(), topics: z.array(topic), papers: z.array(paper), directory: z.string().optional(),
})

const noteIndex = z.object({ revision: z.number().int().nonnegative(), sha256: z.string() })
const indexSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  topics: z.array(topic.omit({ notes: true }).extend({ notes: noteIndex })),
  papers: z.array(paper.omit({ ai: true, learning: true, directory: true }).extend({ ai: noteIndex, learning: noteIndex })),
})
const journalSchema = z.object({
  index: indexSchema,
  writes: z.array(z.object({
    kind: z.enum(['ai', 'learning', 'topic']), id: identity, previous: z.string().nullable(), text: z.string(),
  })),
})
type Index = z.infer<typeof indexSchema>
type Journal = z.infer<typeof journalSchema>

/** Deployment limits used by managed file operations. */
export interface ResearchFilePolicy {
  readonly maxNoteBytes: number
  readonly lockTimeoutMs: number
}

/** One library's files; callers serialize operations through withLock. */
export class ResearchFiles {
  /** @param directory - canonical library root. @param policy - validated deployment limits. */
  constructor(readonly directory: string, private readonly policy: ResearchFilePolicy) {}

  /**
   * Create or resolve an absolute library directory without following links inside its managed tree.
   * @param directory - requested Host path.
   * @param policy - validated deployment limits.
   * @returns the canonical file owner.
   */
  static async open(directory: string, policy: ResearchFilePolicy): Promise<ResearchFiles> {
    if (!isAbsolute(directory)) throw new RemoteError('research/invalid', 'Choose an absolute library directory', { field: 'directory' })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return new ResearchFiles(await realpath(directory), policy)
  }

  /**
   * Coordinate cooperating Harness writers, including other processes using the same library.
   * @param operation - complete read and mutation to run under the library lock.
   * @returns the operation result.
   */
  withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.directory, 'library.json'), operation, { waitMs: this.policy.lockTimeoutMs })
  }

  /**
   * Resolve a managed path; existing symbolic links in this tree are rejected.
   * @param parts - relative managed path components.
   * @returns absolute path inside the canonical library.
   */
  async path(...parts: string[]): Promise<string> {
    const target = resolve(this.directory, ...parts)
    const child = relative(this.directory, target)
    if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
      throw new RemoteError('research/invalid', 'Path must remain in the library', { field: 'path' })
    }
    let current = this.directory
    for (const part of child.split(sep).filter(Boolean)) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new RemoteError('research/invalid-library', 'Managed paths cannot be symbolic links', { path: current })
      } catch (error: unknown) {
        if (!missing(error)) throw error
      }
    }
    return target
  }

  /**
   * Load the index and canonical Markdown; external edits advance their notebook revisions.
   * @param initial - legacy catalog imported only when this directory has no index.
   * @returns current files projected for the browser and Agent.
   */
  async read(initial: ResearchCatalog = { revision: 0, topics: [], papers: [] }): Promise<ResearchCatalog> {
    await this.recover()
    const path = await this.path('library.json')
    let index: Index
    try { index = indexSchema.parse(JSON.parse(await readFile(path, 'utf8'))) } catch (error: unknown) {
      if (!missing(error)) throw new RemoteError('research/invalid-library', 'Cannot read the library index', { path }, { cause: error })
      await this.write(initial)
      return this.read()
    }
    let changes = 0
    const readNote = async (kind: 'ai' | 'learning' | 'topic', id: string, metadata: z.infer<typeof noteIndex>) => {
      const filename = await this.notePath(kind, id)
      const info = await stat(filename)
      if (info.size > this.policy.maxNoteBytes) throw new RemoteError('research/invalid', 'Notebook exceeds the configured size limit', { field: 'text' })
      const text = await readFile(filename, 'utf8')
      const hash = digest(text)
      if (hash !== metadata.sha256) { metadata.sha256 = hash; metadata.revision += 1; changes += 1 }
      return { text, revision: metadata.revision }
    }
    const topics: ResearchCatalog['topics'][number][] = []
    for (const item of index.topics) topics.push({ ...item, notes: await readNote('topic', item.id, item.notes) })
    const papers: ResearchPaper[] = []
    for (const item of index.papers) papers.push({
      ...item, directory: await this.path('papers', item.id), pdfPath: item.pdfPath === '' ? '' : await this.path('papers', item.id, 'paper.pdf'),
      ai: await readNote('ai', item.id, item.ai), learning: await readNote('learning', item.id, item.learning),
    })
    if (changes > 0) { index.revision += 1; await this.writeIndex(index) }
    return { revision: index.revision, directory: this.directory, topics, papers }
  }

  /**
   * Publish changed Markdown and metadata through a recoverable journal. A failure retains the journal.
   * @param catalog - proposed complete catalog after revision checks.
   * @param expected - notebook contents read before a mutation; intervening external edits reject the save.
   */
  async write(catalog: ResearchCatalog, expected?: ResearchCatalog): Promise<void> {
    for (const folder of ['papers', 'topics']) await mkdir(await this.path(folder), { recursive: true, mode: 0o700 })
    const writes: Journal['writes'] = []
    const prepare = async (kind: 'ai' | 'learning' | 'topic', id: string, value: { text: string; revision: number }) => {
      if (Buffer.byteLength(value.text) > this.policy.maxNoteBytes) throw new RemoteError('research/invalid', 'Notebook exceeds the configured size limit', { field: 'text' })
      const current = await optionalText(await this.notePath(kind, id))
      const previous = kind === 'topic' ? expected?.topics.find(item => item.id === id)?.notes
        : expected?.papers.find(item => item.id === id)?.[kind]
      if (previous !== undefined && current !== previous.text) {
        throw new RemoteError('research/invalid-library', 'A notebook changed while saving; refresh and merge the latest version', {
          path: await this.notePath(kind, id),
        })
      }
      if (current !== value.text) writes.push({ kind, id, previous: current === null ? null : digest(current), text: value.text })
      return { revision: value.revision, sha256: digest(value.text) }
    }
    const topics: Index['topics'] = [], papers: Index['papers'] = []
    for (const item of catalog.topics) topics.push({ ...item, notes: await prepare('topic', item.id, item.notes ?? { text: '', revision: 0 }) })
    for (const item of catalog.papers) {
      const { directory: _directory, ai, learning, highlights, ...metadata } = item
      const folder = await this.path('papers', item.id)
      for (const child of ['notes', 'assets', 'extracted', 'code']) await mkdir(await this.path('papers', item.id, child), { recursive: true, mode: 0o700 })
      papers.push({ ...metadata, ...highlights === undefined ? {} : { highlights: [...highlights] }, topicIds: [...metadata.topicIds], pdfPath: item.pdfPath === '' ? '' : relative(folder, await this.path('papers', item.id, 'paper.pdf')),
        ai: await prepare('ai', item.id, ai), learning: await prepare('learning', item.id, learning) })
    }
    const journal: Journal = { index: { version: 1, revision: catalog.revision, topics, papers }, writes }
    await writeFileAtomic(await this.path('.transaction.json'), `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
    await this.recover()
  }

  /**
   * Copy a library into a new empty directory, retaining the original copy.
   * @param destination - canonical destination file owner.
   */
  async copyTo(destination: ResearchFiles): Promise<void> {
    const { readdir } = await import('node:fs/promises')
    if ((await readdir(destination.directory)).some(name => name !== 'library.json.lock')) {
      throw new RemoteError('research/invalid', 'Migration requires an empty destination directory', { field: 'directory' })
    }
    const catalog = await this.read()
    for (const item of catalog.papers) {
      const source = await this.path('papers', item.id)
      await cp(source, await destination.path('papers', item.id), { recursive: true, dereference: false, errorOnExist: true, force: false })
    }
    for (const item of catalog.topics) {
      await cp(await this.path('topics', item.id), await destination.path('topics', item.id), { recursive: true, dereference: false, errorOnExist: true, force: false })
    }
    await destination.write({ ...catalog, revision: catalog.revision + 1 })
  }

  private async notePath(kind: 'ai' | 'learning' | 'topic', id: string): Promise<string> {
    return kind === 'topic' ? this.path('topics', id, 'notes.md') : this.path('papers', id, 'notes', `${kind}.md`)
  }

  private async recover(): Promise<void> {
    const filename = await this.path('.transaction.json')
    const pending = await optionalText(filename)
    if (pending === null) return
    const journal = journalSchema.parse(JSON.parse(pending))
    for (const item of journal.writes) {
      const path = await this.notePath(item.kind, item.id)
      const current = await optionalText(path)
      const hash = current === null ? null : digest(current)
      if (hash !== item.previous && hash !== digest(item.text)) {
        throw new RemoteError('research/invalid-library', 'A notebook changed during an interrupted save; preserve both versions before recovery', { path })
      }
      await writeFileAtomic(path, item.text, { mode: 0o600, dirMode: 0o700 })
    }
    await this.writeIndex(journal.index)
    await rm(filename)
  }

  private async writeIndex(index: Index): Promise<void> {
    for (const item of index.papers) await writeFileAtomic(await this.path('papers', item.id, 'paper.json'), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    for (const item of index.topics) await writeFileAtomic(await this.path('topics', item.id, 'topic.json'), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await writeFileAtomic(await this.path('library.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

/**
 * Compute a stable content identifier.
 * @param value - UTF-8 content or PDF bytes.
 * @returns SHA-256 content identity.
 */
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

/**
 * Identify an absent filesystem entry.
 * @param error - filesystem failure.
 * @returns whether the file is absent.
 */
export function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }

async function optionalText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (error: unknown) { if (missing(error)) return null; throw error }
}
