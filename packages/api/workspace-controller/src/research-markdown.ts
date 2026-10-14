/** Full-text, page-numbered PDF Markdown using Poppler with a portable PDF.js fallback. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextContent } from 'pdfjs-dist/types/src/display/api.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchMarkdownFailure } from './research-types.ts'

const execute = promisify(execFile)
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

/** Validated whole-paper extraction choices, independent of bounded Agent page reads. */
export interface ResearchMarkdownPolicy {
  readonly pdfTextBackend: 'auto' | 'pdfjs' | 'pdftotext'
  readonly maxMarkdownBytes: number
  readonly markdownTimeoutMs: number
}

/** Complete Markdown result; over-limit and image-only documents fail instead of appearing complete. */
export interface ResearchMarkdownText {
  readonly text: string
  readonly pages: number
  readonly backend: 'pdfjs' | 'pdftotext'
}

/**
 * Extract all original pages, including references and appendices, without model rewriting.
 * @param path - validated managed PDF path for Poppler.
 * @param bytes - validated original bytes; PDF.js receives its own copy.
 * @param policy - whole-result byte budget, deadline, and backend preference.
 * @param signal - library lifetime cancellation; resources settle before rejection.
 * @returns complete page-numbered Markdown, never a truncated document.
 */
export async function extractPaperMarkdown(
  path: string, bytes: Uint8Array, policy: ResearchMarkdownPolicy, signal: AbortSignal,
): Promise<ResearchMarkdownText> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(policy.markdownTimeoutMs)])
  try {
    lifetime.throwIfAborted()
    if (policy.pdfTextBackend !== 'pdfjs') {
      let output: string | undefined
      try {
        output = await extractPoppler(path, bytes, policy, lifetime)
      } catch (error: unknown) {
        lifetime.throwIfAborted()
        if (!(error instanceof PopplerFailure) || policy.pdfTextBackend === 'pdftotext') throw error
        // Auto mode retains PDF.js as its supported backend when Poppler is unavailable or rejects the PDF.
      }
      if (output !== undefined) {
        const pages = output.split('\f')
        if (pages.at(-1)?.trim() === '') pages.pop()
        return assemble(pages, policy.maxMarkdownBytes, 'pdftotext')
      }
    }
    return await extractPdfjs(bytes, policy.maxMarkdownBytes, lifetime)
  } catch (error: unknown) {
    if (signal.aborted) throw signal.reason
    if (lifetime.aborted) throw extractionFailure('timeout', error)
    if (remoteErrorOf(error)?.code === 'research/extraction-failed') throw error
    throw extractionFailure('conversion-failed', error)
  }
}

async function extractPoppler(path: string, bytes: Uint8Array, policy: ResearchMarkdownPolicy, signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(dirname(path), '.pdf-extract-'))
  try {
    const snapshot = join(directory, 'original.pdf')
    await writeFile(snapshot, bytes, { mode: 0o600, flag: 'wx', signal })
    const operation = execute('pdftotext', ['-layout', '-enc', 'UTF-8', snapshot, '-'], {
      signal, timeout: policy.markdownTimeoutMs, maxBuffer: policy.maxMarkdownBytes,
      encoding: 'utf8', windowsHide: true, env: scrubbedParentEnv(),
    })
    const closed = new Promise<void>((resolve) => { operation.child.once('close', () => { resolve() }) })
    let output: string
    try { output = (await operation).stdout } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw extractionFailure('text-limit', error)
      }
      throw new PopplerFailure('Poppler could not extract this PDF', { cause: error })
    } finally { await closed }
    signal.throwIfAborted()
    return output
  } finally { await rm(directory, { recursive: true, force: true }) }
}

class PopplerFailure extends Error {}

async function extractPdfjs(bytes: Uint8Array, maxBytes: number, signal: AbortSignal): Promise<ResearchMarkdownText> {
  const task = getDocument({
    data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: true,
    cMapUrl: join(pdfjsRoot, 'cmaps') + sep, cMapPacked: true,
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + sep, verbosity: 0,
  })
  let cancellation: Promise<void> | undefined
  const cancel = (): void => {
    cancellation = task.destroy()
    // Teardown failure is observed by the finalizer, including during cancellation.
    void cancellation.catch((_error: unknown) => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const document = await task.promise
    const pages: string[] = []
    let size = 0
    for (let number = 1; number <= document.numPages; number++) {
      signal.throwIfAborted()
      const page = await document.getPage(number)
      try {
        const content = await page.getTextContent()
        const text = reconstruct(content.items)
        size += Buffer.byteLength(text)
        if (size > maxBytes) throw extractionFailure('text-limit')
        pages.push(text)
      } finally { page.cleanup() }
    }
    signal.throwIfAborted()
    return assemble(pages, maxBytes, 'pdfjs')
  } finally {
    signal.removeEventListener('abort', cancel)
    await (cancellation ?? task.destroy())
  }
}

function reconstruct(items: TextContent['items']): string {
  let text = '', previousY: number | undefined, previousHeight = 10
  for (const item of items) {
    if (!('str' in item)) continue
    // PDF.js declares transform as any[]; these text items expose six numeric matrix entries.
    const transform = item.transform as readonly number[]
    const y = transform[5]
    const height = item.height || previousHeight
    if (previousY !== undefined && y !== undefined && previousY - y > height * 0.6 && !text.endsWith('\n')) text += '\n'
    if (item.str !== '') {
      if (text !== '' && !text.endsWith('\n') && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' '
      text += item.str
    }
    if (item.hasEOL && !text.endsWith('\n')) text += '\n'
    if (y !== undefined) { previousY = y; previousHeight = height }
  }
  return tidy(text.replace(/[ \t]{2,}/g, ' '))
}

function tidy(text: string): string {
  return text.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function assemble(pages: readonly string[], maxBytes: number, backend: ResearchMarkdownText['backend']): ResearchMarkdownText {
  if (!pages.some(text => text.trim() !== '')) throw extractionFailure('no-text')
  const text = `${pages.map((page, index) => `## Page ${index + 1}\n\n${tidy(page)}`).join('\n\n')}\n`
  if (Buffer.byteLength(text) > maxBytes) throw extractionFailure('text-limit')
  return { text, pages: pages.length, backend }
}

function extractionFailure(reason: ResearchMarkdownFailure, cause?: unknown): RemoteError {
  return new RemoteError('research/extraction-failed', 'PDF Markdown extraction did not complete; the original PDF is retained', { reason }, { cause })
}
