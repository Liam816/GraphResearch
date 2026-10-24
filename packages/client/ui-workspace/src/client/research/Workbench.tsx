/** Session-aware paper workspace, composing existing Agent and PDF factories. */
import { useId, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Button, Input, Modal, Pill, Tooltip, ReferenceIconRegular,
  IconCheckOutlineRegular, IconCloseOutlineRegular, IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { paperForSession } from './conversation-records.ts'
import type { ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchWorkbenchProps } from './contract.ts'
import { defaultPaperView, resolvePanelOrder, type PaperView } from './store.ts'
import { ResearchPaperPanels } from './PaperPanels.tsx'
import { PaperNavigator } from './PaperNavigator.tsx'
import css from './Research.module.css'

/** Header controls toggle independent panels on wide screens and select one panel on narrow screens. */
function PanelControls({ paperId, view, id, navigation = false, t, viewActions }: Pick<ResearchWorkbenchProps, 't' | 'viewActions'> & {
  paperId: ResearchPaperId
  view: PaperView
  id: string
  navigation?: boolean
}) {
  return <div className={clsx(css.panelControls, navigation ? css.panelNavigation : css.panelVisibility)}
    role="group" aria-label={t(navigation ? 'panelFocus' : 'panels')}>
    {resolvePanelOrder(view).map((panel) => {
      const selected = view.panels[panel] && (!navigation || view.active === panel)
      const hint = t(navigation ? 'viewPanel' : selected ? 'collapse' : 'show', { panel: t(panel) })
      return <Tooltip key={panel} label={hint} side="bottom" portal>
        <span className={css.panelControlAnchor}>
          <Pill active={selected} className={css.panelToggle} aria-pressed={selected} aria-controls={`${id}-${panel}`}
            onClick={() => {
              if (navigation) viewActions.focus(paperId, panel)
              else viewActions.panel(paperId, panel)
            }}>
            <span className={css.panelControlIcon} aria-hidden="true">
              <ReferenceIconRegular kind={panel === 'agent' ? 'session' : panel === 'notes' ? 'folder' : 'file'} size={16} />
            </span>
            <span className={css.panelControlLabel}>{t(panel)}</span>
            <span className={css.panelControlState} aria-hidden="true">{selected ? <IconCheckOutlineRegular size={12} />
              : !navigation && <IconPlusOutlineRegular size={12} />}</span>
          </Pill>
        </span>
      </Tooltip>
    })}
  </div>
}

/** @param props - current Session seats, catalog, layout store, and factory renderer. @returns a topic chat or paper workspace. */
export function ResearchWorkbench(props: ResearchWorkbenchProps) {
  const { t, viewActions: actions, view: state } = props
  const sessionId = props.useSessions(value => Object.values(value.byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id)
  const { catalog } = props.useResearch(value => value)
  const resources = props.useResources(value => value)
  const paper = paperForSession(catalog, sessionId)
  const running = props.useSessions(value => paper?.conversations?.some(item => value.byId[item.sessionId]?.running === true)
    ?? (sessionId !== undefined && value.byId[sessionId]?.running === true))
  const topic = paper === undefined ? catalog.topics.find(item => item.sessionId === sessionId)
    : catalog.topics.find(item => item.id === state.topicId && paper.topicIds.includes(item.id))
      ?? catalog.topics.find(item => paper.topicIds.includes(item.id))
  const view = paper === undefined ? defaultPaperView() : state.papers[paper.id] ?? defaultPaperView()
  const topicId = topic?.id
  const topicPapers = useMemo(
    () => catalog.papers.filter(item => topicId !== undefined && item.topicIds.includes(topicId)), [catalog.papers, topicId],
  )
  const panelId = useId()
  const [referencesOpen, setReferencesOpen] = useState(false)
  const [selected, setSelected] = useState<ResearchPaperId[]>([])
  const [query, setQuery] = useState('')
  const [referenceError, setReferenceError] = useState(false)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [inserted, setInserted] = useState(false)
  const agent = () => props.renderSlot('research.agent', { paper })
  const insert = async (): Promise<void> => {
    if (sessionId === undefined || selected.length === 0 || selected.length > 3) { setReferenceError(true); return }
    setReferenceBusy(true); setReferenceError(false)
    try {
      if (!await props.insertReferences(sessionId, selected)) { setReferenceError(true); return }
      if (paper !== undefined) actions.focus(paper.id, 'agent')
      setReferencesOpen(false); setInserted(true)
    } catch (error: unknown) {
      console.error('Research reference insertion failed:', error)
      // A failed or stale insertion keeps the user's selected papers available for retry.
      setReferenceError(true)
    } finally { setReferenceBusy(false) }
  }
  return <div className={css.workbench} data-research-workbench data-research-paper-navigation={topicPapers.length > 0 || undefined}>
    {topic !== undefined && <PaperNavigator topic={topic} papers={topicPapers} activeId={paper?.id ?? null} t={t}
      open={(id) => { actions.topic(topic.id); props.open(id) }} />}
    <header className={css.workbenchHeader}>
      <div className={css.breadcrumb}>{paper !== undefined && topic !== undefined && <button type="button" onClick={() => { props.open(topic.sessionId) }}>{topic.title}</button>}
        {paper !== undefined && topic !== undefined && <span aria-hidden="true">/</span>}<strong>{paper?.title ?? topic?.title ?? t('general')}</strong>
        {(paper !== undefined || topic !== undefined) && <span className={css.sessionBadge}>{t('independent')}</span>}
      </div>
      <div className={css.workbenchTools}>
        {paper !== undefined && <>
          <PanelControls paperId={paper.id} view={view} id={panelId} t={t} viewActions={actions} />
          <PanelControls paperId={paper.id} view={view} id={panelId} t={t} viewActions={actions} navigation />
        </>}
        {sessionId !== undefined && <Button size="sm" onClick={() => { setSelected([]); setQuery(''); setReferenceError(false); setReferencesOpen(true) }}>{t('context')}</Button>}
      </div>
    </header>
    {inserted && <div className={css.inlineStatus} role="status">{t('inserted')}<button type="button" aria-label={t('close')} onClick={() => { setInserted(false) }}><IconCloseOutlineRegular size={12} /></button></div>}
    {paper === undefined ? <div className={css.topicChat}>
      {topic !== undefined && <div className={css.topicIntro}><span>{t('topic')}</span><h1>{topic.title}</h1><p>{t('topicDescription')}</p><small>{t('paperCount', { count: catalog.papers.filter(item => item.topicIds.includes(topic.id)).length })}</small></div>}
      <div className={css.agentContent}>{agent()}</div>
    </div> : <ResearchPaperPanels key={paper.id} paper={paper} view={view} id={panelId} agent={agent()}
      resources={resources} SessionProvider={props.SessionProvider}
      t={t} viewActions={actions} renderFactorySlot={props.renderFactorySlot} saveNote={props.saveNote}
      listFiles={props.listFiles} readFile={props.readFile} saveFile={props.saveFile} revision={`${catalog.revision}:${running}`}
      highlight={props.highlight} extractMarkdown={props.extractMarkdown}
      translate={props.translate} saveTranslation={props.saveTranslation}
      translationAvailable={catalog.capabilities?.pdfTranslations === true}
      askTranslation={(translation) => {
        if (sessionId === undefined) throw new Error('The paper composer is not ready')
        const { context, result } = translation
        const question = t('translationQuestion', { selected: context.selected,
          page: context.startPage, context: [...context.before, context.sentence, ...context.after].join(' '),
          meaning: result.contextualMeaning, explanation: result.explanation, translation: result.translation })
        if (!props.insertText(sessionId, question)) throw new Error('The paper composer changed')
        actions.focus(paper.id, 'agent')
        return Promise.resolve()
      }}
      highlightAvailable={catalog.capabilities?.pdfHighlights === true} refresh={props.refresh} />}
    <Modal open={referencesOpen} title={t('context')} description={t('contextHint')} closeLabel={t('close')}
      onClose={() => { if (!referenceBusy) setReferencesOpen(false) }} footer={<>
        <Button disabled={referenceBusy} onClick={() => { setReferencesOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={referenceBusy || selected.length === 0 || selected.length > 3} onClick={() => { void insert() }}>{t('insert')}</Button>
      </>}>
      <Input data-modal-autofocus aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <div className={css.referenceList}>{catalog.papers.filter(item => item.id !== paper?.id
        && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item =>
        <label key={item.id}><input type="checkbox" disabled={referenceBusy || (!selected.includes(item.id) && selected.length >= 3)} checked={selected.includes(item.id)}
          onChange={(event) => {
            setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))
          }} /><span>{item.title}</span></label>)}
      {catalog.papers.filter(item => item.id !== paper?.id).length === 0 && <p>{t('noRelated')}</p>}
      </div>
      {referenceError && <p role="alert">{t('referenceFailed')}</p>}
    </Modal>
  </div>
}
