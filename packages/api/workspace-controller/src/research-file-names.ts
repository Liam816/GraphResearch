/** Recognizable original filenames, supplied explicitly by research Agents. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Validate an Agent's acronym or derive a readable fallback for manual PDF imports.
 * @param title - paper title used only when no acronym was supplied.
 * @param requested - core acronym without a filename prefix or extension.
 * @returns a portable filename component, retaining the acronym's case.
 */
export function paperAbbreviation(title: string, requested?: string): string {
  if (requested !== undefined) {
    const value = requested.trim()
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(value) || /\.(?:pdf|md|json)?$/iu.test(value) || Buffer.byteLength(value) > 120) {
      throw new RemoteError('research/invalid', 'Provide a short paper acronym without paths or file extensions', { field: 'abbreviation' })
    }
    return value
  }
  const words = title.split(/[:：]/u)[0]?.trim() ?? title
  const safe = words.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/gu, '')
  let result = ''
  for (const letter of safe) { if (Buffer.byteLength(result + letter) > 120) break; result += letter }
  return result || 'Untitled'
}

/**
 * Name a related original, extracted text, or bibliographic record with the same acronym.
 * @param paper - title and optional confirmed acronym.
 * @param extension - public artifact kind.
 * @returns a paper-relative basename.
 */
export function paperFilename(paper: { title: string; abbreviation?: string | undefined }, extension: 'pdf' | 'md' | 'json'): string {
  return `paper_${paperAbbreviation(paper.title, paper.abbreviation)}.${extension}`
}
