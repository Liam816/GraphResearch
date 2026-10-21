/** Topic action menu and name editor with conflict detection. */
import { useState } from 'react'
import { Button, Input, Menu, Modal, Tooltip, IconEditOutlineRegular, IconEllipsisOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchTopic } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import type { ResearchKey } from './locales.ts'
import css from './Research.module.css'

/** @param error - rejected rename operation. @returns localized guidance that preserves the user's draft. */
export function topicRenameFailure(error: unknown): ResearchKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'research/topic-conflict') return 'renameTopicConflict'
  if (code === 'research/not-found') return 'renameTopicMissing'
  return 'renameTopicFailed'
}

/** @param props - Topic name, localized copy, and edit callback. @returns a portalled Topic action menu. */
export function ResearchTopicActions({ topic, t, onRename }: Pick<ResearchSeats, 't'> & {
  topic: ResearchTopic
  onRename: () => void
}) {
  const [open, setOpen] = useState(false)
  const label = t('topicActions', { title: topic.title })
  return <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus closeOnPointerLeave dense align="end"
    items={[{ id: 'rename', label: t('renameTopic'), icon: <IconEditOutlineRegular size={16} /> }]}
    onSelect={() => { setOpen(false); onRename() }}
    anchor={<Tooltip label={label} side="right" portal><button type="button" className={css.topicMore}
      aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
      <IconEllipsisOutlineRegular size={16} />
    </button></Tooltip>} />
}

/** @param props - Topic at edit start, durable rename command, and dismissal. @returns the Topic name editor. */
export function RenameTopicDialog({ topic, t, renameTopic, onClose }: Pick<ResearchSeats, 't' | 'renameTopic'> & {
  topic: ResearchTopic
  onClose: () => void
}) {
  const [title, setTitle] = useState(topic.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ResearchKey>()
  const unchanged = title.trim() === topic.title
  const save = async (): Promise<void> => {
    if (busy || title.trim() === '' || unchanged) return
    setBusy(true); setError(undefined)
    try { await renameTopic({ topicId: topic.id, title: title.trim(), expectedTitle: topic.title }); onClose() }
    catch (error: unknown) { setError(topicRenameFailure(error)) }
    finally { setBusy(false) }
  }
  return <Modal open title={t('renameTopic')} closeLabel={t('close')} onClose={() => { if (!busy) onClose() }}
    footer={<><Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || title.trim() === '' || unchanged} onClick={() => { void save() }}>
        {t(busy ? 'saving' : 'saveTopicName')}
      </Button></>}>
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>{t('topicName')}<Input data-modal-autofocus aria-label={t('topicName')} value={title} disabled={busy} required
        onFocus={(event) => { event.currentTarget.select() }} onChange={(event) => { setTitle(event.target.value) }} /></label>
      {error !== undefined && <p role="alert" className={css.hint}>{t(error)}</p>}
    </form>
  </Modal>
}
