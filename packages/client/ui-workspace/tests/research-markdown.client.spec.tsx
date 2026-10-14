// @vitest-environment jsdom
/** Paper conversion status stays beside the original, with explicit failure recovery. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { PaperMarkdownStatus } from '../src/client/research/MarkdownStatus.tsx'
import { en } from '../src/client/research/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

function fixture(markdown: NonNullable<ResearchPaper['markdown']>) {
  const paper: ResearchPaper = { id: 'paper' as ResearchPaper['id'], sessionId: 'session' as ResearchPaper['sessionId'],
    title: 'Reading', topicIds: [], pdfPath: '/library/paper.pdf', repositoryUrl: '', markdown,
    ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }
  const extractMarkdown = vi.fn(async (_id: ResearchPaper['id']) => {})
  render(<PaperMarkdownStatus paper={paper} t={makeTranslate(en)} extractMarkdown={extractMarkdown} />)
  return { paper, extractMarkdown }
}

it('shows the saved filename and complete original page count', () => {
  fixture({ status: 'ready', sourceSha256: 'hash', path: 'paper.md', pages: 2, backend: 'pdfjs' })
  expect(screen.getByRole('status').textContent).toBe('Full text saved to paper.md (2 pages)')
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('retains OCR guidance and reports a failed retry without losing the paper controls', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { extractMarkdown, paper } = fixture({ status: 'failed', code: 'no-text' })
  const failure = new Error('backend unavailable')
  extractMarkdown.mockRejectedValueOnce(failure)
  expect(screen.getByRole('alert').textContent).toContain(en.markdownNoText)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en.markdownRetryFailed) })
  expect(extractMarkdown).toHaveBeenCalledWith(paper.id)
  expect(report).toHaveBeenCalledWith('Paper Markdown retry failed:', failure)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled).toBe(false)
})
