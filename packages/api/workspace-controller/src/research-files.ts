/** Managed paper files, revision recovery, and atomic Markdown publication. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchCatalog, ResearchPaper, ResearchPaperId, ResearchTopicId, ResearchHighlight, ResearchHighlightId } from './research-types.ts'

const identity = z.string().regex(/^[A-Za-z0-9_-]+$/)
const topicId = identity.transform(value => brandString<ResearchTopicId>(value))
const paperId = identity.transform(value => brandString<ResearchPaperId>(value))
const note = z.object({ text: z.string(), revision: z.number().int().nonnegative() })
const markdown = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), sourceSha256: z.string(), path: z.literal('paper.md'),
    pages: z.number().int().positive(), backend: z.enum(['pdfjs', 'pdftotext']) }),
  z.object({ status: z.literal('failed'), sourceSha256: z.string().optional(),
    code: z.enum(['no-text', 'text-limit', 'timeout', 'conversion-failed', 'source-changed']) }),
])
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
  markdown: markdown.optional(),
  conversations: z.array(z.object({
    sessionId: z.string().transform(value => brandString<ResearchPaper['sessionId']>(value)), title: z.string(),
    pinned: z.boolean(), archived: z.boolean(), createdAt: z.number().int().nonnegative(), progress: z.string().optional(),
  })).min(1).refine(items => new Set(items.map(item => item.sessionId)).size === items.length).readonly().optional(),
})

/** Existing storage-domain records remain readable during first-use file migration. */
export const researchCatalogSchema: z.ZodType<ResearchCatalog> = z.object({
  revision: z.number().int().nonnegative(), topics: z.array(topic), papers: z.array(paper), directory: z.string().optional(),
}).refine(validSessionOwnership, 'Research Sessions must have one owner and include each paper’s original Session')

