// @vitest-environment jsdom
/** Notebook drafts remain isolated, and only acknowledged saves clear matching edits. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ResearchPaper, ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ResearchNotes } from '../src/client/research/Notes.tsx'
import { createResearchViewStore, defaultPaperView, resolvePanelOrder } from '../src/client/research/store.ts'
import type { PanelPlacement, ResearchPanel } from '../src/client/research/store.ts'
import { en } from '../src/client/research/locales.ts'
import type { ResearchSeats } from '../src/client/research/contract.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
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
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'AI notes' }), { target: { value: 'A AI draft' } })
  view.rerender(<Harness current={b} />)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Learning notes' }).value).toBe('')
  view.rerender(<Harness current={a} />)
  expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy()
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'AI notes' }).value).toBe('A AI draft')
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

it('restores notebook mode, editor selection and both scroll positions across papers and reloads', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  const { Harness, store } = fixture(vi.fn(async () => {}))
  const a = { ...paper('A'), learning: { text: 'Reading paragraph\n'.repeat(100), revision: 0 },
    ai: { text: '## AI section\n\nExplanation.\n\n'.repeat(40), revision: 0 } }
  const b = paper('B')
  const view = render(<Harness current={a} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Learning notes' })
  editor.setSelectionRange(32, 48, 'backward')
  fireEvent.scroll(editor, { target: { scrollTop: 320, scrollLeft: 12 } })
  fireEvent.click(screen.getByRole('button', { name: 'AI notes' }))
  const preview = view.container.querySelector<HTMLElement>('[data-research-note-preview]')!
  fireEvent.scroll(preview, { target: { scrollTop: 640 } })
  view.rerender(<Harness current={b} />)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Learning notes' }).scrollTop).toBe(0)
  view.rerender(<Harness current={a} />)
  expect(view.container.querySelector<HTMLElement>('[data-research-note-preview]')!.scrollTop).toBe(640)
  fireEvent.click(screen.getByRole('button', { name: 'Learning notes' }))
  const restored = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Learning notes' })
  expect([restored.scrollTop, restored.scrollLeft, restored.selectionStart, restored.selectionEnd, restored.selectionDirection])
    .toEqual([320, 12, 32, 48, 'backward'])
  expect(document.activeElement).not.toBe(restored)
  store.actions.reset(a.id)
  expect(createResearchViewStore().create().getSnapshot().papers[a.id]?.reading).toEqual({
    learning: { editor: { top: 320, left: 12, start: 32, end: 48, direction: 'backward' } },
    ai: { preview: { top: 640, left: 0 } },
  })
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

const layouts: readonly {
  name: string
  moves: readonly [ResearchPanel, ResearchPanel, PanelPlacement][]
  expected: readonly ResearchPanel[]
}[] = [
  { name: 'agent, pdf, notes', moves: [], expected: ['agent', 'pdf', 'notes'] },
  { name: 'agent, notes, pdf', moves: [['notes', 'pdf', 'before']], expected: ['agent', 'notes', 'pdf'] },
  { name: 'pdf, agent, notes', moves: [['pdf', 'agent', 'before']], expected: ['pdf', 'agent', 'notes'] },
  { name: 'pdf, notes, agent', moves: [['agent', 'notes', 'after']], expected: ['pdf', 'notes', 'agent'] },
  { name: 'notes, agent, pdf', moves: [['notes', 'agent', 'before']], expected: ['notes', 'agent', 'pdf'] },
  { name: 'notes, pdf, agent', moves: [['agent', 'notes', 'after'], ['notes', 'pdf', 'before']], expected: ['notes', 'pdf', 'agent'] },
]

it.each(layouts)('persists the $name panel permutation and keeps the other paper independent', ({ moves, expected }) => {
  const store = createResearchViewStore().create()
  const a = paper('A').id, b = paper('B').id
  store.actions.focus(a, 'pdf')
  store.actions.edit(a, 'learning', 'Retained draft', 4)
  store.actions.widths(a, 'agent', 'pdf', 5)
  store.actions.panel(a, 'notes')
  for (const [source, target, placement] of moves) store.actions.place(a, source, target, placement)
  store.actions.focus(b, 'agent')
  expect(store.getSnapshot().papers[a]).toMatchObject({
    active: 'pdf', panels: { agent: true, pdf: true, notes: false }, widths: { agent: 43, pdf: 33, notes: 24 },
    drafts: { learning: { text: 'Retained draft', revision: 4 } },
  })
  const restored = createResearchViewStore().create().getSnapshot()
  const first = restored.papers[a], second = restored.papers[b]
  if (first === undefined || second === undefined) throw new Error('both paper preferences must be restored')
  expect(resolvePanelOrder(first)).toEqual(expected)
  expect(resolvePanelOrder(second)).toEqual(['agent', 'pdf', 'notes'])
})

it.each([undefined, ['agent', 'agent', 'pdf'], ['pdf'], ['notes', 'pdf', 'unknown'], 'pdf,agent,notes'])
('restores older preferences or invalid panel order without clearing notebook drafts: %j', (order) => {
  const id = paper('Legacy').id
  localStorage.setItem('dsh.research.view.v1', JSON.stringify({
    expanded: {}, papers: { [id]: { ...defaultPaperView(), order, drafts: { learning: { text: 'Legacy draft', revision: 3 } } } },
  }))
  const restored = createResearchViewStore().create().getSnapshot().papers[id]
  if (restored === undefined) throw new Error('legacy paper preferences must remain available')
  expect(resolvePanelOrder(restored)).toEqual(['agent', 'pdf', 'notes'])
  expect(restored.drafts.learning).toEqual({ text: 'Legacy draft', revision: 3 })
})
