// @vitest-environment jsdom
/** Global history stays accessible when empty and edits only the selected conversation. */
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConversationPicker } from '../src/client/research/ConversationPicker.tsx'
import { en } from '../src/client/research/locales.ts'

type PickerProps = ComponentProps<typeof ConversationPicker>
type Conversation = PickerProps['entries'][number]
const t = makeTranslate(en)
vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function conversation(title: string, createdAt: number, pinned = false): Conversation {
  return { sessionId: brandString<SessionId>(title), title, createdAt, pinned, archived: false }
}

function fixture(entries: readonly Conversation[], current: SessionId | undefined = entries[0]?.sessionId) {
  const sessions: PickerProps['sessions'] = {}
  for (const entry of entries) sessions[entry.sessionId] = { id: entry.sessionId, displayTitle: entry.title,
    updatedAt: entry.createdAt, blank: false, running: false, retainedBy: {} }
  const props: PickerProps = { entries, sessionId: current, sessions, available: true, library: true, t,
    create: vi.fn(async () => {}), update: vi.fn(async () => {}), open: vi.fn() }
  const view = render(<ConversationPicker {...props} />)
  return { props, view }
}

async function history() {
  fireEvent.click(screen.getByRole('button', { name: 'Switch conversation' }))
  return within(await screen.findByRole('dialog', { name: 'Global conversations' }))
}