const paperIdentity = z.object({ id: paperId })
const noteIndex = z.object({ revision: z.number().int().nonnegative(), sha256: z.string() })
const folderName = z.string().min(1).refine(value => value !== '.' && value !== '..'
  && !/[\\/\u0000-\u001f<>:"|?*]/u.test(value) && !/[. ]$/.test(value) && Buffer.byteLength(value) <= 255)
const indexSchema = z.object({
  version: z.union([z.literal(1), z.literal(3)]), revision: z.number().int().nonnegative(),
  topics: z.array(topic.omit({ notes: true }).extend({ notes: noteIndex })),
  papers: z.array(paper.omit({ ai: true, learning: true, directory: true }).extend({ ai: noteIndex, learning: noteIndex })),
}).refine(validSessionOwnership, 'Research Sessions must have one owner and include each paper’s original Session')
  .refine(index => index.version === 3 || index.papers.every(item => item.conversations === undefined),
    'Multiple conversations require library index version 3')

function validSessionOwnership(value: {
  topics: readonly { sessionId: string }[]
  papers: readonly { sessionId: string; conversations?: readonly { sessionId: string }[] | undefined }[]
}): boolean {
  const sessions = value.topics.map(item => item.sessionId)
  for (const paper of value.papers) {
    if (paper.conversations !== undefined && !paper.conversations.some(item => item.sessionId === paper.sessionId)) return false
    sessions.push(...paper.conversations?.map(item => item.sessionId) ?? [paper.sessionId])
  }
  return sessions.length === new Set(sessions).size
}

const journalSchema = z.object({
  index: indexSchema,
  writes: z.array(z.object({
    kind: z.enum(['ai', 'learning', 'topic']), id: identity, previous: z.string().nullable(), text: z.string(),
  })),
  deletion: z.object({ id: paperId, folder: folderName, token: z.uuid(), staged: z.boolean() }).optional(),
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
   * Resolve a paper's recorded directory, retaining UUID paths only for unmigrated legacy data.
   * @param paper - identity and absolute managed directory from the catalog.
   * @param parts - relative child components.
   * @returns a link-checked path beneath the paper directory.
   */
  async paperPath(paper: Pick<ResearchPaper, 'id' | 'directory'>, ...parts: string[]): Promise<string> {
    const folder = paper.directory === undefined ? paper.id : relative(join(this.directory, 'papers'), paper.directory)
    if (!folderName.safeParse(folder).success) {
      throw new RemoteError('research/invalid-library', 'Paper directory must be a direct child of the library papers directory', { path: folder })
    }
    return this.path('papers', folder, ...parts)
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
    const version = catalog.papers.some(item => item.conversations !== undefined) ? 3 : 1
    const journal: Journal = { index: { version, revision: catalog.revision, topics, papers }, writes }
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

  /**
   * Verify the path the user confirmed against the current paper and its on-disk identity.
   * @param paper - current catalog entry, read under the library lock.
   * @param confirmed - absolute directory displayed in the confirmation dialog.
   * @returns the verified directory; no files are changed.
   */
  async confirmDeletion(paper: ResearchPaper, confirmed: string): Promise<string> {
    const directory = await this.paperPath(paper)
    if (directory !== confirmed) {
      throw new RemoteError('research/delete-path-changed', 'Review the current paper directory before deleting', { paperId: paper.id, directory })
    }
    const metadata = await this.path('papers', basename(directory), 'paper.json')
    if (!(await lstat(directory)).isDirectory() || paperIdentity.parse(JSON.parse(await readFile(metadata, 'utf8'))).id !== paper.id) {
      throw new RemoteError('research/invalid-library', 'Paper directory identity does not match the selected paper', { path: directory })
    }
    return directory
  }

  /**
   * Remove a verified paper through a recoverable rename, index update, and staged-file deletion.
   * @param paper - current catalog entry, read under the library lock.
   * @param confirmed - absolute directory the user confirmed.
   * @returns the remaining catalog; interrupted operations finish on the next library read.
   */
  async deletePaper(paper: ResearchPaper, confirmed: string): Promise<ResearchCatalog> {
    const directory = await this.confirmDeletion(paper, confirmed)
    const index = indexSchema.parse(JSON.parse(await readFile(await this.path('library.json'), 'utf8')))
    if (!index.papers.some(item => item.id === paper.id && indexedPaperFolder(item) === basename(directory))) {
      throw new RemoteError('research/invalid-library', 'Paper differs from the current library index', { path: directory })
    }
    index.papers = index.papers.filter(item => item.id !== paper.id)
    index.revision += 1
    const journal: Journal = { index, writes: [],
      deletion: { id: paper.id, folder: basename(directory), token: randomUUID(), staged: false } }
    await writeFileAtomic(await this.path('.transaction.json'), `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
    await this.recover()
    return this.read()
  }

  private async notePath(kind: 'ai' | 'learning' | 'topic', id: string): Promise<string> {
    return kind === 'topic' ? this.path('topics', id, 'notes.md') : this.path('papers', id, 'notes', `${kind}.md`)
  }

  private async recover(): Promise<void> {
    const filename = await this.path('.transaction.json')
    const pending = await optionalText(filename)
    if (pending === null) return
    const journal = journalSchema.parse(JSON.parse(pending))
    if (journal.deletion !== undefined) {
      const deletion = journal.deletion
      if (journal.writes.length > 0 || 'moves' in journal
        || journal.index.papers.some(item => item.id === deletion.id || indexedPaperFolder(item) === deletion.folder)) {
        throw new RemoteError('research/invalid-library', 'Deletion differs from the pending library index', { path: filename })
      }
      const source = await this.path('papers', deletion.folder)
      const stagingRoot = await this.path('.paper-deletions')
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
      const staged = await this.path('.paper-deletions', deletion.token)
      if (!deletion.staged) {
        const moved = await optionalText(await this.path('.paper-deletions', deletion.token, 'paper.json'))
        if (moved === null) {
          const metadata = await readFile(await this.path('papers', deletion.folder, 'paper.json'), 'utf8')
          if (paperIdentity.parse(JSON.parse(metadata)).id !== deletion.id || !(await lstat(source)).isDirectory()) {
            throw new RemoteError('research/invalid-library', 'Deletion source identity changed', { path: source })
          }
          // An occupied staging path is never overwritten, even when it contains no metadata.
          try { await lstat(staged); throw new RemoteError('research/invalid-library', 'Deletion staging path is occupied', { path: staged }) }
          catch (error: unknown) { if (!missing(error)) throw error }
          await rename(source, staged)
        } else if (paperIdentity.parse(JSON.parse(moved)).id !== deletion.id) {
          throw new RemoteError('research/invalid-library', 'Deletion staging identity changed', { path: staged })
        }
        deletion.staged = true
        await writeFileAtomic(filename, `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      await this.writeIndex(journal.index)
      // Once staged, recovery only touches this unique path, even if the original name is reused.
      await rm(staged, { recursive: true, force: true })
      await rm(filename)
      return
    }
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

function indexedPaperFolder(paper: { readonly id: string; readonly folder?: string | undefined }): string {
  return paper.folder ?? paper.id
}

async function optionalText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (error: unknown) { if (missing(error)) return null; throw error }
}
