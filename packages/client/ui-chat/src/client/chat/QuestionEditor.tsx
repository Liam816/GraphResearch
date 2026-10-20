/** Local question edits submit independently of the resident composer draft. */
import { useEffect, useRef, useState } from 'react'
import { Button, InlineEditor, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './MessageItem.module.css'

/**
 * Edit a sent question without mutating recorded messages or the composer.
 * @param props - original text, current admission availability and Session-bound send operation.
 * @returns an inline editor that retains changes after a failed submission.
 */
export function QuestionEditor({ text, unavailable, resend, close, t }: {
  text: string
  unavailable: boolean
  resend: (text: string) => Promise<void>
  close: () => void
  t: ChatViewSlotProps['t']
}) {
  const [draft, setDraft] = useState(text)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const submit = (): void => {
    if (pending.current || unavailable || draft.trim() === '') return
    pending.current = true
    setSending(true)
    setFailed(false)
    void resend(draft).then(() => {
      if (mounted.current) close()
    }, (_error: unknown) => {
      if (mounted.current) setFailed(true)
    }).finally(() => {
      pending.current = false
      if (mounted.current) setSending(false)
    })
  }
  return <fieldset className={css.questionEditor} disabled={sending} aria-label={t('message.edit')} aria-busy={sending}>
    <InlineEditor value={draft} label={t('message.edit.text')} className={css.questionText ?? ''}
      onChange={setDraft} onSave={submit} onCancel={() => { if (!pending.current) close() }} />
    <p className={css.editHint}>{t('message.edit.hint')}</p>
    {(failed || unavailable) && <p className={css.editError} role="status">
      <StateDot state={failed ? 'error' : 'warning'} />
      {t(failed ? 'message.edit.failed' : 'message.edit.unavailable')}
    </p>}
    <div className={css.editActions}>
      <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
      <Button onClick={submit} disabled={sending || unavailable || draft.trim() === ''}>
        {sending && <StateDot state="ongoing" />}{t('message.edit.send')}
      </Button>
    </div>
  </fieldset>
}
