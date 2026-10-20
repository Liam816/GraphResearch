// @vitest-environment jsdom
/** Paper marks preview without navigating and retain independent Session destinations. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResearchPaper, ResearchTopic } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { installNavigationRailObserver } from '../../ui-primitives/tests/navigation-rail-fixture.ts'
import { PaperNavigator } from '../src/client/research/PaperNavigator.tsx'
import { en } from '../src/client/research/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const topic: ResearchTopic = {
  id: 'robotics' as ResearchTopic['id'], title: 'Robotics', workspaceId: 'workspace' as ResearchTopic['workspaceId'],
  sessionId: 'topic-session' as ResearchTopic['sessionId'],
}
const paper: ResearchPaper = {
  id: 'paper' as ResearchPaper['id'], title: 'OpenVLA', topicIds: [topic.id], sessionId: 'paper-session' as ResearchPaper['sessionId'],
  pdfPath: '', repositoryUrl: '', ai: { text: '', revision: 0 }, learning: { text: '', revision: 0 }, progress: 'Compare action tokens next.',
}

it('previews a single paper with pointer or focus and opens its independent Session only on activation', async () => {
  installNavigationRailObserver()
  const open = vi.fn()
  const view = render(<PaperNavigator topic={topic} papers={[paper]} activeId={paper.id} open={open} t={makeTranslate(en)} />)
  const nav = view.getByRole('navigation', { name: 'Papers in Robotics' })
  expect(nav.getAttribute('data-side')).toBe('left')
  const mark = await view.findByRole('button', { name: 'Open paper: OpenVLA' })
  expect(mark.getAttribute('aria-current')).toBe('true')
  fireEvent.pointerMove(mark)
  expect(view.getByRole('tooltip').textContent).toContain('OpenVLA')
  expect(view.getByRole('tooltip').textContent).toContain('Compare action tokens next.')
  expect(open).not.toHaveBeenCalled()
  fireEvent.pointerLeave(nav)
  expect(view.queryByRole('tooltip')).toBeNull()
  act(() => { mark.focus() })
  expect(mark.getAttribute('aria-describedby')).toBe(view.getByRole('tooltip').id)
  fireEvent.keyDown(mark, { key: 'Escape' })
  expect(view.queryByRole('tooltip')).toBeNull()
  fireEvent.click(mark)
  expect(open).toHaveBeenCalledExactlyOnceWith(paper.sessionId)
})

it('removes stale previews when changing Topic and omits navigation for an empty Topic', async () => {
  installNavigationRailObserver()
  const props = { open: vi.fn(), activeId: null, t: makeTranslate(en) }
  const view = render(<PaperNavigator {...props} topic={topic} papers={[paper]} />)
  fireEvent.pointerMove(await view.findByRole('button', { name: 'Open paper: OpenVLA' }))
  expect(view.getByRole('tooltip').textContent).toContain('OpenVLA')
  view.rerender(<PaperNavigator {...props} topic={{ ...topic, id: 'vision' as ResearchTopic['id'], title: 'Vision' }}
    papers={[{ ...paper, title: 'Vision paper', sessionId: 'vision-session' as ResearchPaper['sessionId'] }]} />)
  expect(view.queryByRole('tooltip')).toBeNull()
  fireEvent.click(await view.findByRole('button', { name: 'Open paper: Vision paper' }))
  expect(props.open).toHaveBeenCalledExactlyOnceWith('vision-session')
  view.rerender(<PaperNavigator {...props} topic={topic} papers={[]} />)
  expect(view.queryByRole('navigation')).toBeNull()
})
