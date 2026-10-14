/** Complete extraction preserves original pages and rejects incomplete publication. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { pdfFixture } from '../../../client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { extractPaperMarkdown } from '../src/research-markdown.ts'
import type { ResearchMarkdownPolicy } from '../src/research-markdown.ts'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const policy: ResearchMarkdownPolicy = { pdfTextBackend: 'pdfjs', maxMarkdownBytes: 1024, markdownTimeoutMs: 10_000 }

async function original(bytes = pdfFixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-paper-markdown-'))
  directories.push(directory)
  const path = join(directory, 'original.pdf')
  await writeFile(path, bytes)
  return { path, bytes }
}

it('extracts every page, including bibliography and appendix text, without changing the original', async () => {
  const text = new TextDecoder().decode(pdfFixture())
    .replace('Selectable PDF text', 'References [1] item')
    .replace('Selectable PDF text', 'Appendix materials!')
  const { path, bytes } = await original(new TextEncoder().encode(text))
  const result = await extractPaperMarkdown(path, bytes, policy, new AbortController().signal)
  expect(result).toMatchObject({ pages: 2, backend: 'pdfjs' })
  expect(result.text).toBe('## Page 1\n\nReferences [1] item\n\n## Page 2\n\nAppendix materials!\n')
  expect(await readFile(path)).toEqual(Buffer.from(bytes))
})

it('applies the byte limit to the complete result including page headings and the final newline', async () => {
  const { path, bytes } = await original()
  const result = await extractPaperMarkdown(path, bytes, policy, new AbortController().signal)
  const size = Buffer.byteLength(result.text)
  await expect(extractPaperMarkdown(path, bytes, { ...policy, maxMarkdownBytes: size }, new AbortController().signal))
    .resolves.toEqual(result)
  for (const maxMarkdownBytes of [1, size - 1]) {
    await expect(extractPaperMarkdown(path, bytes, { ...policy, maxMarkdownBytes }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'text-limit' } })
  }
})

it('reports image-only pages instead of generating a misleading empty Markdown document', async () => {
  const blank = new TextDecoder().decode(pdfFixture()).replaceAll('Selectable PDF text', ' '.repeat(19))
  const { path, bytes } = await original(new TextEncoder().encode(blank))
  await expect(extractPaperMarkdown(path, bytes, policy, new AbortController().signal))
    .rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'no-text' } })
})

it('uses PDF.js when auto mode cannot launch Poppler, and reports an explicitly required missing Poppler', async () => {
  vi.stubEnv('PATH', '')
  const { path, bytes } = await original()
  await expect(extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'auto' }, new AbortController().signal))
    .resolves.toMatchObject({ pages: 2, backend: 'pdfjs' })
  await expect(extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'pdftotext' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'conversion-failed' } })
})

it('retains invalid original bytes and honors library cancellation', async () => {
  const { path, bytes } = await original(new TextEncoder().encode('%PDF-invalid'))
  await expect(extractPaperMarkdown(path, bytes, policy, new AbortController().signal))
    .rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'conversion-failed' } })
  const lifetime = new AbortController()
  const reason = new Error('library closed')
  lifetime.abort(reason)
  await expect(extractPaperMarkdown(path, bytes, policy, lifetime.signal)).rejects.toBe(reason)
  expect(await readFile(path)).toEqual(Buffer.from(bytes))
})

// Executable fixtures use POSIX shebangs; Windows still exercises the PDF.js and missing-Poppler cases above.
it.skipIf(process.platform === 'win32')('preserves Poppler layout, enforces UTF-8 bytes and removes the private byte snapshot', async () => {
  const { path, bytes } = await original()
  const directory = directories.at(-1)!
  await writeFile(join(directory, 'pdftotext'), `#!${process.execPath}\nprocess.stdout.write('Abstract\\néé\\fAppendix\\n\\f')\n`, { mode: 0o700 })
  vi.stubEnv('PATH', directory)
  const result = await extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'auto' }, new AbortController().signal)
  expect(result).toEqual({ text: '## Page 1\n\nAbstract\néé\n\n## Page 2\n\nAppendix\n', pages: 2, backend: 'pdftotext' })
  await expect(extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'auto', maxMarkdownBytes: result.text.length },
    new AbortController().signal)).rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'text-limit' } })
  expect((await readdir(directory)).filter(name => name.startsWith('.pdf-extract-'))).toEqual([])
})

it.skipIf(process.platform === 'win32')('settles a cancelled Poppler child before removing its private snapshot', async () => {
  const { path, bytes } = await original()
  const directory = directories.at(-1)!, pidPath = join(directory, 'child-pid')
  await writeFile(join(directory, 'pdftotext'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\n`
    + `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`, { mode: 0o700 })
  vi.stubEnv('PATH', directory)
  const lifetime = new AbortController(), reason = new Error('library closed during conversion')
  const operation = extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'auto' }, lifetime.signal)
  const settled = operation.then(() => undefined, (error: unknown) => error)
  try {
    await expect.poll(() => readFile(pidPath, 'utf8')).toMatch(/^\d+$/)
    const pid = Number(await readFile(pidPath, 'utf8'))
    lifetime.abort(reason)
    expect(await settled).toBe(reason)
    expect(() => process.kill(pid, 0)).toThrow()
    expect((await readdir(directory)).filter(name => name.startsWith('.pdf-extract-'))).toEqual([])
  } finally { lifetime.abort(); await settled }
})

it.skipIf(process.platform === 'win32')('reports timeout and oversized Poppler output without publishing a partial result or falling back', async () => {
  const { path, bytes } = await original()
  const directory = directories.at(-1)!, command = join(directory, 'pdftotext')
  vi.stubEnv('PATH', directory)
  await writeFile(command, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
  await expect(extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'auto', markdownTimeoutMs: 100 },
    new AbortController().signal)).rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'timeout' } })
  await writeFile(command, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2048))\n`, { mode: 0o700 })
  await expect(extractPaperMarkdown(path, bytes, { ...policy, pdfTextBackend: 'auto', maxMarkdownBytes: 128 },
    new AbortController().signal)).rejects.toMatchObject({ code: 'research/extraction-failed', details: { reason: 'text-limit' } })
  expect((await readdir(directory)).filter(name => name.startsWith('.pdf-extract-'))).toEqual([])
})
