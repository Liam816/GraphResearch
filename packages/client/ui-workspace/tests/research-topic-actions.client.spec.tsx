// @vitest-environment jsdom
/** Topic menus preserve navigation and name editors retain failed drafts. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResearchTopic, ResearchTopicId, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ResearchTopicActions, RenameTopicDialog } from '../src/client/research/TopicActions.tsx'
import { en } from '../src/client/research/locales.ts'

const t = makeTranslate(en)
const topic: ResearchTopic = { id: brandString<ResearchTopicId>('topic'), title: 'Robot learning',
  workspaceId: brandString<WorkspaceId>('workspace'), sessionId: brandString<SessionId>('topic-session') }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('opens a portalled Topic menu, dismisses it, and requests renaming', async () => {
  const onRename = vi.fn()
  render(<ResearchTopicActions topic={topic} t={t} onRename={onRename} />)
  const trigger = screen.getByRole('button', { name: 'Topic actions for Robot learning' })
  fireEvent.click(trigger)
  expect(screen.getByRole('menu').parentElement).toBe(document.body)
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' })
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
