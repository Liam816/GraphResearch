/** Topic removal confirms every exclusive paper directory and retains shared papers. */
import { useState } from 'react'
import { Button, Checkbox, IconTrashOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchCatalog, ResearchTopic } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import type { ResearchKey } from './locales.ts'
import css from './Research.module.css'

/** @param error - rejected Topic removal. @returns localized outcome and recovery guidance. */
export function topicDeleteFailure(error: unknown): ResearchKey {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'research/delete-path-changed' || code === 'research/topic-contents-changed') return 'deleteTopicChanged'
  if (code === 'research/topic-busy') return 'deleteTopicBusy'
  if (code === 'research/not-found') return 'renameTopicMissing'
  return 'deleteFailed'
}

/** @param props - current Topic, full catalog, durable removal command and dismissal. @returns explicit path confirmation. */
export function DeleteTopicDialog({ topic, catalog, t, deleteTopic, onClose }: Pick<ResearchSeats, 't' | 'deleteTopic'> & {
  topic: ResearchTopic
  catalog: ResearchCatalog
  onClose: () => void
}) {
  const [acknowledged, setAcknowledged] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ResearchKey>()
  const papers = catalog.papers.filter(paper => paper.topicIds.includes(topic.id) && paper.topicIds.length === 1)
  const shared = catalog.papers.filter(paper => paper.topicIds.includes(topic.id) && paper.topicIds.length > 1).length
  const separator = catalog.directory?.includes('\\') ? '\\' : '/'
  const directory = catalog.directory === undefined ? undefined : [catalog.directory.replace(/[/\\]$/u, ''), 'topics', topic.id].join(separator)
  const identity = JSON.stringify([directory, papers.map(paper => [paper.id, paper.directory])])
  const confirmedPapers = papers.flatMap(paper => paper.directory === undefined ? [] : [{ paperId: paper.id, directory: paper.directory }])
  const ready = directory !== undefined && catalog.topics.some(item => item.id === topic.id) && confirmedPapers.length === papers.length
  const submit = async (): Promise<void> => {
    if (acknowledged !== identity || busy || directory === undefined || !ready) return
    setBusy(true); setError(undefined)
    try {
      await deleteTopic({ topicId: topic.id, directory, papers: confirmedPapers })
      onClose()
    } catch (error: unknown) { setAcknowledged(undefined); setError(topicDeleteFailure(error)) }
    finally { setBusy(false) }
  }
  return <Modal open title={t('deleteTopicTitle', { title: topic.title })} closeLabel={t('close')}
    onClose={() => { if (!busy) onClose() }} footer={<>
      <Button data-modal-autofocus disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button className={css.deleteConfirm} icon={<IconTrashOutlineRegular size={16} />}
        disabled={acknowledged !== identity || busy || !ready}
        onClick={() => { void submit() }}>{t(busy ? 'deletingPaper' : 'deleteTopic')}</Button>
    </>}>
    <div className={css.deleteDetails}>
      <p>{t('deleteTopicWarning')}</p>
      <label>{t('deleteDirectory')}<code className={css.deletePath}>{directory ?? t('deletePathUnavailable')}</code></label>
      {papers.map(paper => <label key={paper.id}>{paper.title}<code className={css.deletePath}>{paper.directory ?? t('deletePathUnavailable')}</code></label>)}
      {shared > 0 && <p>{t('deleteTopicShared', { count: String(shared) })}</p>}
      <div><Checkbox checked={acknowledged === identity} onChange={(checked) => { setAcknowledged(checked ? identity : undefined) }}
        disabled={busy || !ready} label={t('confirmDeleteDirectory')} /></div>
      {error !== undefined && <p role="alert">{t(error)}</p>}
    </div>
  </Modal>
}
