// @vitest-environment jsdom
/** Topic menus preserve navigation and name editors retain failed drafts. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchTopic, ResearchTopicId, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DeleteTopicDialog } from '../src/client/research/DeleteTopic.tsx'
import { ResearchTopicActions, RenameTopicDialog } from '../src/client/research/TopicActions.tsx'
import { en } from '../src/client/research/locales.ts'

const t = makeTranslate(en)
const topic: ResearchTopic = { id: brandString<ResearchTopicId>('topic'), title: 'Robot learning',
  workspaceId: brandString<WorkspaceId>('workspace'), sessionId: brandString<SessionId>('topic-session') }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('opens a portalled Topic menu, dismisses it, and requests renaming', async () => {
  const onRename = vi.fn()
  render(<ResearchTopicActions topic={topic} t={t} onRename={onRename} onAddPaper={vi.fn()} onDelete={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: 'Topic actions for Robot learning' })
  fireEvent.click(trigger)
  expect(screen.getByRole('menu').parentElement).toBe(document.body)
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Add paper' }), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename topic' }))
  expect(onRename).toHaveBeenCalledOnce()
})

it('prefills the name, rejects empty edits and submits a trimmed replacement with its original name', async () => {
  const renameTopic = vi.fn(async () => {}), onClose = vi.fn()
  render(<RenameTopicDialog topic={topic} t={t} renameTopic={renameTopic} onClose={onClose} />)
  const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Topic name' })
  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save name' })
  expect(field.value).toBe(topic.title)
  expect(save.disabled).toBe(true)
  fireEvent.change(field, { target: { value: '  ' } })
  fireEvent.submit(field.closest('form')!)
  expect(renameTopic).not.toHaveBeenCalled()
  expect(save.disabled).toBe(true)
  fireEvent.change(field, { target: { value: '  VLA foundations  ' } })
  fireEvent.submit(field.closest('form')!)
  await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
  expect(renameTopic).toHaveBeenCalledWith({ topicId: topic.id, title: 'VLA foundations', expectedTitle: topic.title })
})

it('keeps a conflicting draft available and cancels without another save', async () => {
  const renameTopic = vi.fn().mockRejectedValue({ code: 'research/topic-conflict' }), onClose = vi.fn()
  render(<RenameTopicDialog topic={topic} t={t} renameTopic={renameTopic} onClose={onClose} />)
  const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Topic name' })
  fireEvent.change(field, { target: { value: 'My draft title' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.renameTopicConflict) })
  expect(field.value).toBe('My draft title')
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(renameTopic).toHaveBeenCalledOnce()
})


it('keeps paper creation first and deletion last, dispatching each action without navigating the Topic', () => {
  const onAddPaper = vi.fn(), onDelete = vi.fn()
  render(<ResearchTopicActions topic={topic} t={t} onRename={vi.fn()} onAddPaper={onAddPaper} onDelete={onDelete} />)
  const trigger = screen.getByRole('button', { name: 'Topic actions for Robot learning' })
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add paper', 'Rename topic', 'Delete topic'])
  expect(screen.getByRole('separator')).toBeDefined()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add paper' }))
  expect(onAddPaper).toHaveBeenCalledOnce()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete topic' }))
  expect(onDelete).toHaveBeenCalledOnce()
})


it('requires acknowledgement of all exclusive paths and preserves shared papers in the deletion request', async () => {
  const deleteTopic = vi.fn(async () => {}), onClose = vi.fn()
  const paper = { id: brandString<import('@deepseek-ai/dsh-api-workspace-controller/client').ResearchPaperId>('paper'),
    title: 'Owned', directory: '/library/papers/Owned', topicIds: [topic.id], sessionId: brandString<SessionId>('paper-session'),
    pdfPath: '', repositoryUrl: '', ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 } }
  const shared = { ...paper, id: brandString<typeof paper.id>('shared'), title: 'Shared', directory: '/library/papers/Shared',
    topicIds: [topic.id, brandString<ResearchTopicId>('other')], sessionId: brandString<SessionId>('shared-session') }
  const catalog = { revision: 1, directory: '/library', topics: [topic], papers: [paper, shared] }
  const { rerender } = render(<DeleteTopicDialog topic={topic} catalog={catalog} t={t} deleteTopic={deleteTopic} onClose={onClose} />)
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete topic' })
  expect(confirm.disabled).toBe(true)
  expect(screen.getByText('/library/topics/topic')).toBeDefined()
  expect(screen.getByText('/library/papers/Owned')).toBeDefined()
  expect(screen.queryByText('/library/papers/Shared')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  rerender(<DeleteTopicDialog topic={topic} catalog={{ ...catalog, papers: [{ ...paper, directory: '/library/papers/Moved' }, shared] }}
    t={t} deleteTopic={deleteTopic} onClose={onClose} />)
  await waitFor(() => { expect(confirm.disabled).toBe(true) })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(confirm)
  await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
  expect(deleteTopic).toHaveBeenCalledWith({ topicId: topic.id, directory: '/library/topics/topic', papers: [{ paperId: paper.id, directory: '/library/papers/Moved' }] })
})

it('retains a failed deletion dialog and requires renewed path acknowledgement', async () => {
  const deleteTopic = vi.fn().mockRejectedValue({ code: 'research/topic-busy' }), onClose = vi.fn()
  render(<DeleteTopicDialog topic={topic} catalog={{ revision: 1, directory: '/library', topics: [topic], papers: [] }}
    t={t} deleteTopic={deleteTopic} onClose={onClose} />)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Delete topic' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.deleteTopicBusy) })
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete topic' }).disabled).toBe(true)
})
