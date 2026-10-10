// @vitest-environment jsdom
/** Notebook drafts remain isolated, and only acknowledged saves clear matching edits. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ResearchPaper, ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ResearchNotes } from '../src/client/research/Notes.tsx'
import { createResearchViewStore, defaultPaperView } from '../src/client/research/store.ts'
import { en } from '../src/client/research/locales.ts'
import type { ResearchSeats } from '../src/client/research/contract.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })
const paper = (id: string): ResearchPaper => ({
  id: id as ResearchPaperId, title: id, topicIds: [], sessionId: id as SessionId, pdfPath: `${id}.pdf`, repositoryUrl: '',
  ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 },
})

function fixture(saveNote: ResearchSeats['saveNote']) {
  const store = createResearchViewStore().create()
  const useStore = bindSnapshotSelector(store)
  const seats = { t: makeTranslate(en), actions: store.actions, saveNote, refresh: vi.fn() }
  const Harness = ({ current }: { current: ResearchPaper }) => {
    const view = useStore(value => value.papers[current.id] ?? defaultPaperView())
    return <ResearchNotes key={current.id} {...seats} paper={current} view={view} />
  }
  return { store, Harness }
}

it('keeps drafts separate across paper and notebook switches and retains them after a rejected save', async () => {
  const save = vi.fn(async () => { throw { code: 'research/note-conflict' } })
  const { Harness, store } = fixture(save)
  const a = paper('A'), b = paper('B')
  const view = render(<Harness current={a} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Learning notes' }), { target: { value: 'A personal draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'AI notes' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'AI notes' }), { target: { value: 'A AI draft' } })
  view.rerender(<Harness current={b} />)
  expect((screen.getByRole('textbox', { name: 'Learning notes' }) as HTMLTextAreaElement).value).toBe('')
  view.rerender(<Harness current={a} />)
  expect((screen.getByRole('textbox', { name: 'AI notes' }) as HTMLTextAreaElement).value).toBe('A AI draft')
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('another window') })
  expect(store.getSnapshot().papers[a.id]!.drafts).toMatchObject({ learning: { text: 'A personal draft' }, ai: { text: 'A AI draft' } })
})

it('keeps edits typed during an in-flight save and advances their acknowledged base revision', async () => {
  let resolve!: () => void
  const save = vi.fn(() => new Promise<void>((settle) => { resolve = settle }))
  const { Harness, store } = fixture(save)
  const a = paper('A')
  render(<Harness current={a} />)
  const editor = screen.getByRole('textbox', { name: 'Learning notes' })
  fireEvent.change(editor, { target: { value: 'Saved text' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }))
  fireEvent.change(editor, { target: { value: 'Newer unsaved text' } })
  await act(async () => { resolve() })
  expect(store.getSnapshot().papers[a.id]!.drafts.learning).toEqual({ text: 'Newer unsaved text', revision: 1 })
  expect((editor as HTMLTextAreaElement).value).toBe('Newer unsaved text')
})

it('recovers every closed panel without discarding notebook drafts and bounds keyboard resizing', () => {
  const store = createResearchViewStore().create()
  const id = paper('A').id
  store.actions.edit(id, 'learning', 'Preserved draft', 0)
  for (const panel of ['agent', 'pdf', 'notes'] as const) store.actions.panel(id, panel)
  expect(Object.values(store.getSnapshot().papers[id]!.panels)).toEqual([false, false, false])
  store.actions.reset(id)
  expect(Object.values(store.getSnapshot().papers[id]!.panels)).toEqual([true, true, true])
  expect(store.getSnapshot().papers[id]!.drafts.learning?.text).toBe('Preserved draft')
  store.actions.widths(id, 'agent', 'pdf', 500)
  expect(store.getSnapshot().papers[id]!.widths).toEqual({ agent: 64, pdf: 12, notes: 24 })
})

it.each(['ai', 'learning'] as const)('clears only the %s notebook draft after save or discard', (kind) => {
  const store = createResearchViewStore().create()
  const id = paper('A').id
  const other = kind === 'ai' ? 'learning' : 'ai'
  store.actions.edit(id, kind, 'Saved text', 0)
  store.actions.edit(id, other, 'Other notebook draft', 0)
  store.actions.saved(id, kind, 'Saved text', 1)
  expect(store.getSnapshot().papers[id]!.drafts).toEqual({ [other]: { text: 'Other notebook draft', revision: 0 } })
  store.actions.edit(id, kind, 'Discarded text', 1)
  store.actions.discard(id, kind)
  expect(store.getSnapshot().papers[id]!.drafts).toEqual({ [other]: { text: 'Other notebook draft', revision: 0 } })
})
