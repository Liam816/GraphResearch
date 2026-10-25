// @vitest-environment jsdom
/** Paper references remain discoverable in Agent actions alongside panel arrangement. */
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ResearchPanelMenu } from '../src/client/research/PanelMenu.tsx'
import { en } from '../src/client/research/locales.ts'
import type { ResearchPanel } from '../src/client/research/store.ts'

afterEach(cleanup)

function fixture(panel: ResearchPanel, arrange = true) {
  const reference = vi.fn(), right = vi.fn()
  function Harness() {
    const [open, setOpen] = useState(false)
    return <ResearchPanelMenu panel={panel} t={makeTranslate(en)} open={open} setOpen={setOpen} onReference={reference}
      {...arrange ? { movement: { left: undefined, right } } : {}} />
  }
  render(<Harness />)
  return { reference, right }
}

it('opens references from Agent actions and closes the menu before opening the picker', async () => {
  const { reference } = fixture('agent')
  expect(screen.queryByRole('button', { name: 'Reference papers' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for agent' }))
  expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Move left' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reference papers' }))
  expect(reference).toHaveBeenCalledOnce()
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
})

it('retains movement actions on PDF panels without exposing another reference entry', () => {
  const { right, reference } = fixture('pdf')
  fireEvent.click(screen.getByRole('button', { name: 'Arrange pdf viewer' }))
  expect(screen.queryByRole('menuitem', { name: 'Reference papers' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }))
  expect(right).toHaveBeenCalledOnce()
  expect(reference).not.toHaveBeenCalled()
})

it('provides a reference-only menu for Topic conversations and dismisses it with Escape', async () => {
  fixture('agent', false)
  const anchor = screen.getByRole('button', { name: 'Actions for agent' })
  fireEvent.click(anchor)
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  expect(anchor.getAttribute('aria-expanded')).toBe('false')
})
