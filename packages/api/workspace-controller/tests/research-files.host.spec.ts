/** Readable paper directories preserve identity and recover interrupted legacy directory moves. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ResearchFiles, digest, researchCatalogSchema } from '../src/research-files.ts'

const roots: string[] = []
const links: string[] = []
afterEach(() => {
  for (const link of links.splice(0)) unlinkSync(link)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function library() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-paper-directories-'))
  roots.push(root)
  return { root, files: await ResearchFiles.open(root, { maxNoteBytes: 4096, lockTimeoutMs: 1000 }) }
}

function legacy(root: string, titles: readonly string[]) {
  const papers = titles.map((title, ordinal) => {
    const id = `legacy-${ordinal}`, folder = join(root, 'papers', id)
    const text = `Notes for ${id}`
    const metadata = { id, title, topicIds: [], sessionId: `session-${ordinal}`, pdfPath: 'paper.pdf', repositoryUrl: '',
      ai: { revision: 2, sha256: digest(text) }, learning: { revision: 0, sha256: digest('') } }
    mkdirSync(join(folder, 'notes'), { recursive: true })
    mkdirSync(join(folder, 'code'))
    writeFileSync(join(folder, 'notes', 'ai.md'), text)
    writeFileSync(join(folder, 'notes', 'learning.md'), '')
    writeFileSync(join(folder, 'paper.pdf'), '%PDF original')
    writeFileSync(join(folder, 'paper.md'), '# Original text')
    writeFileSync(join(folder, 'paper.json'), JSON.stringify(metadata))
    writeFileSync(join(folder, 'code', 'model.py'), 'model = 1\n')
    writeFileSync(join(folder, 'session.json'), JSON.stringify({ session: metadata.sessionId }))
    return metadata
  })
  const index = { version: 1, revision: 7, topics: [], papers }
  writeFileSync(join(root, 'library.json'), JSON.stringify(index))
  return index
}

it('uses recognizable Unicode names and disambiguates case-equivalent, unsafe and long filenames', async () => {
  const { files } = await library()
  await files.withLock(async () => {
    expect(basename(await files.createPaperDirectory('OpenVLA'))).toBe('OpenVLA')
    expect(basename(await files.createPaperDirectory('openvla'))).toBe('openvla (2)')
    expect(basename(await files.createPaperDirectory('机器人/VLA: 研究?'))).toBe('机器人 VLA 研究')
    expect(basename(await files.createPaperDirectory('../CON.txt'))).toBe('Paper CON.txt')
    expect(basename(await files.createPaperDirectory('...'))).toBe('Untitled paper')
    expect(Buffer.byteLength(basename(await files.createPaperDirectory('论文'.repeat(100))))).toBeLessThanOrEqual(200)
  })
})

it('migrates UUID folders once, preserves every paper resource and avoids existing readable directories', async () => {
  const { root, files } = await library()
  const index = legacy(root, ['VLA paper', 'VLA paper'])
  mkdirSync(join(root, 'papers', 'VLA paper'))
  writeFileSync(join(root, 'papers', 'VLA paper', 'personal.txt'), 'Keep this directory')
  await files.withLock(async () => {
    const catalog = await files.read()
    expect(catalog.papers.map(paper => basename(paper.directory!))).toEqual(['VLA paper (2)', 'VLA paper (3)'])
    expect(catalog.revision).toBe(9)
    for (const [ordinal, paper] of catalog.papers.entries()) {
      expect(paper.id).toBe(index.papers[ordinal]!.id)
      expect(paper.sessionId).toBe(index.papers[ordinal]!.sessionId)
      expect(paper.ai).toEqual({ text: `Notes for ${paper.id}`, revision: 2 })
      expect(readFileSync(paper.pdfPath, 'utf8')).toBe('%PDF original')
      expect(readFileSync(join(paper.directory!, 'paper.md'), 'utf8')).toBe('# Original text')
      expect(readFileSync(join(paper.directory!, 'code', 'model.py'), 'utf8')).toBe('model = 1\n')
      expect(readFileSync(await files.runtimePaperPath(paper, 'session.json'), 'utf8')).toContain(paper.sessionId)
      expect(existsSync(join(root, 'papers', paper.id))).toBe(false)
    }
    expect((await files.read()).revision).toBe(catalog.revision)
    expect(JSON.parse(readFileSync(join(root, 'agent-lib', 'library.json'), 'utf8'))).toMatchObject({ version: 4 })
    expect(existsSync(join(root, 'library.json'))).toBe(false)
    expect(readFileSync(join(root, 'papers', 'VLA paper', 'personal.txt'), 'utf8')).toBe('Keep this directory')
  })
})

it('resumes a journal after a directory moved before the index was published', async () => {
  const { root, files } = await library()
  const previous = legacy(root, ['Paper A', 'Paper B'])
  const index = { ...previous, version: 2, revision: 8,
    papers: previous.papers.map((paper, ordinal) => ({ ...paper, folder: ordinal === 0 ? 'Paper A' : 'Paper B' })) }
  const moves = index.papers.map(paper => ({ id: paper.id, from: paper.id, to: paper.folder }))
  writeFileSync(join(root, '.transaction.json'), JSON.stringify({ index, writes: [], moves }))
  renameSync(join(root, 'papers', 'legacy-0'), join(root, 'papers', 'Paper A'))
  await files.withLock(async () => {
    const catalog = await files.read()
    expect(catalog.papers.map(paper => paper.ai.text)).toEqual(['Notes for legacy-0', 'Notes for legacy-1'])
    expect(catalog.papers.map(paper => basename(paper.directory!))).toEqual(['Paper A', 'Paper B'])
    expect(existsSync(join(root, '.transaction.json'))).toBe(false)
  })
})

it('retains both directories and the journal when a migration destination is occupied', async () => {
  const { root, files } = await library()
  const previous = legacy(root, ['Paper A'])
  const index = { ...previous, version: 2, papers: previous.papers.map(paper => ({ ...paper, folder: 'Paper A' })) }
  writeFileSync(join(root, '.transaction.json'), JSON.stringify({ index, writes: [],
    moves: [{ id: 'legacy-0', from: 'legacy-0', to: 'Paper A' }] }))
  mkdirSync(join(root, 'papers', 'Paper A'))
  writeFileSync(join(root, 'papers', 'Paper A', 'keep.txt'), 'Unrelated files')
  await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(readFileSync(join(root, 'papers', 'Paper A', 'keep.txt'), 'utf8')).toBe('Unrelated files')
  expect(readFileSync(join(root, 'papers', 'legacy-0', 'notes', 'ai.md'), 'utf8')).toBe('Notes for legacy-0')
  expect(JSON.parse(readFileSync(join(root, 'library.json'), 'utf8'))).toEqual(previous)
  expect(existsSync(join(root, '.transaction.json'))).toBe(true)
})

it('rejects a persisted directory traversal or symlink without touching files outside the library', async () => {
  const { root, files } = await library()
  const previous = legacy(root, ['Paper A'])
  const external = join(root, 'outside'); mkdirSync(external)
  writeFileSync(join(external, 'keep.txt'), 'Private files')
  const index = { ...previous, version: 2, papers: previous.papers.map(paper => ({ ...paper, folder: '../outside' })) }
  writeFileSync(join(root, 'library.json'), JSON.stringify(index))
  await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
  index.papers[0]!.folder = 'Linked'
  writeFileSync(join(root, 'library.json'), JSON.stringify(index))
  symlinkSync(external, join(root, 'papers', 'Linked'), 'junction')
  links.push(join(root, 'papers', 'Linked'))
  await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('Private files')
})


it('rejects inconsistent durable conversation ownership before changing the library', async () => {
  const { root, files } = await library()
  const previous = legacy(root, ['Paper A', 'Paper B'])
  const record = (sessionId: string) => ({ sessionId, title: '', pinned: false, archived: false, createdAt: 1 })
  const variants = [
    { version: 3, ids: ['missing-original'] },
    { version: 3, ids: ['session-0', 'session-0'] },
    { version: 3, ids: ['session-0', 'session-1'] },
    { version: 2, ids: ['session-0', 'new-session'] },
  ]
  for (const variant of variants) {
    const index = { ...previous, version: variant.version, papers: previous.papers.map((paper, ordinal) =>
      ordinal === 0 ? { ...paper, conversations: variant.ids.map(record) } : paper) }
    const text = JSON.stringify(index)
    writeFileSync(join(root, 'library.json'), text)
    await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
    expect(readFileSync(join(root, 'library.json'), 'utf8')).toBe(text)
    expect(readFileSync(join(root, 'papers', 'legacy-0', 'notes', 'ai.md'), 'utf8')).toBe('Notes for legacy-0')
  }
})

it('keeps new paper contents empty and never recreates deleted notebooks or reserves user folder names', async () => {
  const { files, root } = await library()
  await files.withLock(async () => {
    const directory = await files.createPaperDirectory('OpenVLA')
    const initial = researchCatalogSchema.parse({ revision: 1, topics: [], papers: [{ id: 'openvla', title: 'OpenVLA',
      sessionId: 'reading', directory, topicIds: [], pdfPath: '', repositoryUrl: '',
      ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }] })
    await files.write(initial)
    expect(readdirSync(directory)).toEqual([])
    const catalog = await files.read(), paper = catalog.papers[0]!
    expect(existsSync(await files.runtimePaperPath(paper, 'metadata.json'))).toBe(true)
    await files.write({ ...catalog, papers: [{ ...paper, ai: { text: 'A useful note', revision: 1 } }] })
    expect(readdirSync(directory)).toEqual(['notes'])
    rmSync(join(directory, 'notes'), { recursive: true })
    const removed = await files.read()
    expect(removed.papers[0]?.ai).toEqual({ text: '', revision: 2 })
    await files.write(removed)
    expect(readdirSync(directory)).toEqual([])
    mkdirSync(join(directory, 'sessions'))
    writeFileSync(join(directory, 'sessions', 'experiment.txt'), 'User-owned experiment sessions')
    writeFileSync(join(directory, 'paper.json'), 'Arbitrary user file')
    const refreshed = await files.read()
    expect(refreshed.papers[0]?.id).toBe(paper.id)
    expect(readFileSync(join(directory, 'paper.json'), 'utf8')).toBe('Arbitrary user file')
    expect(readFileSync(join(directory, 'sessions', 'experiment.txt'), 'utf8')).toBe('User-owned experiment sessions')
    writeFileSync(join(directory, 'notes'), 'A user document rather than a directory')
    expect((await files.read()).papers[0]?.ai.text).toBe('')
    await files.write(await files.read())
    expect(readFileSync(join(directory, 'notes'), 'utf8')).toBe('A user document rather than a directory')
    expect(existsSync(join(root, 'library.json'))).toBe(false)
  })
})

it('relocates only Harness files and removes only obsolete empty scaffolding', async () => {
  const { root, files } = await library()
  legacy(root, ['Paper A'])
  const original = join(root, 'papers', 'legacy-0')
  for (const directory of ['assets', 'extracted', 'cache', 'sessions']) mkdirSync(join(original, directory))
  writeFileSync(join(original, 'extracted', 'pages-1.json'), '{"pages":[]}')
  writeFileSync(join(original, 'extracted', 'analysis.md'), 'Keep user analysis')
  writeFileSync(join(original, 'cache', 'text-index.json'), '{"blocks":[]}')
  writeFileSync(join(original, 'sessions', 'experiment.txt'), 'Keep user experiment')
  const paper = (await files.withLock(() => files.read())).papers[0]!
  expect(existsSync(join(paper.directory!, 'assets'))).toBe(false)
  expect(existsSync(join(paper.directory!, 'cache'))).toBe(false)
  expect(existsSync(join(paper.directory!, 'notes', 'learning.md'))).toBe(false)
  expect(existsSync(join(paper.directory!, 'paper.json'))).toBe(false)
  expect(existsSync(join(paper.directory!, 'session.json'))).toBe(false)
  expect(readFileSync(join(paper.directory!, 'extracted', 'analysis.md'), 'utf8')).toBe('Keep user analysis')
  expect(readFileSync(join(paper.directory!, 'sessions', 'experiment.txt'), 'utf8')).toBe('Keep user experiment')
  expect(readFileSync(await files.runtimePaperPath(paper, 'extracted', 'pages-1.json'), 'utf8')).toBe('{"pages":[]}')
  expect(readFileSync(await files.runtimePaperPath(paper, 'cache', 'text-index.json'), 'utf8')).toBe('{"blocks":[]}')
})

it('retains conflicting runtime copies and resumes already relocated files after the conflict is resolved', async () => {
  const { root, files } = await library()
  legacy(root, ['Paper A'])
  const privateRoot = join(root, 'agent-lib', 'papers', 'legacy-0')
  mkdirSync(privateRoot, { recursive: true })
  writeFileSync(join(privateRoot, 'session.json'), 'Retain this conflicting copy')
  await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(readFileSync(join(privateRoot, 'session.json'), 'utf8')).toBe('Retain this conflicting copy')
  expect(existsSync(join(privateRoot, 'legacy-paper.json'))).toBe(true)
  expect(existsSync(join(root, 'agent-lib', '.layout.json'))).toBe(true)
  rmSync(join(privateRoot, 'session.json'))
  const reopened = await ResearchFiles.open(root, { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
  const recovered = await reopened.withLock(() => reopened.read())
  expect(recovered.papers[0]?.ai.text).toBe('Notes for legacy-0')
  expect(readFileSync(join(privateRoot, 'session.json'), 'utf8')).toContain('session-0')
  expect(existsSync(join(root, 'agent-lib', '.layout.json'))).toBe(false)
})

it('refuses competing legacy and current indexes without choosing one or removing either', async () => {
  const { root, files } = await library()
  await files.withLock(() => files.read())
  const current = readFileSync(join(root, 'agent-lib', 'library.json'), 'utf8')
  const legacyIndex = JSON.stringify({ version: 1, revision: 10, topics: [], papers: [] })
  writeFileSync(join(root, 'library.json'), legacyIndex)
  const reopened = await ResearchFiles.open(root, { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
  await expect(reopened.withLock(() => reopened.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(readFileSync(join(root, 'agent-lib', 'library.json'), 'utf8')).toBe(current)
  expect(readFileSync(join(root, 'library.json'), 'utf8')).toBe(legacyIndex)
})

it('retains user files occupying former scaffolding names during migration', async () => {
  const { root, files } = await library()
  legacy(root, ['Paper A'])
  const original = join(root, 'papers', 'legacy-0')
  for (const name of ['assets', 'extracted', 'cache']) writeFileSync(join(original, name), `User document: ${name}`)
  const paper = (await files.withLock(() => files.read())).papers[0]!
  for (const name of ['assets', 'extracted', 'cache']) {
    expect(readFileSync(join(paper.directory!, name), 'utf8')).toBe(`User document: ${name}`)
  }
})

it('rejects originals and converted-document paths that leave the public paper directory before migrating files', async () => {
  const { root, files } = await library()
  const previous = legacy(root, ['Paper A'])
  for (const path of ['../outside.pdf', '/etc/passwd', 'C:/outside.pdf', 'nested\\outside.pdf']) {
    const index = { ...previous, papers: [{ ...previous.papers[0]!, pdfPath: path }] }
    writeFileSync(join(root, 'library.json'), JSON.stringify(index))
    await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
    expect(existsSync(join(root, 'papers', 'legacy-0', 'paper.pdf'))).toBe(true)
  }
  writeFileSync(join(root, 'library.json'), JSON.stringify({ ...previous, papers: [{ ...previous.papers[0]!,
    markdown: { status: 'ready', path: '../outside.md', sourceSha256: 'source', pages: 1, backend: 'pdfjs' } }] }))
  await expect(files.withLock(() => files.read())).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(existsSync(join(root, 'papers', 'legacy-0', 'paper.md'))).toBe(true)
})

it('recovers a legacy journal even when the first index was never published', async () => {
  const { root, files } = await library()
  const index = legacy(root, ['Paper A'])
  rmSync(join(root, 'library.json'))
  writeFileSync(join(root, '.transaction.json'), JSON.stringify({ index, writes: [] }))
  const catalog = await files.withLock(() => files.read())
  expect(catalog.papers[0]?.ai.text).toBe('Notes for legacy-0')
  expect(readFileSync(catalog.papers[0]!.pdfPath, 'utf8')).toBe('%PDF original')
  expect(existsSync(join(root, '.transaction.json'))).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'agent-lib', 'library.json'), 'utf8'))).toMatchObject({ version: 4 })
})

it('imports pre-file research records into readable public directories and private metadata', async () => {
  const { root, files } = await library()
  const initial = researchCatalogSchema.parse({ revision: 4, topics: [], papers: [{ id: 'old-id', title: 'Legacy named paper',
    sessionId: 'old-reading', topicIds: [], pdfPath: '', repositoryUrl: '',
    ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }] })
  const catalog = await files.withLock(() => files.read(initial))
  expect(basename(catalog.papers[0]!.directory!)).toBe('Legacy named paper')
  expect(readdirSync(catalog.papers[0]!.directory!)).toEqual([])
  expect(existsSync(join(root, 'papers', 'old-id'))).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'agent-lib', 'papers', 'old-id', 'metadata.json'), 'utf8')))
    .toMatchObject({ id: 'old-id', sessionId: 'old-reading', folder: 'Legacy named paper' })
})