it('keeps creation and history available without a selected conversation', async () => {
  const { props } = fixture([], undefined)
  expect(screen.queryByText('Global Agent')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch conversation' }).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
  await waitFor(() => { expect(props.create).toHaveBeenCalledOnce() })
  const popup = await history()
  expect(popup.getByRole('textbox', { name: 'Search global conversations' })).toBeDefined()
  expect(popup.getByText('No matching conversations')).toBeDefined()
  fireEvent.keyDown(popup.getByRole('textbox'), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('searches global history, leads pinned entries, and orders recent work by activity rather than creation', async () => {
  const pinned = conversation('Reading plan', 1, true), old = conversation('VLA survey', 2), newer = conversation('Robot datasets', 3)
  const { props, view } = fixture([old, pinned, newer], old.sessionId)
  props.sessions[old.sessionId]!.updatedAt = 10
  view.rerender(<ConversationPicker {...props} />)
  const popup = await history()
  const options = [...popup.getByRole('textbox').closest('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('[data-conversation-option]')]
  expect(options.map(item => item.textContent)).toEqual(['Reading plan', 'VLA surveyCurrent', 'Robot datasets'])
  expect(options[1]!.getAttribute('aria-current')).toBe('page')
  const search = popup.getByRole('textbox', { name: 'Search global conversations' })
  fireEvent.change(search, { target: { value: 'robot' } })
  expect(popup.queryByText('VLA survey')).toBeNull()
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  expect(document.activeElement?.textContent).toBe('Robot datasets')
  fireEvent.click(popup.getByRole('button', { name: 'Robot datasets' }))
  expect(props.open).toHaveBeenCalledWith(newer.sessionId)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('renames with a stale-edit guard, pins, archives, then restores the chosen history entry', async () => {
  const entry = conversation('VLA survey', 2)
  const { props, view } = fixture([entry])
  let popup = await history()
  fireEvent.click(popup.getByRole('button', { name: 'Conversation actions for VLA survey' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename conversation' }))
  const editor = within(await screen.findByRole('dialog', { name: 'Rename conversation' }))
  fireEvent.change(editor.getByRole('textbox', { name: 'Conversation name' }), { target: { value: '  Core VLA papers  ' } })
  vi.mocked(props.update).mockRejectedValueOnce({ code: 'research/conversation-conflict' })
  fireEvent.click(editor.getByRole('button', { name: 'Save name' }))
  await waitFor(() => { expect(editor.getByRole('alert').textContent).toBe(en.conversationUpdateFailed) })
  expect(editor.getByRole<HTMLInputElement>('textbox', { name: 'Conversation name' }).value).toBe('  Core VLA papers  ')
  fireEvent.click(editor.getByRole('button', { name: 'Save name' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(props.update).toHaveBeenLastCalledWith({ sessionId: entry.sessionId, title: 'Core VLA papers', expectedTitle: 'VLA survey' })
  const renamed = { ...entry, title: 'Core VLA papers' }
  view.rerender(<ConversationPicker {...props} entries={[renamed]} />)
  popup = await history()
  fireEvent.click(popup.getByRole('button', { name: 'Conversation actions for Core VLA papers' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin conversation' }))
  await waitFor(() => { expect(props.update).toHaveBeenLastCalledWith({ sessionId: entry.sessionId, pinned: true }) })
  popup = await history()
  fireEvent.click(popup.getByRole('button', { name: 'Conversation actions for Core VLA papers' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Archive conversation' }))
  await waitFor(() => { expect(props.update).toHaveBeenLastCalledWith({ sessionId: entry.sessionId, archived: true }) })
  view.rerender(<ConversationPicker {...props} entries={[{ ...renamed, archived: true }]} />)
  popup = await history()
  expect(popup.getByText('No matching conversations')).toBeDefined()
  fireEvent.click(popup.getByRole('button', { name: 'Show archived conversations' }))
  fireEvent.click(popup.getByRole('button', { name: /^Core VLA papers.*Restore and open$/ }))
  await waitFor(() => { expect(props.open).toHaveBeenCalledWith(entry.sessionId) })
  expect(props.update).toHaveBeenLastCalledWith({ sessionId: entry.sessionId, archived: false })
})

it.each(['switch', 'leave'] as const)('does not reopen restored history after the user chooses to %s', async (navigation) => {
  const archived = { ...conversation('Archived survey', 1), archived: true }, current = conversation('Current research', 2)
  const { props, view } = fixture([archived, current], current.sessionId)
  let complete!: () => void
  vi.mocked(props.update).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve }))
  const popup = await history()
  fireEvent.click(popup.getByRole('button', { name: 'Show archived conversations' }))
  fireEvent.click(popup.getByRole('button', { name: /^Archived survey.*Restore and open$/ }))
  expect(props.update).toHaveBeenCalledWith({ sessionId: archived.sessionId, archived: false })
  if (navigation === 'leave') view.unmount()
  else view.rerender(<ConversationPicker {...props} sessionId={'another-conversation' as SessionId} />)
  await act(async () => { complete() })
  expect(props.open).not.toHaveBeenCalled()
})

it('confirms global deletion, retains the dialog on failure, and retries the same entry', async () => {
  const entry = conversation('Disposable survey', 1)
  const { props, view } = fixture([entry])
  props.remove = vi.fn(async () => {})
  props.deletionAvailable = true
  view.rerender(<ConversationPicker {...props} />)
  let popup = await history()
  fireEvent.click(popup.getByRole('button', { name: 'Conversation actions for Disposable survey' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }))
  let confirmation = within(await screen.findByRole('dialog', { name: 'Delete conversation' }))
  expect(confirmation.getByText(en.deleteConversationWarning.replace('{title}', entry.title))).toBeDefined()
  fireEvent.click(confirmation.getByRole('button', { name: 'Cancel' }))
  expect(props.remove).not.toHaveBeenCalled()
  popup = await history()
  fireEvent.click(popup.getByRole('button', { name: 'Conversation actions for Disposable survey' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete conversation' }))
  confirmation = within(await screen.findByRole('dialog', { name: 'Delete conversation' }))
  vi.mocked(props.remove).mockRejectedValueOnce({ code: 'research/conversation-busy' })
  fireEvent.click(confirmation.getByRole('button', { name: 'Delete conversation' }))
  await waitFor(() => { expect(confirmation.getByRole('alert').textContent).toBe(en.conversationDeleteBusy) })
  fireEvent.click(confirmation.getByRole('button', { name: 'Delete conversation' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(props.remove).toHaveBeenNthCalledWith(1, entry.sessionId)
  expect(props.remove).toHaveBeenNthCalledWith(2, entry.sessionId)
})
