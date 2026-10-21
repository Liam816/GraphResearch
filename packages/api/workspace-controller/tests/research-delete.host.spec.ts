/** Confirmed paper deletion and interrupted transaction recovery stay inside the managed library. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchCatalog, ResearchPaper, ResearchPaperId } from '../src/research-types.ts'
import { ResearchFiles } from '../src/research-files.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-paper-delete-'))
  roots.push(root)
  const files = await ResearchFiles.open(root, { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
  const papers: ResearchPaper[] = []
  for (const title of ['Paper A', 'Paper B']) papers.push({
    id: brandString<ResearchPaperId>(title.replace(' ', '-')), title, topicIds: [], sessionId: brandString<ResearchPaper['sessionId']>(title),
    directory: await files.path('papers', title.replace(' ', '-')), pdfPath: '', repositoryUrl: '',
    ai: { text: '# Keep notes', revision: 1 }, learning: { text: '', revision: 0 },
  })
  await files.write({ revision: 1, topics: [], papers })
  const catalog = await files.read()
  return { root, files, paper: catalog.papers[0]!, neighbor: catalog.papers[1]! }
}

it('deletes only the confirmed paper directory and removes the entity from the catalog', async () => {
  const { root, files, paper, neighbor } = await fixture()
  writeFileSync(join(paper.directory!, 'code', 'model.py'), 'weights = 1')
  const remaining = await files.withLock(() => files.deletePaper(paper, paper.directory!))
  expect(remaining.papers.map(item => item.id)).toEqual([neighbor.id])
  expect(remaining.revision).toBe(2)
  expect(existsSync(paper.directory!)).toBe(false)
  expect(readFileSync(join(neighbor.directory!, 'notes', 'ai.md'), 'utf8')).toBe('# Keep notes')
  expect(existsSync(join(root, '.transaction.json'))).toBe(false)
})

it('rejects stale or root paths before writing a deletion journal', async () => {
  const { root, files, paper } = await fixture()
  for (const directory of [root, join(root, 'papers'), join(root, 'papers', 'Other paper'), `${paper.directory}/..`]) {
    await expect(files.withLock(() => files.deletePaper(paper, directory))).rejects.toMatchObject({ code: 'research/delete-path-changed' })
  }
  expect(existsSync(paper.directory!)).toBe(true)
  expect(existsSync(join(root, '.transaction.json'))).toBe(false)
})

it('refuses a directory whose paper identity no longer matches', async () => {
  const { files, paper, neighbor } = await fixture()
  writeFileSync(join(paper.directory!, 'paper.json'), JSON.stringify({ id: neighbor.id }))
  await expect(files.deletePaper(paper, paper.directory!)).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(existsSync(paper.directory!)).toBe(true)
})

it.skipIf(process.platform === 'win32')('rejects a linked paper root and never follows nested links during deletion', async () => {
  // POSIX symlink creation needs no elevated account; Windows link permissions are not assumed.
  const { root, files, paper, neighbor } = await fixture()
  const outside = join(root, 'outside')
  mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'outside data')
  symlinkSync(outside, join(paper.directory!, 'code', 'external'))
  await files.deletePaper(paper, paper.directory!)
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside data')
  renameSync(neighbor.directory!, join(root, 'saved-neighbor'))
  symlinkSync(outside, neighbor.directory!)
  await expect(files.deletePaper(neighbor, neighbor.directory!)).rejects.toMatchObject({ code: 'research/invalid-library' })
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside data')
})

function interrupted(root: string, paper: ResearchPaper, staged: boolean) {
  const index = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8')) as { revision: number; papers: { id: string }[] }
  index.papers = index.papers.filter(item => item.id !== paper.id); index.revision += 1
  const token = '00112233-4455-4677-8899-aabbccddeeff'
  const target = join(root, '.paper-deletions', token)
  mkdirSync(join(root, '.paper-deletions'))
  writeFileSync(join(root, '.transaction.json'), JSON.stringify({ index, writes: [],
    deletion: { id: paper.id, folder: basename(paper.directory!), token, staged } }))
  return target
}

it('recovers a rename that finished before its staged flag or catalog was saved', async () => {
  const { root, files, paper, neighbor } = await fixture()
  const staged = interrupted(root, paper, false)
  renameSync(paper.directory!, staged)
  const remaining: ResearchCatalog = await files.withLock(() => files.read())
  expect(remaining.papers.map(item => item.id)).toEqual([neighbor.id])
  expect(existsSync(staged)).toBe(false)
  expect(existsSync(paper.directory!)).toBe(false)
})

it('finishes partial staged cleanup and preserves a newly created directory at the original name', async () => {
  const { root, files, paper } = await fixture()
  const staged = interrupted(root, paper, true)
  renameSync(paper.directory!, staged)
  rmSync(join(staged, 'paper.json'))
  mkdirSync(paper.directory!); writeFileSync(join(paper.directory!, 'new.txt'), 'new unrelated files')
  const catalog = await files.withLock(() => files.read())
  expect(catalog.papers.some(item => item.id === paper.id)).toBe(false)
  expect(readFileSync(join(paper.directory!, 'new.txt'), 'utf8')).toBe('new unrelated files')
  expect(existsSync(staged)).toBe(false)
  expect(existsSync(join(root, '.transaction.json'))).toBe(false)
})
