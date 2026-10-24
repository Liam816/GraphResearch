/** Durable paper conversation ownership rejects ambiguous or incomplete metadata. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ResearchFiles, digest } from '../src/research-files.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
