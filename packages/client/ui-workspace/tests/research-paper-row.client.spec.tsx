// @vitest-environment jsdom
/** Paper overflow reveal, menu dismissal, and explicit destructive path confirmation. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchPaper, ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ResearchPaperRow } from '../src/client/research/PaperRow.tsx'
import { DeletePaperDialog } from '../src/client/research/DeletePaper.tsx'
import { en } from '../src/client/research/locales.ts'

const t = makeTranslate(en)
const paper: ResearchPaper = { id: brandString<ResearchPaperId>('paper'), title: 'A very long paper title about robot learning',
  topicIds: [], sessionId: brandString<ResearchPaper['sessionId']>('paper-session'), directory: '/data/papers/A very long paper title',
  pdfPath: '', repositoryUrl: '', ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('waits half a second before scrolling overflow, repeats, and resets when the pointer leaves', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  const { unmount } = render(<ResearchPaperRow paper={paper} selected={false} t={t} onOpen={vi.fn()} onDelete={vi.fn()} />)
  const title = screen.getByText(paper.title)
  Object.defineProperty(title, 'scrollWidth', { value: 300 })
  Object.defineProperty(title, 'clientWidth', { value: 200 })
  const button = screen.getByRole('button', { name: paper.title })
  fireEvent.pointerEnter(button)
  act(() => { vi.advanceTimersByTime(499) })
  expect(title.scrollLeft).toBe(0)
  expect(title.hasAttribute('data-clipped')).toBe(false)
  act(() => { vi.advanceTimersByTime(1001) })
  expect(title.scrollLeft).toBeGreaterThan(20)
  act(() => { vi.advanceTimersByTime(3500) })
  const edge = title.scrollLeft
  act(() => { vi.advanceTimersByTime(1000) })
  expect(title.scrollLeft).toBeLessThan(edge)
  fireEvent.pointerLeave(button)
  expect(title.scrollLeft).toBe(0)
  expect(title.hasAttribute('data-scrolled')).toBe(false)
  fireEvent.pointerEnter(button)
  unmount()
  act(() => { vi.advanceTimersByTime(1000) })
  expect(title.scrollLeft).toBe(0)
})

it('keeps fitting titles still and reveals the tail without animation for reduced motion', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  render(<ResearchPaperRow paper={paper} selected={false} t={t} onOpen={vi.fn()} onDelete={vi.fn()} />)
  const title = screen.getByText(paper.title)
  Object.defineProperty(title, 'scrollWidth', { value: 180, configurable: true })
  Object.defineProperty(title, 'clientWidth', { value: 200 })
  const button = screen.getByRole('button', { name: paper.title })
  fireEvent.pointerEnter(button); act(() => { vi.advanceTimersByTime(1000) })
  expect(title.scrollLeft).toBe(0)
  fireEvent.pointerLeave(button)
  Object.defineProperty(title, 'scrollWidth', { value: 300 })
  fireEvent.pointerEnter(button); act(() => { vi.advanceTimersByTime(500) })
  expect(title.scrollLeft).toBe(100)
  expect(vi.getTimerCount()).toBe(0)
})

it('opens a portalled deletion menu without navigating and dismisses on Escape or outside click', async () => {
  const onOpen = vi.fn(), onDelete = vi.fn()
  render(<ResearchPaperRow paper={paper} selected={false} t={t} onOpen={onOpen} onDelete={onDelete} />)
  const trigger = screen.getByRole('button', { name: `Actions for ${paper.title}` })
  fireEvent.click(trigger)
  expect(screen.getByRole('menu').closest('li')).toBeNull()
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete paper' }))
  expect(onDelete).toHaveBeenCalledOnce()
  expect(onOpen).not.toHaveBeenCalled()
})

it('requires explicit confirmation of the full directory, retains failure and resets acknowledgment', async () => {
  const deletePaper = vi.fn().mockRejectedValueOnce({ code: 'research/paper-busy' }).mockResolvedValueOnce(undefined)
  const onClose = vi.fn()
  render(<DeletePaperDialog paper={paper} t={t} deletePaper={deletePaper} onClose={onClose} />)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText(paper.directory!).textContent).toBe(paper.directory)
  const confirm = dialog.getByRole<HTMLButtonElement>('button', { name: 'Delete paper' })
  expect(confirm.disabled).toBe(true)
  fireEvent.click(dialog.getByRole('checkbox'))
  fireEvent.click(confirm)
  await waitFor(() => { expect(dialog.getByRole('alert').textContent).toBe(en.deleteBusy) })
  expect(deletePaper).toHaveBeenCalledWith({ paperId: paper.id, directory: paper.directory })
  expect(confirm.disabled).toBe(true)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('checkbox'))
  fireEvent.click(confirm)
  await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
})

it('cancels without deletion and revokes confirmation when the directory changes', () => {
  const deletePaper = vi.fn(), onClose = vi.fn()
  const props = { paper, t, deletePaper, onClose }
  const { rerender } = render(<DeletePaperDialog {...props} />)
  fireEvent.click(screen.getByRole('checkbox'))
  rerender(<DeletePaperDialog {...props} paper={{ ...paper, directory: '/data/papers/Renamed' }} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete paper' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(deletePaper).not.toHaveBeenCalled()
})
