/** File explorer paths remain paper-scoped and stale Markdown edits retain both versions. */
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ResearchFiles, digest } from '../src/research-files.ts'
import { listPaperContents, readPaperContent, savePaperContent } from '../src/research-contents.ts'
import type { ResearchPaper, ResearchPaperId } from '../src/research-types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-paper-files-'))
  roots.push(root)
  const files = await ResearchFiles.open(root, { maxNoteBytes: 4096, lockTimeoutMs: 1000 })
  const directory = join(files.directory, 'papers', 'Sample paper')
  await mkdir(join(directory, 'code'), { recursive: true })
  const paper: ResearchPaper = { id: 'sample' as ResearchPaperId, title: 'Sample paper', directory,
    topicIds: [], sessionId: 'sample-session' as SessionId, pdfPath: '', repositoryUrl: '',
    ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }
  await writeFile(join(directory, 'paper.md'), '# Original\n')
  await writeFile(join(directory, 'code', 'model.py'), 'class Model:\n    pass\n')
  return { root, files, paper, directory }
}

it('lists actual folders, source and Markdown, preserving complete file contents', async () => {
  const { files, paper } = await fixture()
  expect((await listPaperContents(files, paper, '')).entries.map(item => item.path)).toEqual(['code', 'paper.md'])
  expect((await listPaperContents(files, paper, 'code')).entries).toEqual([{ name: 'model.py', path: 'code/model.py', kind: 'file', bytes: 22 }])
  expect(await readPaperContent(files, paper, 'code/model.py', 4096)).toMatchObject({ kind: 'text', text: 'class Model:\n    pass\n', editable: false })
  expect(await readPaperContent(files, paper, 'paper.md', 4096)).toEqual({ kind: 'text', path: 'paper.md', text: '# Original\n', editable: true, version: digest('# Original\n') })
})

it('publishes a Markdown edit and rejects a stale edit without changing the saved file', async () => {
  const { files, paper, directory } = await fixture()
  await savePaperContent(files, paper, { paperId: paper.id, path: 'paper.md', text: '# Edited\n', expectedVersion: digest('# Original\n') }, 4096)
  await expect(savePaperContent(files, paper, { paperId: paper.id, path: 'paper.md', text: '# Stale', expectedVersion: digest('# Original\n') }, 4096)).rejects.toMatchObject({ code: 'research/file-conflict' })
  expect(await readFile(join(directory, 'paper.md'), 'utf8')).toBe('# Edited\n')
  await expect(savePaperContent(files, paper, { paperId: paper.id, path: 'code/model.py', text: 'broken', expectedVersion: '' }, 4096)).rejects.toMatchObject({ code: 'research/invalid' })
})

it.each(['../outside.md', 'code/../../outside.md', '/etc/passwd', 'code\\model.py', 'C:/file.md', 'code//model.py', './paper.md'])('rejects a path outside the paper vocabulary: %s', async (path) => {
  const { files, paper } = await fixture()
  await expect(listPaperContents(files, paper, path)).rejects.toMatchObject({ code: 'research/invalid' })
  await expect(readPaperContent(files, paper, path, 4096)).rejects.toMatchObject({ code: 'research/invalid' })
  await expect(savePaperContent(files, paper, { paperId: paper.id, path, text: 'changed', expectedVersion: '' }, 4096)).rejects.toMatchObject({ code: 'research/invalid' })
})

it('shows links as unavailable and refuses reads and saves through linked files or directories', async () => {
  const { root, files, paper, directory } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.md'), 'private')
  await symlink(outside, join(directory, 'linked'), 'junction')
  await symlink(join(outside, 'secret.md'), join(directory, 'secret.md'))
  expect((await listPaperContents(files, paper, '')).entries.find(item => item.name === 'linked')?.kind).toBe('other')
  for (const path of ['linked/secret.md', 'secret.md']) {
    await expect(readPaperContent(files, paper, path, 4096)).rejects.toMatchObject({ code: 'research/invalid-library' })
    await expect(savePaperContent(files, paper, { paperId: paper.id, path, text: 'overwrite', expectedVersion: digest('private') }, 4096)).rejects.toMatchObject({ code: 'research/invalid-library' })
  }
  expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('private')
})

it('reports oversized and binary files explicitly and renders bounded images', async () => {
  const { files, paper, directory } = await fixture()
  await writeFile(join(directory, 'large.md'), 'x'.repeat(64))
  await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 255]))
  await writeFile(join(directory, 'figure.png'), Buffer.from([137, 80, 78, 71]))
  expect(await readPaperContent(files, paper, 'large.md', 32)).toMatchObject({ kind: 'unsupported', reason: 'too-large' })
  expect(await readPaperContent(files, paper, 'binary.bin', 32)).toMatchObject({ kind: 'unsupported', reason: 'binary' })
  expect(await readPaperContent(files, paper, 'figure.png', 32)).toMatchObject({ kind: 'image', src: 'data:image/png;base64,iVBORw==' })
})
