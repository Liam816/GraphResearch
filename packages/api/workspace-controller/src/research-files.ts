/** Managed paper files, revision recovery, and atomic Markdown publication. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchCatalog, ResearchPaper, ResearchPaperId, ResearchTopic, ResearchTopicId, ResearchHighlight, ResearchHighlightId } from './research-types.ts'
import { conversationBackup } from './research-conversations.ts'

const identity = z.string().regex(/^[A-Za-z0-9_-]+$/)
const topicId = identity.transform(value => brandString<ResearchTopicId>(value))
const paperId = identity.transform(value => brandString<ResearchPaperId>(value))
const note = z.object({ text: z.string(), revision: z.number().int().nonnegative() })
const relativeDocument = z.string().min(1).refine(value => value.split('/').every(part =>
  part !== '' && part !== '.' && part !== '..' && !/[\\\u0000:]/u.test(part)))
const markdown = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), sourceSha256: z.string(), path: relativeDocument,
    pages: z.number().int().positive(), backend: z.enum(['pdfjs', 'pdftotext']) }),
  z.object({ status: z.literal('failed'), sourceSha256: z.string().optional(),
    code: z.enum(['no-text', 'text-limit', 'timeout', 'conversion-failed', 'source-changed', 'output-conflict']) }),
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
  paperOrder: z.array(paperId).refine(ids => new Set(ids).size === ids.length).readonly().optional(),
})
const paper = z.object({
  id: paperId, title: z.string(), abbreviation: z.string().optional(), topicIds: z.array(topicId),
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

const noteIndex = z.object({ revision: z.number().int().nonnegative(), sha256: z.string() })
const paperIdentity = z.object({ id: paperId })
const topicIdentity = z.object({ id: topicId })
const folderName = z.string().min(1).refine(value => value !== '.' && value !== '..'
  && !/[\\/\u0000-\u001f<>:"|?*]/u.test(value) && !/[. ]$/.test(value) && Buffer.byteLength(value) <= 255)
const indexSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), revision: z.number().int().nonnegative(),
  topics: z.array(topic.omit({ notes: true }).extend({ notes: noteIndex })),
  papers: z.array(paper.omit({ ai: true, learning: true, directory: true }).extend({
    folder: folderName.optional(), pdfPath: z.union([z.literal(''), relativeDocument]), ai: noteIndex, learning: noteIndex,
  })),
}).refine(validSessionOwnership, 'Research Sessions must have one owner and include each paper’s original Session')
  .refine(index => index.version >= 3 || index.papers.every(item => item.conversations === undefined),
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
  moves: z.array(z.object({ id: identity, from: folderName, to: folderName })).optional(),
  deletion: z.object({ id: paperId, folder: folderName, token: z.uuid(), staged: z.boolean() }).optional(),
  topicDeletion: z.object({ id: topicId, token: z.uuid(), entries: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('paper'), id: paperId, folder: folderName, staged: z.boolean() }),
    z.object({ kind: z.literal('topic'), id: topicId, folder: folderName, staged: z.boolean() }),
  ])).min(1) }).optional(),
})
type Index = z.infer<typeof indexSchema>
type Journal = z.infer<typeof journalSchema>
const layoutRelative = z.string().refine(value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[\\\u0000]/u.test(part)))
const layoutSchema = z.object({
  index: indexSchema.refine(index => index.version === 4), legacyIndexSha256: z.string(),
  moves: z.array(z.object({ from: layoutRelative.refine(value => /^(papers|topics)\//u.test(value)),
    to: layoutRelative.refine(value => /^agent-lib\/(papers|topics)\/[A-Za-z0-9_-]+\//u.test(value)), sha256: z.string() })),
  emptyFiles: z.array(layoutRelative.refine(value => /^(papers\/[^/]+\/notes\/(ai|learning)|topics\/[^/]+\/notes)\.md$/u.test(value))),
  emptyDirectories: z.array(layoutRelative.refine(value =>
    /^papers\/[^/]+\/(notes|assets|code|extracted|cache|sessions(?:\/conversation-[^/]+)?)$/u.test(value))),
})

/** Deployment limits used by managed file operations. */
export interface ResearchFilePolicy {
  readonly maxNoteBytes: number
  readonly lockTimeoutMs: number
}

