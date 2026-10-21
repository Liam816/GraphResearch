/** Bounded previews and revision-checked Markdown edits inside one managed paper directory. */
import { constants } from 'node:fs'
import { open, readdir, lstat } from 'node:fs/promises'
import { extname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { digest, ResearchFiles } from './research-files.ts'
import type { ResearchDirectoryListing, ResearchFileContent, ResearchPaper, ResearchSaveFileRequest } from './research-types.ts'

const imageTypes: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

async function locate(files: ResearchFiles, paper: ResearchPaper, path: string): Promise<string> {
  if (path !== '' && path.split('/').some(part => part === '' || part === '.' || part === '..' || /[\\\u0000:]/u.test(part))) {
    throw new RemoteError('research/invalid', 'Choose a path inside this paper directory', { field: 'path' })
  }
  return files.paperPath(paper, ...path.split('/').filter(Boolean))
}

/**
 * List a paper directory without opening its symbolic links.
 * @param files - locked library.
 * @param paper - confirmed owner.
 * @param path - relative directory.
 * @returns direct children with folders first.
 */
export async function listPaperContents(files: ResearchFiles, paper: ResearchPaper, path: string): Promise<ResearchDirectoryListing> {
  const root = await locate(files, paper, path)
  const children = await readdir(root, { withFileTypes: true })
  const entries: ResearchDirectoryListing['entries'][number][] = []
  for (const child of children) {
    const relative = path === '' ? child.name : `${path}/${child.name}`
    const kind = child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other'
    const info = kind === 'file' ? await lstat(await locate(files, paper, relative)) : undefined
    entries.push({ name: child.name, path: relative, kind, ...info === undefined ? {} : { bytes: info.size } })
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
  return { path, entries }
}

/**
 * Read complete bounded file contents without following managed links.
 * @param files - locked library.
 * @param paper - confirmed owner.
 * @param path - relative file.
 * @param maxBytes - complete preview cap.
 * @returns decoded text, an image, or an explicit unsupported result.
 */
export async function readPaperContent(
  files: ResearchFiles, paper: ResearchPaper, path: string, maxBytes: number,
): Promise<ResearchFileContent> {
  const filename = await locate(files, paper, path)
  if (!(await lstat(filename)).isFile()) {
    throw new RemoteError('research/invalid', 'Only regular files can be previewed', { field: 'path' })
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new RemoteError('research/invalid', 'Only regular files can be previewed', { field: 'path' })
    if (info.size > maxBytes) return { kind: 'unsupported', path, reason: 'too-large' }
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, info.size + 1))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (chunk.bytesRead === 0) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > maxBytes || bytesRead > info.size) return { kind: 'unsupported', path, reason: 'too-large' }
    const data = buffer.subarray(0, bytesRead)
    const mime = imageTypes[extname(path).toLowerCase()]
    if (mime !== undefined) return { kind: 'image', path, src: `data:${mime};base64,${data.toString('base64')}` }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
    catch (_error: unknown) { return { kind: 'unsupported', path, reason: 'binary' } }
    if (text.includes('\u0000')) return { kind: 'unsupported', path, reason: 'binary' }
    return { kind: 'text', path, text, version: digest(data), editable: /\.(?:md|markdown)$/i.test(path) }
  } finally { await file.close() }
}

/**
 * Save an existing Markdown file only when its content version still matches.
 * @param files - locked library.
 * @param paper - confirmed owner.
 * @param request - Markdown draft and base hash.
 * @param maxBytes - read and save cap.
 * @returns acknowledged text and new version; conflicts leave the file unchanged.
 */
export async function savePaperContent(
  files: ResearchFiles, paper: ResearchPaper, request: ResearchSaveFileRequest, maxBytes: number,
): Promise<ResearchFileContent> {
  if (!/\.(?:md|markdown)$/i.test(request.path) || Buffer.byteLength(request.text) > maxBytes) {
    throw new RemoteError('research/invalid', 'Only Markdown within the configured notebook size limit can be edited', { field: 'text' })
  }
  const current = await readPaperContent(files, paper, request.path, maxBytes)
  if (current.kind !== 'text' || current.version !== request.expectedVersion) {
    throw new RemoteError('research/file-conflict', 'File changed; retain the draft and merge the latest version', { path: request.path })
  }
  await writeFileAtomic(await locate(files, paper, request.path), request.text, { mode: 0o600, dirMode: 0o700 })
  return { kind: 'text', path: request.path, text: request.text, version: digest(request.text), editable: true }
}
