/** Explicit directory confirmation for irreversible paper removal. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, IconTrashOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import type { ResearchKey } from './locales.ts'
import css from './Research.module.css'

/** @param error - rejected wire operation. @returns localized recovery guidance for the deletion outcome. */
export function paperDeleteFailure(error: unknown): ResearchKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'research/delete-path-changed') return 'deletePathChanged'
  if (code === 'research/paper-busy') return 'deleteBusy'
  if (code === 'research/not-found') return 'deleteMissing'
  return 'deleteFailed'
}

/** @param props - confirmed catalog entry, command, and cancellation callback. @returns the paper removal confirmation. */
export function DeletePaperDialog({ paper, t, deletePaper, onClose }: Pick<ResearchSeats, 't' | 'deletePaper'> & {
  paper: ResearchPaper
  onClose: () => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ResearchKey>()
  useEffect(() => { setAcknowledged(false) }, [paper.directory])
  const submit = async (): Promise<void> => {
    if (!acknowledged || busy || paper.directory === undefined) return
    setBusy(true); setError(undefined)
    try { await deletePaper({ paperId: paper.id, directory: paper.directory }); onClose() }
    catch (error: unknown) { setAcknowledged(false); setError(paperDeleteFailure(error)) }
    finally { setBusy(false) }
  }
  return <Modal open title={t('deletePaperTitle', { title: paper.title })} closeLabel={t('close')}
    onClose={() => { if (!busy) onClose() }} footer={<>
      <Button data-modal-autofocus disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button className={css.deleteConfirm} icon={<IconTrashOutlineRegular size={16} />}
        disabled={!acknowledged || busy || paper.directory === undefined} onClick={() => { void submit() }}>{t(busy ? 'deletingPaper' : 'deletePaper')}</Button>
    </>}>
    <div className={css.deleteDetails}>
      <p>{t('deletePaperWarning')}</p>
      <label>{t('deleteDirectory')}<code className={css.deletePath}>{paper.directory ?? t('deletePathUnavailable')}</code></label>
      <Checkbox checked={acknowledged} onChange={setAcknowledged} disabled={busy || paper.directory === undefined} label={t('confirmDeleteDirectory')} />
      {error !== undefined && <p role="alert">{t(error)}</p>}
    </div>
  </Modal>
}
