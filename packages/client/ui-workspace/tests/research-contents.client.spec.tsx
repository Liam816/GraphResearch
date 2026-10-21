// @vitest-environment jsdom
/** The explorer opens real file types and keeps unrelated edits across switches and conflicting writes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchPaper, ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PaperFiles } from '../src/client/research/Files.tsx'
import type { PaperFilesProps } from '../src/client/research/Files.tsx'
import { createResearchViewStore, defaultPaperView } from '../src/client/research/store.ts'
import { en } from '../src/client/research/locales.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })
const paper: ResearchPaper = { id: 'paper' as ResearchPaperId, title: 'Example paper', topicIds: [], sessionId: 'paper-session' as SessionId,
  directory: '/library/papers/Example paper', pdfPath: '/library/papers/Example paper/paper.pdf', repositoryUrl: '', ai: { text: '# AI note', revision: 0 }, learning: { text: '# Personal note', revision: 0 } }
function fixture() {
  const store = createResearchViewStore().create()
  const useStore = bindSnapshotSelector(store)
  const saved: Record<string, string> = { 'paper.md': '# Paper body', 'custom.md': '# Custom note', 'code/model.py': 'class Model:\n    pass' }
  const listFiles = vi.fn<PaperFilesProps['listFiles']>(async ({ path }) => ({ path, entries: (path === '' ? ['notes/', 'code/', 'paper.pdf', 'paper.md', 'custom.md', 'checkpoint.bin'] : path === 'notes' ? ['ai.md', 'learning.md'] : ['model.py']).map(name => ({
    path: `${path === '' ? '' : `${path}/`}${name.replace(/\/$/, '')}`, name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'directory' : 'file',
  })) }))
  const readFile = vi.fn<PaperFilesProps['readFile']>(async ({ path }) => path.endsWith('.bin') ? { kind: 'unsupported', path, reason: 'binary' }
    : { kind: 'text', path, text: saved[path] ?? '', version: saved[path] ?? '', editable: path.endsWith('.md') })
  const saveFile = vi.fn<PaperFilesProps['saveFile']>(async (request) => { saved[request.path] = request.text; return { kind: 'text', path: request.path, text: request.text, version: request.text, editable: true } })
  const pdf = vi.fn<PaperFilesProps['renderFactorySlot']>(() => null)
  const Harness = () => <PaperFiles paper={paper} view={useStore(value => value.papers[paper.id] ?? defaultPaperView())}
    t={makeTranslate(en)} viewActions={store.actions}
    listFiles={listFiles} readFile={readFile} saveFile={saveFile} saveNote={vi.fn(async () => {})}
    refresh={vi.fn(async () => {})} revision="1" renderFactorySlot={pdf} />
  return { Harness, store, saveFile, pdf, saved, readFile, listFiles }
}
const open = async (name: string) => { fireEvent.click(await screen.findByRole('treeitem', { name })) }

it('starts with the paper directory and previews nested notes, PDF, source and unsupported contents', async () => {
  const { Harness, pdf } = fixture()
  render(<Harness />)
  expect(screen.getByText('Select a file from the directory')).toBeTruthy()
  await open('notes')
  await open('ai.md')
  expect(await screen.findByRole('heading', { name: 'AI note' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Learning notes' })).toBeNull()
  await open('paper.pdf')
  expect(pdf).toHaveBeenCalledWith('document.pdf', { path: paper.pdfPath, viewKey: paper.id })
  await open('code')
  await open('model.py')
  expect(await screen.findByText('Read-only preview')).toBeTruthy()
  await waitFor(() => { expect(document.querySelector('pre')?.textContent).toContain('class Model:') })
  await open('checkpoint.bin')
  expect(await screen.findByText('This binary file cannot be previewed online yet.')).toBeTruthy()
})

it('retains Markdown drafts across file switches, saves the selected file and restores selection on reload', async () => {
  const { Harness, store, saved, saveFile } = fixture()
  render(<Harness />)
  await open('custom.md')
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit custom.md' }), { target: { value: '# My draft' } })
  await open('paper.md')
  expect(await screen.findByRole('heading', { name: 'Paper body' })).toBeTruthy()
  await open('custom.md')
  expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Edit custom.md' })).value).toBe('# My draft')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  await waitFor(() => { expect(store.getSnapshot().papers[paper.id]?.files?.drafts['custom.md']).toBeUndefined() })
  expect(saved['custom.md']).toBe('# My draft')
  expect(saveFile).toHaveBeenCalledWith({ paperId: paper.id, path: 'custom.md', text: '# My draft', expectedVersion: '# Custom note' })
  expect(createResearchViewStore().create().getSnapshot().papers[paper.id]?.files?.selected).toBe('custom.md')
})

it('keeps a conflicting draft visible and offers the latest contents without overwriting either version', async () => {
  const { Harness, store, saveFile, saved } = fixture()
  saveFile.mockRejectedValue({ code: 'research/file-conflict' })
  render(<Harness />)
  await open('custom.md')
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved work' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Your draft was retained'))
  expect(store.getSnapshot().papers[paper.id]?.files?.drafts['custom.md']?.text).toBe('Unsaved work')
  saved['custom.md'] = '# Agent version'
  fireEvent.click(screen.getByRole('button', { name: 'Reload file' }))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'View latest saved version' }))
  expect(await screen.findByRole('heading', { name: 'Agent version' })).toBeTruthy()
  expect(store.getSnapshot().papers[paper.id]?.files?.drafts['custom.md']?.text).toBe('Unsaved work')
})
