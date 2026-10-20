// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { QuestionEditor } from '../src/client/chat/QuestionEditor.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)
const t = makeTranslate(zh, commonZh)

it('retains a multiline edit after rejection and permits a successful retry', async () => {
  const resend = vi.fn<(text: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
  const close = vi.fn()
  render(<QuestionEditor text="Original" unavailable={false} resend={resend} close={close} t={t} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '编辑问题' })
  fireEvent.change(editor, { target: { value: 'Revised\nquestion' } })
  fireEvent.click(screen.getByRole('button', { name: '重新提问' }))
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toContain('修改内容已保留')
  expect(editor.value).toBe('Revised\nquestion')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重新提问' }))
  await act(async () => {})
  expect(resend.mock.calls).toEqual([['Revised\nquestion'], ['Revised\nquestion']])
  expect(close).toHaveBeenCalledOnce()
})

it('admits one send while pending and settles safely after the editor unmounts', async () => {
  const gate = Promise.withResolvers<undefined>()
  const resend = vi.fn(() => gate.promise), close = vi.fn()
  const view = render(<QuestionEditor text="Question" unavailable={false} resend={resend} close={close} t={t} />)
  try {
    const send = screen.getByRole<HTMLButtonElement>('button', { name: '重新提问' })
    fireEvent.click(send); fireEvent.click(send)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(resend).toHaveBeenCalledOnce()
    expect(send.disabled).toBe(true)
    expect(screen.getByRole<HTMLFieldSetElement>('group', { name: '编辑' }).disabled).toBe(true)
    view.unmount()
  } finally { await act(async () => { gate.resolve(undefined); await gate.promise }) }
  expect(close).not.toHaveBeenCalled()
})

it('retains edits while unavailable and rejects whitespace without dispatch', async () => {
  const resend = vi.fn(async (_text: string) => {}), close = vi.fn()
  const view = render(<QuestionEditor text="Original" unavailable resend={resend} close={close} t={t} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox')
  fireEvent.change(editor, { target: { value: 'Revised' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(resend).not.toHaveBeenCalled()
  view.rerender(<QuestionEditor text="Original" unavailable={false} resend={resend} close={close} t={t} />)
  expect(editor.value).toBe('Revised')
  fireEvent.change(editor, { target: { value: ' \n ' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(resend).not.toHaveBeenCalled()
})

it('cancels on Escape and leaves IME Enter and Shift+Enter unsent', () => {
  const resend = vi.fn(async (_text: string) => {}), close = vi.fn()
  render(<QuestionEditor text="Question" unavailable={false} resend={resend} close={close} t={t} />)
  const editor = screen.getByRole('textbox')
  fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(editor, { key: 'Escape' })
  expect(resend).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})