/** One library's files; callers serialize operations through withLock. */
export class ResearchFiles {
  private legacy = false
  private layoutReady = false
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
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(await this.path('agent-lib'), { recursive: true, mode: 0o700 })
    return withFileLock(join(this.directory, 'agent-lib', 'library.json'), async () => {
      await this.prepareLayout()
      return operation()
    }, { waitMs: this.policy.lockTimeoutMs })
  }

  /**
   * Resolve Harness-owned metadata, caches, and snapshots outside user contents.
   * @param parts - runtime-relative components.
   * @returns a link-checked library runtime path.
   */
  runtimePath(...parts: string[]): Promise<string> {
    return this.path(...this.legacy ? parts : ['agent-lib', ...parts])
  }

  /**
   * Resolve runtime files by paper identity, independently of its public directory name.
   * @param paper - owning paper identity.
   * @param parts - private child components.
   * @returns a link-checked runtime file path.
   */
  runtimePaperPath(paper: Pick<ResearchPaper, 'id'>, ...parts: string[]): Promise<string> {
    return this.runtimePath('papers', paper.id, ...parts)
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
    const root = resolve(this.directory, 'papers', folder)
    const child = relative(root, resolve(root, ...parts))
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new RemoteError('research/invalid-library', 'A paper file must stay inside its public directory', { path: child })
    }
    return this.path('papers', folder, ...parts)
  }

  /**
   * Reserve a readable directory without reusing an existing entry, including case-equivalent names.
   * @param title - user-provided paper name, or the Agent's chosen title.
   * @returns the exclusively created directory; callers hold the library lock.
   */
  async createPaperDirectory(title: string): Promise<string> {
    const parent = await this.path('papers')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const folder = readableFolder(title, new Set((await readdir(parent)).map(nameKey)))
    const directory = await this.path('papers', folder)
    await mkdir(directory, { mode: 0o700 })
    return directory
  }

  /**
   * Load the index and canonical Markdown; external edits advance their notebook revisions.
   * @param initial - legacy catalog imported only when this directory has no index.
   * @returns current files projected for the browser and Agent.
   */
  async read(initial: ResearchCatalog = { revision: 0, topics: [], papers: [] }): Promise<ResearchCatalog> {
    await this.prepareLayout()
    await this.recover()
    const path = await this.runtimePath('library.json')
    let index: Index
    try { index = indexSchema.parse(JSON.parse(await readFile(path, 'utf8'))) } catch (error: unknown) {
      if (!missing(error)) throw new RemoteError('research/invalid-library', 'Cannot read the library index', { path }, { cause: error })
      if (initial.papers.length > 0 || initial.topics.length > 0) {
        this.layoutReady = false
        this.legacy = true
        try { await this.write(initial) } finally { this.legacy = false }
      } else await this.write(initial)
      return this.read()
    }
    if (this.legacy) await this.migrateFolders(index)
    let changes = 0
    const readNote = async (kind: 'ai' | 'learning' | 'topic', id: string, metadata: z.infer<typeof noteIndex>, folder?: string) => {
      const filename = await this.notePath(kind, id, folder)
      const text = await optionalText(filename) ?? ''
      if (Buffer.byteLength(text) > this.policy.maxNoteBytes) throw new RemoteError('research/invalid', 'Notebook exceeds the configured size limit', { field: 'text' })
      const hash = digest(text)
      if (hash !== metadata.sha256) { metadata.sha256 = hash; metadata.revision += 1; changes += 1 }
      return { text, revision: metadata.revision }
    }
    const topics: ResearchCatalog['topics'][number][] = []
    for (const item of index.topics) topics.push({ ...item, notes: await readNote('topic', item.id, item.notes) })
    const papers: ResearchPaper[] = []
    for (const item of index.papers) {
      const { folder, ...metadata } = item
      const directory = await this.path('papers', folder ?? item.id)
      let pdfPath = item.pdfPath === '' ? '' : await this.paperPath({ id: item.id, directory }, item.pdfPath)
      if (pdfPath !== '') {
        try {
          if (!(await lstat(pdfPath)).isFile()) throw new RemoteError('research/invalid-library', 'The original must be a regular PDF file', { path: pdfPath })
        } catch (error: unknown) {
          if (!missing(error)) throw error
          pdfPath = ''; item.pdfPath = ''; delete item.markdown; delete metadata.markdown; changes += 1
        }
      }
      papers.push({
        ...metadata, directory, pdfPath,
        ai: await readNote('ai', item.id, item.ai, folder), learning: await readNote('learning', item.id, item.learning, folder),
      })
    }
    if (changes > 0) { index.revision += 1; await this.writeIndex(index) }
    return { revision: index.revision, directory: this.directory, topics, papers }
  }

  /**
   * Publish changed Markdown and metadata through a recoverable journal. A failure retains the journal.
   * @param catalog - proposed complete catalog after revision checks.
   * @param expected - notebook contents read before a mutation; intervening external edits reject the save.
   */
  async write(catalog: ResearchCatalog, expected?: ResearchCatalog): Promise<void> {
    await this.prepareLayout()
    for (const folder of ['papers', 'topics']) await mkdir(await this.path(folder), { recursive: true, mode: 0o700 })
    const writes: Journal['writes'] = []
    const prepare = async (kind: 'ai' | 'learning' | 'topic', id: string, value: { text: string; revision: number }, folder?: string) => {
      if (Buffer.byteLength(value.text) > this.policy.maxNoteBytes) throw new RemoteError('research/invalid', 'Notebook exceeds the configured size limit', { field: 'text' })
      const current = await optionalText(await this.notePath(kind, id, folder))
      const previous = kind === 'topic' ? expected?.topics.find(item => item.id === id)?.notes
        : expected?.papers.find(item => item.id === id)?.[kind]
      if (previous !== undefined && (current ?? '') !== previous.text) {
        throw new RemoteError('research/invalid-library', 'A notebook changed while saving; refresh and merge the latest version', {
          path: await this.notePath(kind, id, folder),
        })
      }
      if ((current ?? '') !== value.text) writes.push({ kind, id, previous: current === null ? null : digest(current), text: value.text })
      return { revision: value.revision, sha256: digest(value.text) }
    }
    const topics: Index['topics'] = [], papers: Index['papers'] = []
    for (const item of catalog.topics) {
      await mkdir(await this.path('topics', item.id), { recursive: true, mode: 0o700 })
      topics.push({ ...item, notes: await prepare('topic', item.id, item.notes ?? { text: '', revision: 0 }) })
    }
    for (const item of catalog.papers) {
      const { directory: _directory, ai, learning, highlights, ...metadata } = item
      const directory = await this.paperPath(item), folder = basename(directory)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      papers.push({ ...metadata, folder, ...highlights === undefined ? {} : { highlights: [...highlights] },
        topicIds: [...metadata.topicIds], pdfPath: item.pdfPath === '' ? '' : relative(directory, item.pdfPath).split(sep).join('/'),
        ai: await prepare('ai', item.id, ai, folder), learning: await prepare('learning', item.id, learning, folder) })
    }
    const version = 4
    const journal: Journal = { index: { version, revision: catalog.revision, topics, papers }, writes }
    await writeFileAtomic(await this.runtimePath('.transaction.json'), `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
    await this.recover()
  }

  /**
   * Copy a library into a new empty directory, retaining the original copy.
   * @param destination - canonical destination file owner.
   */
  async copyTo(destination: ResearchFiles): Promise<void> {
    const entries = await readdir(destination.directory)
    if (entries.some(name => name !== 'agent-lib')
      || (await readdir(await destination.path('agent-lib'))).some(name => name !== 'library.json.lock')) {
      throw new RemoteError('research/invalid', 'Migration requires an empty destination directory', { field: 'directory' })
    }
    const catalog = await this.read()
    const papers: ResearchPaper[] = []
    for (const item of catalog.papers) {
      const source = await this.paperPath(item), directory = await destination.path('papers', basename(source))
      await cp(source, directory, { recursive: true, dereference: false, errorOnExist: true, force: false })
      await cp(await this.runtimePaperPath(item), await destination.runtimePaperPath(item), {
        recursive: true, dereference: false, errorOnExist: true, force: false,
      })
      papers.push({ ...item, directory, pdfPath: item.pdfPath === '' ? '' : join(directory, relative(source, item.pdfPath)) })
    }
    for (const item of catalog.topics) {
      await cp(await this.path('topics', item.id), await destination.path('topics', item.id), { recursive: true, dereference: false, errorOnExist: true, force: false })
      await cp(await this.runtimePath('topics', item.id), await destination.runtimePath('topics', item.id), { recursive: true, dereference: false, errorOnExist: true, force: false })
    }
    await destination.write({ ...catalog, papers, revision: catalog.revision + 1 })
  }

  /**
   * Verify the path the user confirmed against the current paper and its on-disk identity.
   * @param paper - current catalog entry, read under the library lock.
   * @param confirmed - absolute directory displayed in the confirmation dialog.
   * @returns the verified directory; no files are changed.
   */
  async confirmDeletion(paper: Pick<ResearchPaper, 'id' | 'directory'>, confirmed: string): Promise<string> {
    const directory = await this.paperPath(paper)
    if (directory !== confirmed) {
      throw new RemoteError('research/delete-path-changed', 'Review the current paper directory before deleting', { paperId: paper.id, directory })
    }
    const metadata = await this.runtimePaperPath(paper, 'metadata.json')
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
    const index = indexSchema.parse(JSON.parse(await readFile(await this.runtimePath('library.json'), 'utf8')))
    if (!index.papers.some(item => item.id === paper.id && indexedPaperFolder(item) === basename(directory))) {
      throw new RemoteError('research/invalid-library', 'Paper differs from the current library index', { path: directory })
    }
    index.papers = index.papers.filter(item => item.id !== paper.id)
    index.revision += 1
    const journal: Journal = { index, writes: [],
      deletion: { id: paper.id, folder: basename(directory), token: randomUUID(), staged: false } }
    await writeFileAtomic(await this.runtimePath('.transaction.json'), `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
    await this.recover()
    return this.read()
  }

  /**
   * Verify a Topic directory against its stable runtime identity without changing files.
   * @param topic - current Topic under the library lock.
   * @param confirmed - absolute path displayed in the confirmation dialog.
   * @returns the verified user directory.
   */
  async confirmTopicDeletion(topic: Pick<ResearchTopic, 'id'>, confirmed: string): Promise<string> {
    const directory = await this.path('topics', topic.id)
    if (directory !== confirmed) throw new RemoteError('research/delete-path-changed', 'Review the current Topic directory before deleting', { directory })
    const metadata = await this.runtimePath('topics', topic.id, 'metadata.json')
    if (!(await lstat(directory)).isDirectory() || topicIdentity.parse(JSON.parse(await readFile(metadata, 'utf8'))).id !== topic.id) {
      throw new RemoteError('research/invalid-library', 'Topic directory identity changed', { path: directory })
    }
    return directory
  }

  /**
   * Remove a Topic and its exclusive papers while retaining papers shared with other Topics.
   * @param topic - confirmed Topic under the library lock.
   * @param papers - its verified exclusive papers.
   * @returns the remaining catalog; interrupted staging and cleanup resume on the next read.
   */
  async deleteTopic(topic: ResearchTopic, papers: readonly ResearchPaper[]): Promise<ResearchCatalog> {
    await this.confirmTopicDeletion(topic, await this.path('topics', topic.id))
    for (const paper of papers) await this.confirmDeletion(paper, await this.paperPath(paper))
    const index = indexSchema.parse(JSON.parse(await readFile(await this.runtimePath('library.json'), 'utf8')))
    const owned = index.papers.filter(item => item.topicIds.includes(topic.id) && item.topicIds.length === 1)
    if (!index.topics.some(item => item.id === topic.id) || owned.length !== papers.length
      || owned.some(item => !papers.some(paper => paper.id === item.id
        && basename(paper.directory ?? paper.id) === indexedPaperFolder(item)))) {
      throw new RemoteError('research/topic-contents-changed', 'Review the current Topic contents before deleting', { topicId: topic.id })
    }
    index.topics = index.topics.filter(item => item.id !== topic.id)
    index.papers = index.papers.filter(item => !papers.some(paper => paper.id === item.id))
      .map(item => ({ ...item, topicIds: item.topicIds.filter(id => id !== topic.id) }))
    index.revision += 1
    const journal: Journal = { index, writes: [], topicDeletion: { id: topic.id, token: randomUUID(), entries: [
      { kind: 'topic', id: topic.id, folder: topic.id, staged: false },
      ...owned.map(paper => ({ kind: 'paper' as const, id: paper.id, folder: indexedPaperFolder(paper), staged: false })),
    ] } }
    await writeFileAtomic(await this.runtimePath('.transaction.json'), `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
    await this.recover()
    return this.read()
  }

  private async recoverTopicDeletion(journal: Journal, filename: string): Promise<void> {
    const removal = journal.topicDeletion
    if (removal === undefined) return
    const topics = removal.entries.filter(item => item.kind === 'topic')
    const unique = new Set(removal.entries.map(item => `${item.kind}:${item.folder}`))
    const identities = new Set(removal.entries.map(item => `${item.kind}:${item.id}`))
    if (this.legacy || journal.index.version !== 4 || journal.writes.length > 0
      || journal.moves !== undefined || journal.deletion !== undefined || topics.length !== 1
      || !topics.some(item => item.id === removal.id && item.folder === removal.id)
      || unique.size !== removal.entries.length || identities.size !== removal.entries.length
      || journal.index.topics.some(item => item.id === removal.id) || journal.index.papers.some(item => item.topicIds.includes(removal.id))
      || removal.entries.some(entry => entry.kind === 'paper' && journal.index.papers.some(item => item.id === entry.id || indexedPaperFolder(item) === entry.folder))) {
      throw new RemoteError('research/invalid-library', 'Topic deletion differs from the pending index', { path: filename })
    }
    const staging = await this.runtimePath('.topic-deletions', removal.token)
    for (const entry of removal.entries) {
      if (entry.staged) continue
      const source = await this.path(entry.kind === 'paper' ? 'papers' : 'topics', entry.folder)
      const target = await this.runtimePath('.topic-deletions', removal.token, `${entry.kind}-${entry.id}`)
      let exists = false
      try {
        if (!(await lstat(target)).isDirectory()) throw new RemoteError('research/invalid-library', 'Topic deletion destination is occupied', { path: target })
        exists = true
      } catch (error: unknown) { if (!missing(error)) throw error }
      if (exists) {
        try {
          await lstat(source)
          throw new RemoteError('research/invalid-library', 'Both Topic deletion directories exist; preserve both before retrying', { path: target })
        } catch (error: unknown) { if (!missing(error)) throw error }
      } else {
        if (entry.kind === 'paper') await this.confirmDeletion({ id: entry.id, directory: source }, source)
        else await this.confirmTopicDeletion({ id: entry.id }, source)
        await mkdir(staging, { recursive: true, mode: 0o700 })
        await rename(source, target)
      }
      entry.staged = true
      await writeFileAtomic(filename, `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
    }
    await this.writeIndex(journal.index)
    await rm(staging, { recursive: true, force: true })
    for (const entry of removal.entries) await rm(await this.runtimePath(entry.kind === 'paper' ? 'papers' : 'topics', entry.id), { recursive: true, force: true })
    await rm(filename)
  }

  private async notePath(kind: 'ai' | 'learning' | 'topic', id: string, folder?: string): Promise<string> {
    const parts = kind === 'topic' ? ['topics', id, 'notes.md'] : ['papers', folder ?? id, 'notes', `${kind}.md`]
    try { return await this.path(...parts) } catch (error: unknown) {
      // A user may replace the optional notebook directory with another document.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOTDIR')) throw error
      return resolve(this.directory, ...parts)
    }
  }

  private async prepareLayout(): Promise<void> {
    if (this.layoutReady || this.legacy) return
    try { await withFileLock(join(this.directory, 'library.json'), () => this.relocateLayout(), { waitMs: this.policy.lockTimeoutMs }) }
    catch (error: unknown) {
      if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error
      throw new RemoteError('research/invalid-library', 'Cannot migrate this library; preserve its index and runtime files before retrying',
        { path: this.directory }, { cause: error })
    }
  }

  private async relocateLayout(): Promise<void> {
    const journalPath = await this.path('agent-lib', '.layout.json')
    let pending = await optionalText(journalPath)
    const legacyPath = await this.path('library.json')
    const legacyPending = await optionalText(await this.path('.transaction.json'))
    if (pending === null && await optionalText(await this.runtimePath('library.json')) !== null) {
      if (await optionalText(legacyPath) !== null || legacyPending !== null) {
        throw new RemoteError('research/invalid-library', 'Both legacy and current indexes exist; stop other backends and preserve both before choosing a library',
          { path: legacyPath })
      }
      this.layoutReady = true
      return
    }
    if (pending === null) {
      const legacyIndex = await optionalText(legacyPath)
      if (legacyIndex === null && legacyPending === null) { this.layoutReady = true; return }
      // Older interrupted transactions finish with their original paths before relocation begins.
      this.legacy = true
      let index: Index
      try {
        await this.recover()
        index = indexSchema.parse(JSON.parse(await readFile(legacyPath, 'utf8')))
        await this.migrateFolders(index)
        index = indexSchema.parse(JSON.parse(await readFile(legacyPath, 'utf8')))
      } finally { this.legacy = false }
      const moves: z.infer<typeof layoutSchema>['moves'] = [], emptyFiles: string[] = [], emptyDirectories: string[] = []
      const move = async (from: string[], to: string[]): Promise<void> => {
        try {
          const source = await this.path(...from)
          if (!(await lstat(source)).isFile()) throw new RemoteError('research/invalid-library', 'Expected a runtime file during migration', { path: source })
          moves.push({ from: from.join('/'), to: ['agent-lib', ...to].join('/'), sha256: digest(await readFile(source)) })
        } catch (error: unknown) {
          // A user file can occupy an optional cache directory's name.
          if (!missing(error) && !(error instanceof Error && 'code' in error && error.code === 'ENOTDIR')) throw error
        }
      }
      for (const item of index.papers) {
        const publicRoot = ['papers', item.folder ?? item.id], privateRoot = ['papers', item.id]
        await move([...publicRoot, 'paper.json'], [...privateRoot, 'legacy-paper.json'])
        const conversations = item.conversations ?? [{ sessionId: item.sessionId }]
        for (const conversation of conversations) {
          const suffix = conversationBackup(item, conversation.sessionId)
          await move([...publicRoot, ...suffix], [...privateRoot, ...suffix])
          if (suffix.length > 1) emptyDirectories.push([...publicRoot, ...suffix.slice(0, -1)].join('/'))
        }
        await move([...publicRoot, 'cache', 'text-index.json'], [...privateRoot, 'cache', 'text-index.json'])
        await move([...publicRoot, 'translations.json'], [...privateRoot, 'translations.json'])
        try {
          const extracted = join(await this.path(...publicRoot), 'extracted')
          if ((await lstat(extracted)).isDirectory()) {
            for (const entry of await readdir(extracted)) {
              if (/^pages-\d+\.json$/u.test(entry)) await move([...publicRoot, 'extracted', entry], [...privateRoot, 'extracted', entry])
            }
          }
        } catch (error: unknown) { if (!missing(error)) throw error }
        for (const kind of ['ai', 'learning']) emptyFiles.push([...publicRoot, 'notes', `${kind}.md`].join('/'))
        for (const name of ['sessions', 'cache', 'notes', 'assets', 'code', 'extracted']) emptyDirectories.push([...publicRoot, name].join('/'))
      }
      for (const item of index.topics) {
        await move(['topics', item.id, 'topic.json'], ['topics', item.id, 'legacy-topic.json'])
        await move(['topics', item.id, 'session.json'], ['topics', item.id, 'session.json'])
        emptyFiles.push(`topics/${item.id}/notes.md`)
      }
      const journal: z.infer<typeof layoutSchema> = { index: { ...index, version: 4, revision: index.revision + 1 },
        legacyIndexSha256: digest(await readFile(legacyPath)), moves, emptyFiles, emptyDirectories }
      pending = `${JSON.stringify(journal)}\n`
      await writeFileAtomic(journalPath, pending, { mode: 0o600, dirMode: 0o700 })
    }
    const journal = layoutSchema.parse(JSON.parse(pending))
    for (const move of journal.moves) {
      const source = await this.path(...move.from.split('/')), target = await this.path(...move.to.split('/'))
      let previous: Buffer | undefined, current: Buffer | undefined
      try { previous = await readFile(source) } catch (error: unknown) { if (!missing(error)) throw error }
      try { current = await readFile(target) } catch (error: unknown) { if (!missing(error)) throw error }
      if (previous === undefined && current !== undefined && digest(current) === move.sha256) continue
      if (previous === undefined || digest(previous) !== move.sha256 || current !== undefined) {
        throw new RemoteError('research/invalid-library', 'Runtime migration files changed; preserve both copies before retrying', { path: source })
      }
      await mkdir(await this.path(...move.to.split('/').slice(0, -1)), { recursive: true, mode: 0o700 })
      await rename(source, target)
    }
    await this.writeIndex(journal.index)
    const legacyIndex = await optionalText(legacyPath)
    if (legacyIndex !== null) {
      if (digest(legacyIndex) !== journal.legacyIndexSha256) {
        throw new RemoteError('research/invalid-library', 'Legacy library index changed during migration; preserve it before retrying', { path: legacyPath })
      }
      await rm(legacyPath)
    }
    for (const filename of journal.emptyFiles) {
      const path = await this.path(...filename.split('/'))
      if (await optionalText(path) === '') await rm(path)
    }
    for (const dirname of journal.emptyDirectories) {
      try {
        const path = join(await this.path(...dirname.split('/').slice(0, -1)), basename(dirname))
        if ((await lstat(path)).isDirectory()) await rmdir(path)
      } catch (error: unknown) {
        // Only obsolete empty directories are removed; user content keeps its directory.
        if (!missing(error) && !(error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR'))) throw error
      }
    }
    await rm(journalPath)
    this.layoutReady = true
  }

  private async migrateFolders(index: Index): Promise<void> {
    const legacy = index.papers.filter(item => item.folder === undefined || item.folder === item.id)
    if (legacy.length === 0 && index.version !== 1) return
    const parent = await this.path('papers')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const occupied = new Set((await readdir(parent)).map(nameKey))
    const moves: NonNullable<Journal['moves']> = []
    for (const item of legacy) {
      const from = item.folder ?? item.id, to = readableFolder(item.title, occupied)
      if (!(await lstat(await this.path('papers', from))).isDirectory()) {
        throw new RemoteError('research/invalid-library', 'Legacy paper path is not a directory', { path: from })
      }
      const metadata = await this.path('papers', from, 'paper.json')
      if (await optionalText(metadata) === null) {
        await writeFileAtomic(metadata, `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      occupied.add(nameKey(to)); item.folder = to
      moves.push({ id: item.id, from, to })
    }
    index.version = index.version >= 3 ? 3 : 2; index.revision += 1
    await writeFileAtomic(await this.runtimePath('.transaction.json'), `${JSON.stringify({ index, writes: [], moves } satisfies Journal)}\n`,
      { mode: 0o600, dirMode: 0o700 })
    await this.recover()
  }

  private async recover(): Promise<void> {
    const filename = await this.runtimePath('.transaction.json')
    const pending = await optionalText(filename)
    if (pending === null) return
    const journal = journalSchema.parse(JSON.parse(pending))
    if (journal.topicDeletion !== undefined) {
      await this.recoverTopicDeletion(journal, filename)
      return
    }
    if (journal.deletion !== undefined && !this.legacy) {
      const deletion = journal.deletion
      if (journal.writes.length > 0 || 'moves' in journal
        || journal.index.papers.some(item => item.id === deletion.id || indexedPaperFolder(item) === deletion.folder)) {
        throw new RemoteError('research/invalid-library', 'Deletion differs from the pending library index', { path: filename })
      }
      const source = await this.path('papers', deletion.folder)
      const staged = await this.runtimePath('.paper-deletions', deletion.token)
      if (!deletion.staged) {
        let stagingExists = false
        try {
          if (!(await lstat(staged)).isDirectory()) {
            throw new RemoteError('research/invalid-library', 'Deletion staging path is not a directory', { path: staged })
          }
          stagingExists = true
        } catch (error: unknown) { if (!missing(error)) throw error }
        if (stagingExists) {
          try {
            await lstat(source)
            throw new RemoteError('research/invalid-library', 'Both deletion directories exist; preserve both before retrying', { path: staged })
          } catch (error: unknown) { if (!missing(error)) throw error }
        }
        if (!stagingExists) {
          await this.confirmDeletion({ id: deletion.id, directory: source }, source)
          await mkdir(await this.runtimePath('.paper-deletions'), { recursive: true, mode: 0o700 })
          await rename(source, staged)
        }
        deletion.staged = true
        await writeFileAtomic(filename, `${JSON.stringify(journal)}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      await this.writeIndex(journal.index)
      await rm(staged, { recursive: true, force: true })
      await rm(await this.runtimePaperPath({ id: deletion.id }), { recursive: true, force: true })
      await rm(filename)
      return
    }
    if (journal.deletion !== undefined) {
      const deletion = journal.deletion
      if (journal.writes.length > 0 || 'moves' in journal
        || journal.index.papers.some(item => item.id === deletion.id || indexedPaperFolder(item) === deletion.folder)) {
        throw new RemoteError('research/invalid-library', 'Deletion differs from the pending library index', { path: filename })
      }
      const source = await this.path('papers', deletion.folder)
      const stagingRoot = await this.runtimePath('.paper-deletions')
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
      const staged = await this.runtimePath('.paper-deletions', deletion.token)
      if (!deletion.staged) {
        const moved = await optionalText(await this.runtimePath('.paper-deletions', deletion.token, 'paper.json'))
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
    for (const move of journal.moves ?? []) {
      if (move.from === move.to || !journal.index.papers.some(item => item.id === move.id && item.folder === move.to)) {
        throw new RemoteError('research/invalid-library', 'Directory migration differs from the pending library index', { path: filename })
      }
      const source = await this.path('papers', move.from), target = await this.path('papers', move.to)
      const previous = await optionalText(await this.path('papers', move.from, 'paper.json'))
      if (previous === null) {
        const moved = await optionalText(await this.path('papers', move.to, 'paper.json'))
        if (moved !== null && paperIdentity.parse(JSON.parse(moved)).id === move.id) continue
        throw new RemoteError('research/invalid-library', 'Cannot locate a paper during directory migration; preserve the transaction and restore its files', { path: source })
      }
      if (paperIdentity.parse(JSON.parse(previous)).id !== move.id) {
        throw new RemoteError('research/invalid-library', 'Paper identity differs from the directory migration', { path: source })
      }
      try {
        await lstat(target)
      } catch (error: unknown) {
        if (!missing(error)) throw error
        await rename(source, target)
        continue
      }
      throw new RemoteError('research/invalid-library', 'Directory migration destination already exists; preserve both directories before retrying', { path: target })
    }
    for (const item of journal.writes) {
      const folder = journal.index.papers.find(paper => paper.id === item.id)?.folder
      const path = await this.notePath(item.kind, item.id, folder)
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
    for (const item of index.papers) await writeFileAtomic(await (this.legacy ? this.path('papers', item.folder ?? item.id, 'paper.json') : this.runtimePaperPath(item, 'metadata.json')), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    for (const item of index.topics) await writeFileAtomic(await (this.legacy ? this.path('topics', item.id, 'topic.json') : this.runtimePath('topics', item.id, 'metadata.json')), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await writeFileAtomic(await this.runtimePath('library.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
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
  try { return await readFile(path, 'utf8') } catch (error: unknown) {
    if (missing(error) || (error instanceof Error && 'code' in error && error.code === 'ENOTDIR')) return null
    throw error
  }
}

function nameKey(value: string): string { return value.normalize('NFC').toLowerCase() }

function readableFolder(title: string, occupied: ReadonlySet<string>): string {
  let stem = title.normalize('NFC').replace(/[\\/\u0000-\u001f<>:"|?*]/gu, ' ').replace(/\s+/gu, ' ').replace(/^[. ]+|[. ]+$/g, '')
  if (stem === '') stem = 'Untitled paper'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `Paper ${stem}`
  let bounded = ''
  // Leave space below the filesystem's 255-byte component limit for duplicate-name suffixes.
  for (const char of stem) { if (Buffer.byteLength(bounded + char) > 200) break; bounded += char }
  bounded = bounded.replace(/[. ]+$/g, '')
  let result = bounded, suffix = 2
  while (occupied.has(nameKey(result))) result = `${bounded} (${suffix++})`
  return result
}
