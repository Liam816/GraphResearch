// @vitest-environment jsdom
/** Accessible ordering keeps confirmed membership visible through failed or pending saves. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchPaper, ResearchTopicId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ResearchPaperList } from '../src/client/research/PaperList.tsx'
import { en } from '../src/client/research/locales.ts'

vi.hoisted(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const papers = ['A', 'B', 'C'].map(title => ({ id: title as ResearchPaper['id'], title,
  sessionId: title as ResearchPaper['sessionId'], topicIds: [], pdfPath: '', repositoryUrl: '',
  ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }))
const props = () => ({ t: makeTranslate(en), topicId: 'topic' as ResearchTopicId, papers, selectedId: papers[1]!.id,
  filtered: false, reorderPapers: vi.fn(async () => {}), onOpen: vi.fn(), onDelete: vi.fn() })

it('moves from the row menu without opening or deleting the paper and submits the entire observed order', async () => {
  const input = props()
  render(<ResearchPaperList {...input} />)
  fireEvent.click(screen.getByRole('button', { name: 'Actions for B' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }))
  await waitFor(() => { expect(input.reorderPapers).toHaveBeenCalledExactlyOnceWith({
    topicId: 'topic', paperIds: ['B', 'A', 'C'], expectedPaperIds: ['A', 'B', 'C'],
  }) })
  expect(input.onOpen).not.toHaveBeenCalled()
  expect(input.onDelete).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'B' }).getAttribute('aria-current')).toBe('page')
})

it('retains all confirmed rows on failure and disables reorder while search hides other members', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const input = props()
  input.reorderPapers.mockRejectedValueOnce(new Error('save not confirmed'))
  const view = render(<ResearchPaperList {...input} />)
  fireEvent.click(screen.getByRole('button', { name: 'Actions for A' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }))
  await waitFor(() => { expect(console.error).toHaveBeenCalled() })
  expect(view.container.querySelectorAll('[data-research-paper]').length).toBe(3)
  expect([...view.container.querySelectorAll('[data-research-paper]')].map(row => row.getAttribute('data-research-paper'))).toEqual(['A', 'B', 'C'])
  view.rerender(<ResearchPaperList {...input} filtered papers={[papers[0]!]} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reorder paper: A' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Actions for A' }))
  expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Move down' }).disabled).toBe(true)
})
