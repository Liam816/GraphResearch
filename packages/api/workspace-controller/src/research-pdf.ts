/** Bounded PDF import and page-numbered text extraction in the Host filesystem. */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ResearchPaperText, ResearchReadPaperRequest } from './research-types.ts'

/** Validated deployment limits for downloading and reading original PDFs. */
export interface ResearchPdfPolicy {
  readonly maxPdfBytes: number
  readonly downloadTimeoutMs: number
  readonly maxReadPages: number
  readonly maxReadCharacters: number
}

/**
 * Read a local source or download a public PDF, retaining nothing until validation succeeds.
 * @param source - local path or HTTP(S) URL; arXiv abstract URLs resolve to their PDFs.
 * @param cwd - base for local relative paths.
 * @param policy - validated size and time limits.
 * @param signal - request cancellation.
 * @returns complete validated PDF bytes.
 */
export async function importPdf(source: string, cwd: string, policy: ResearchPdfPolicy, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  let bytes: Uint8Array
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source)
    if (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') url.pathname = url.pathname.replace(/^\/abs\//, '/pdf/')
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(policy.downloadTimeoutMs)]) })
    if (response.body === null) throw new RemoteError('research/storage-failed', `PDF download failed (${response.status})`, { operation: 'download', path: source })
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (!response.ok) throw new RemoteError('research/storage-failed', `PDF download failed (${response.status})`, { operation: 'download', path: source })
      const declared = Number(response.headers.get('content-length'))
      if (declared > policy.maxPdfBytes) throw new RemoteError('research/invalid', 'PDF exceeds the configured size limit', { field: 'source' })
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > policy.maxPdfBytes) throw new RemoteError('research/invalid', 'PDF exceeds the configured size limit', { field: 'source' })
        chunks.push(result.value)
      }
    } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
    bytes = Buffer.concat(chunks)
  } else {
    if (/^[a-z]+:\/\//i.test(source)) throw new RemoteError('research/invalid', 'Use a local path or HTTP(S) PDF URL', { field: 'source' })
    const path = isAbsolute(source) ? source : resolve(cwd, source)
    if ((await stat(path)).size > policy.maxPdfBytes) throw new RemoteError('research/invalid', 'PDF exceeds the configured size limit', { field: 'source' })
    bytes = await readFile(path, { signal })
  }
  if (bytes.byteLength > policy.maxPdfBytes || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) {
    throw new RemoteError('research/invalid', 'The source is not a PDF within the configured size limit', { field: 'source' })
  }
  return bytes
}

/**
 * Extract a bounded original page range. Image-only PDFs return empty page text and require OCR.
 * @param path - managed original PDF.
 * @param request - paper identity and requested page range.
 * @param policy - validated extraction limits.
 * @param signal - cancellation, also terminating the PDF worker.
 * @returns page-numbered original text and an explicit truncation flag.
 */
export async function readPdfText(
  path: string, request: ResearchReadPaperRequest, policy: ResearchPdfPolicy, signal: AbortSignal,
): Promise<ResearchPaperText> {
  const bytes = await importPdf(path, '', policy, signal)
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: true })
  let cancellation: Promise<void> | undefined
  const cancel = (): void => {
    cancellation = task.destroy()
    // The finalizer awaits this same promise and reports any worker teardown failure.
    void cancellation.catch((_error: unknown) => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const document = await task.promise
    const start = request.startPage ?? 1
    const count = request.pageCount ?? policy.maxReadPages
    if (!Number.isInteger(start) || start < 1 || start > document.numPages
      || !Number.isInteger(count) || count < 1 || count > policy.maxReadPages) {
      throw new RemoteError('research/invalid', 'Choose an existing page range within the configured limit', { field: 'pageRange' })
    }
    const pages: { page: number; text: string }[] = []
    let remaining = policy.maxReadCharacters, truncated = false
    for (let page = start; page <= Math.min(document.numPages, start + count - 1); page++) {
      signal.throwIfAborted()
      const content = await (await document.getPage(page)).getTextContent()
      const original = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('')
      const text = original.slice(0, remaining)
      pages.push({ page, text })
      remaining -= text.length
      if (text.length < original.length || (remaining === 0 && page < Math.min(document.numPages, start + count - 1))) {
        truncated = true; break
      }
    }
    return { paperId: request.paperId, totalPages: document.numPages, pages, truncated }
  } finally { signal.removeEventListener('abort', cancel); await (cancellation ?? task.destroy()) }
}
