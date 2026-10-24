// @vitest-environment jsdom
/** Creation requires the managed-library backend and preserves entered metadata on failure. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ResearchSnapshot, ResearchTopicId, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ResearchDirectory } from '../src/client/research/Directory.tsx'
import type { ResearchDirectoryProps } from '../src/client/research/contract.ts'
import { createResearchViewStore } from '../src/client/research/store.ts'
import { en } from '../src/client/research/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(() => { localStorage.clear() })

function fixture(managed: boolean, collapsed = false) {
  const view = createResearchViewStore().create()
  const research = createSnapshotStore<ResearchSnapshot>({ phase: 'ready', catalog: { revision: 1,
    ...managed ? { directory: '/library' } : {}, papers: [],
    topics: [{ id: 'fixture-topic' as ResearchTopicId, title: 'Robotics', workspaceId: 'workspace' as WorkspaceId, sessionId: 'topic-session' as SessionId }],
  } })
  const props: ResearchDirectoryProps = {
    t: makeTranslate(en), actions: view.actions, useStore: bindSnapshotSelector(view), useResearch: bindSnapshotSelector(research),
    useResources: select => select(undefined),
    createConversation: vi.fn(async () => {}), updateConversation: vi.fn(async () => {}), openConversation: vi.fn(),
    insertText: vi.fn(() => true), insertReferences: vi.fn(async () => true),
    useSessions: select => select({ phase: 'ready', ids: [], byId: {}, projectionsBySession: {} }),
    useWorkspaces: select => select({ phase: 'ready', state: 'idle', items: [], archivedSessionIds: [], pinnedSessionIds: [], error: null }),
    useSessionStatus: select => select(new Map()), useSessionRetainInfo: () => undefined,
    usePanelInfo: select => select({ activePanelId: null }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} }),
    renameTopic: vi.fn(async () => {}), deleteTopic: vi.fn(async () => {}),
    deletePaper: vi.fn(async () => {}), refresh: vi.fn(async () => {}), open: vi.fn(),
    createTopic: vi.fn(async () => {}), createPaper: vi.fn(async () => {}),
    listFiles: vi.fn(async () => ({ path: '', entries: [] })),
    readFile: vi.fn(async () => ({ kind: 'unsupported' as const, path: '', reason: 'binary' as const })),
    saveFile: vi.fn(async () => ({ kind: 'unsupported' as const, path: '', reason: 'binary' as const })),
    highlight: vi.fn(async () => {}), extractMarkdown: vi.fn(async () => {}), saveNote: vi.fn(async () => {}),
    translate: vi.fn(), saveTranslation: vi.fn(async () => {}),
    configureDirectory: vi.fn(async () => {}), mentions: vi.fn(async () => []),
  }
  if (collapsed) view.actions.expand('fixture-topic', false)
  render(<ResearchDirectory {...props} />)
  expect(screen.queryByRole('button', { name: 'Add paper to Robotics' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Topic actions for Robotics' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add paper' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Add paper' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Title' }), { target: { value: 'pi0.7' } })
  return { props, dialog }
}

it('explains that the legacy backend needs a restart and prevents unsupported creation requests', () => {
  const { props, dialog } = fixture(false)
  expect(dialog.getByRole('alert').textContent).toBe(en.backendRestartRequired)
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(true)
  fireEvent.submit(dialog.getByRole('textbox', { name: 'Title' }).closest('form')!)
  expect(props.createPaper).not.toHaveBeenCalled()
})

it('creates a title-only paper when the managed library backend is available', async () => {
  const { props, dialog } = fixture(true, true)
  expect(screen.getByRole('button', { name: 'Expand Robotics' }).getAttribute('aria-expanded')).toBe('false')
  expect(props.open).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(props.createPaper).toHaveBeenCalledWith({ topicId: 'fixture-topic', title: 'pi0.7', pdfPath: '', repositoryUrl: '' })
})

it('retains the form and exposes the actual failure in diagnostics without claiming that retry is safe', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { props, dialog } = fixture(true)
  const failure = new Error('service unavailable')
  vi.mocked(props.createPaper).mockRejectedValueOnce(failure)
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await waitFor(() => { expect(dialog.getByRole('alert').textContent).toBe(en.createFailed) })
  expect(dialog.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('pi0.7')
  expect(report).toHaveBeenCalledWith('Research creation failed:', failure)
})
