/** Topic → paper directory, with durable creation through injected commands. */
import { useState } from 'react'
import {
  Button, Input, Modal, Tooltip, IconPlusOutlineRegular, IconNewChatOutlineMedium,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { paperForSession } from './conversation-records.ts'
import type { ResearchPaper, ResearchTopic, ResearchTopicId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchDirectoryProps } from './contract.ts'
import { ResearchLibrarySettings } from './LibrarySettings.tsx'
import { ResearchPaperRow } from './PaperRow.tsx'
import { DeletePaperDialog } from './DeletePaper.tsx'
import { ResearchTopicActions, RenameTopicDialog } from './TopicActions.tsx'
import css from './Research.module.css'

/** @param props - catalog hook, view store, navigation, and durable commands. @returns the research directory. */
export function ResearchDirectory(props: ResearchDirectoryProps) {
  const { t, actions } = props
  const { catalog, phase } = props.useResearch(value => value)
  const view = props.useStore(value => value)
  const current = props.useSessions(value => Object.values(value.byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<'topic' | ResearchTopicId>()
  const [title, setTitle] = useState('')
  const [pdfPath, setPdfPath] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [deleting, setDeleting] = useState<ResearchPaper>()
  const [renaming, setRenaming] = useState<ResearchTopic>()
  const needsRestart = phase === 'ready' && catalog.directory === undefined
  const filter = query.trim().toLocaleLowerCase()
  const topics = catalog.topics.filter(topic => topic.title.toLocaleLowerCase().includes(filter)
    || catalog.papers.some(paper => paper.topicIds.includes(topic.id) && paper.title.toLocaleLowerCase().includes(filter)))
  const start = (target: 'topic' | ResearchTopicId): void => {
    setDialog(target); setTitle(''); setPdfPath(''); setRepositoryUrl(''); setError(false)
  }
  const submit = async (): Promise<void> => {
    if (dialog === undefined || title.trim() === '' || needsRestart) return
    setBusy(true); setError(false)
    try {
      if (dialog === 'topic') await props.createTopic({ title: title.trim() })
      else await props.createPaper({ topicId: dialog, title: title.trim(), pdfPath: pdfPath.trim(), repositoryUrl: repositoryUrl.trim() })
      setDialog(undefined)
    } catch (error: unknown) {
      // Creation failures leave the form and entered metadata available for retry.
      console.error('Research creation failed:', error)
      setError(true)
    } finally { setBusy(false) }
  }

  return <section className={css.directory} aria-label={t('research')}>
    <div className={css.directoryHeader}>
      {catalog.directory !== undefined && <p className={css.libraryLocation} title={catalog.directory}>{catalog.directory}</p>}
      <ResearchLibrarySettings directory={catalog.directory} t={t} configureDirectory={props.configureDirectory} />
    </div>
    <Button variant="outline" className={css.createTopic} icon={<IconNewChatOutlineMedium size={14} />}
      aria-haspopup="dialog" onClick={() => { start('topic') }}>{t('createTopic')}</Button>
    <Input icon={<IconSearchOutlineRegular size={16} />} aria-label={t('search')} placeholder={t('search')}
      value={query} onChange={(event) => { setQuery(event.target.value) }} />
    {phase === 'loading' && <p className={css.hint} role="status">{t('loading')}</p>}
    {needsRestart && <div className={css.notice} role="alert">{t('backendRestartRequired')}</div>}
    {phase === 'error' && <div className={css.notice} role="alert">{t('directoryFailed')}
      <Button size="sm" onClick={() => { void props.refresh().catch(() => { setError(true) }) }}>{t('retry')}</Button>
    </div>}
    {phase === 'ready' && catalog.topics.length === 0 && <div className={css.directoryEmpty}>
      <IconFolderCloseRegular size={22} /><strong>{t('empty')}</strong><p>{t('emptyHint')}</p>
    </div>}
    {catalog.topics.length > 0 && topics.length === 0 && <p className={css.hint}>{t('noResults')}</p>}
    <nav aria-label={t('research')} className={css.tree}>
      <ul>{topics.map((topic) => {
        const papers = catalog.papers.filter(paper => paper.topicIds.includes(topic.id)
          && (topic.title.toLocaleLowerCase().includes(filter) || paper.title.toLocaleLowerCase().includes(filter)))
        const expanded = filter !== '' || view.expanded[topic.id] !== false
        const Chevron = expanded ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular
        return <li key={topic.id}>
          <div className={css.treeRow}>
            <button className={css.chevron} type="button" aria-label={t(expanded ? 'fold' : 'expand', { title: topic.title })}
              aria-expanded={expanded} onClick={() => { actions.expand(topic.id, !expanded) }}><Chevron size={14} /></button>
            <button type="button" className={css.treeTitle} aria-current={current === topic.sessionId ? 'page' : undefined}
              onClick={() => { actions.topic(topic.id); props.open(topic.sessionId) }}>
              <IconFolderCloseRegular size={16} /><span>{topic.title}</span>
            </button>
            <ResearchTopicActions topic={topic} t={t} onRename={() => { setRenaming(topic) }} />
            <Tooltip label={t('addPaperToTopic', { title: topic.title })} side="right" portal>
              <button type="button" className={css.addPaper} aria-label={t('addPaperToTopic', { title: topic.title })}
                onClick={() => { start(topic.id) }}><IconPlusOutlineRegular size={16} /></button>
            </Tooltip>
          </div>
          {expanded && <ul className={css.children}>{papers.map(paper => <ResearchPaperRow key={paper.id}
            paper={paper} selected={paperForSession(catalog, current)?.id === paper.id} t={t}
            onOpen={() => { actions.topic(topic.id); props.open(paper.sessionId) }} onDelete={() => { setDeleting(paper) }} />)}</ul>}
        </li>
      })}</ul>
    </nav>
    <Modal open={dialog !== undefined} title={t(dialog === 'topic' ? 'createTopic' : 'addPaper')} closeLabel={t('close')}
      onClose={() => { if (!busy) setDialog(undefined) }} footer={<>
        <Button disabled={busy} onClick={() => { setDialog(undefined) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || title.trim() === '' || needsRestart}
          onClick={() => { void submit() }}>{t(busy ? 'creating' : 'create')}</Button>
      </>}>
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label>{t('title')}<Input data-modal-autofocus value={title} onChange={(event) => { setTitle(event.target.value) }} required /></label>
        {dialog === 'topic' ? <p className={css.hint}>{t('managedWorkspace')}</p>
          : <><label>{t('pdfPath')}<Input aria-label={t('pdfPath')} value={pdfPath} onChange={(event) => { setPdfPath(event.target.value) }} /><small>{t('pdfHint')}</small></label>
            <label>{t('repository')}<Input aria-label={t('repository')} type="url" value={repositoryUrl} onChange={(event) => { setRepositoryUrl(event.target.value) }} /><small>{t('repositoryHint')}</small></label></>}
        {needsRestart ? <p role="alert">{t('backendRestartRequired')}</p> : error && <p role="alert">{t('createFailed')}</p>}
      </form>
    </Modal>
    {deleting !== undefined && <DeletePaperDialog paper={catalog.papers.find(item => item.id === deleting.id) ?? deleting}
      t={t} deletePaper={props.deletePaper} onClose={() => { setDeleting(undefined) }} />}
    {renaming !== undefined && <RenameTopicDialog topic={renaming} t={t} renameTopic={props.renameTopic}
      onClose={() => { setRenaming(undefined) }} />}
  </section>
}
