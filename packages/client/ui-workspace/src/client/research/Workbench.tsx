/** Session-aware paper workspace, composing existing Agent and PDF factories. */
import { Fragment, useRef, useState } from 'react'
import { Button, Input, Modal, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaperId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchWorkbenchProps } from './contract.ts'
import { defaultPaperView, type ResearchPanel } from './store.ts'
import { ResearchNotes } from './Notes.tsx'
import css from './Research.module.css'

/** @param props - current Session seats, catalog, layout store, and factory renderer. @returns a topic chat or paper workspace. */
export function ResearchWorkbench(props: ResearchWorkbenchProps) {
  const { t, viewActions: actions, sessionId, view: state } = props
  const { catalog } = props.useResearch(value => value)
  const session = props.useSession(value => value)
  const conversationActive = props.useConversation(value => value.activeTargets.size > 0) ?? false
  const paper = catalog.papers.find(item => item.sessionId === sessionId)
  const topic = paper === undefined ? catalog.topics.find(item => item.sessionId === sessionId)
    : catalog.topics.find(item => item.id === state.topicId && paper.topicIds.includes(item.id))
      ?? catalog.topics.find(item => paper.topicIds.includes(item.id))
  const view = paper === undefined ? defaultPaperView() : state.papers[paper.id] ?? defaultPaperView()
  const panels = (['agent', 'pdf', 'notes'] as const).filter(panel => view.panels[panel])
  const [referencesOpen, setReferencesOpen] = useState(false)
  const [selected, setSelected] = useState<ResearchPaperId[]>([])
  const [query, setQuery] = useState('')
  const [referenceError, setReferenceError] = useState(false)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [inserted, setInserted] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number }>()
  const settling = sessionId !== undefined && session?.openState !== 'open' && session?.blank !== true
  const hero = sessionId === undefined || (session?.blank === true && !session.running && !conversationActive && !session.promptAttempted)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  const agent = () => props.renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero })
  const insert = async (): Promise<void> => {
    const input = props.inputActions
    if (input === undefined || selected.length === 0 || selected.length > 3) { setReferenceError(true); return }
    const span = input.captureInsertion()
    setReferenceBusy(true); setReferenceError(false)
    try {
      const mentions = await props.mentions(selected)
      if (!input.insertText(`${mentions.join(' ')} `, span)) { setReferenceError(true); return }
      if (paper !== undefined) actions.focus(paper.id, 'agent')
      setReferencesOpen(false); setInserted(true)
    } catch (_error: unknown) {
      // A failed or stale insertion keeps the user's selected papers available for retry.
      setReferenceError(true)
    } finally { setReferenceBusy(false) }
  }
  const resize = (left: ResearchPanel, right: ResearchPanel, delta: number): void => {
    if (paper !== undefined) actions.widths(paper.id, left, right, delta)
  }
  return <div className={css.workbench} data-research-workbench>
    <header className={css.workbenchHeader}>
      <div className={css.breadcrumb}>{paper !== undefined && topic !== undefined && <button type="button" onClick={() => { props.open(topic.sessionId) }}>{topic.title}</button>}
        {paper !== undefined && topic !== undefined && <span aria-hidden="true">/</span>}<strong>{paper?.title ?? topic?.title ?? t('general')}</strong>
        {(paper !== undefined || topic !== undefined) && <span className={css.sessionBadge}>{t('independent')}</span>}
      </div>
      <div className={css.workbenchTools}>
        {paper !== undefined && <><div className={css.panelControls} role="group" aria-label={t('reset')}>
          {(['agent', 'pdf', 'notes'] as const).map(panel => <button key={panel} type="button" aria-pressed={view.panels[panel]}
            onClick={() => { actions.panel(paper.id, panel) }}>{t(panel)}</button>)}
        </div><Button size="sm" onClick={() => { actions.reset(paper.id) }}>{t('reset')}</Button></>}
        {sessionId !== undefined && <Button size="sm" onClick={() => { setSelected([]); setQuery(''); setReferenceError(false); setReferencesOpen(true) }}>{t('context')}</Button>}
      </div>
    </header>
    {inserted && <div className={css.inlineStatus} role="status">{t('inserted')}<button type="button" aria-label={t('close')} onClick={() => { setInserted(false) }}><IconCloseOutlineRegular size={12} /></button></div>}
    {paper === undefined ? <div className={css.topicChat}>
      {topic !== undefined && <div className={css.topicIntro}><span>{t('topic')}</span><h1>{topic.title}</h1><p>{t('topicDescription')}</p><small>{t('paperCount', { count: catalog.papers.filter(item => item.topicIds.includes(topic.id)).length })}</small></div>}
      <div className={css.agentContent}>{agent()}</div>
    </div> : <>
      {panels.length > 1 && <div className={css.narrowTabs} role="group" aria-label={t('paper')}>
        {panels.map(panel => <button key={panel} type="button" aria-pressed={view.active === panel} onClick={() => { actions.focus(paper.id, panel) }}>{t(panel)}</button>)}
      </div>}
      <div className={css.panels} ref={body}>
        {panels.length === 0 && <div className={css.allClosed}><h2>{t('hidden')}</h2><p>{t('hiddenHint')}</p><Button onClick={() => { actions.reset(paper.id) }}>{t('reset')}</Button></div>}
        {(['agent', 'pdf', 'notes'] as const).map((panel) => {
          const next = panels[panels.indexOf(panel) + 1]
          const visible = view.panels[panel]
          return <Fragment key={panel}><section className={css.panel} hidden={!visible} data-active={view.active === panel}
            style={{ flexGrow: view.widths[panel] }} aria-label={t(panel)}>
            <div className={css.panelHeader}><strong>{t(panel)}</strong><button type="button" aria-label={t('collapse', { panel: t(panel) })}
              onClick={() => { actions.panel(paper.id, panel) }}><IconCloseOutlineRegular size={14} /></button></div>
            <div className={css.panelBody}>
              {panel === 'agent' ? agent() : panel === 'pdf' ? props.renderFactorySlot('document.pdf', { path: paper.pdfPath })
                : <ResearchNotes key={paper.id} {...props} actions={actions} paper={paper} view={view} />}
            </div>
          </section>{visible && next !== undefined && <div className={css.divider} role="separator" tabIndex={0} aria-orientation="vertical"
            aria-label={t('resize', { left: t(panel), right: t(next) })} aria-valuenow={Math.round(view.widths[panel])} aria-valuemin={12} aria-valuemax={88}
            onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(panel, next, event.key === 'ArrowLeft' ? -2 : 2) } }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { x: event.clientX, width: body.current?.clientWidth ?? 1 }
            }}
            onPointerMove={(event) => { if (drag.current === undefined || !event.currentTarget.hasPointerCapture(event.pointerId)) return
              const delta = (event.clientX - drag.current.x) / drag.current.width * panels.reduce((sum, item) => sum + view.widths[item], 0)
              resize(panel, next, delta); drag.current.x = event.clientX }}
            onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); drag.current = undefined }}
            onLostPointerCapture={() => { drag.current = undefined }} />}</Fragment>
        })}
      </div>
    </>}
    <Modal open={referencesOpen} title={t('context')} description={t('contextHint')} closeLabel={t('close')}
      onClose={() => { if (!referenceBusy) setReferencesOpen(false) }} footer={<>
        <Button disabled={referenceBusy} onClick={() => { setReferencesOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={referenceBusy || selected.length === 0 || selected.length > 3} onClick={() => { void insert() }}>{t('insert')}</Button>
      </>}>
      <Input data-modal-autofocus aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <div className={css.referenceList}>{catalog.papers.filter(item => item.sessionId !== sessionId
        && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item =>
        <label key={item.id}><input type="checkbox" disabled={referenceBusy || (!selected.includes(item.id) && selected.length >= 3)} checked={selected.includes(item.id)}
          onChange={(event) => {
            setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))
          }} /><span>{item.title}</span></label>)}
      {catalog.papers.filter(item => item.sessionId !== sessionId).length === 0 && <p>{t('noRelated')}</p>}
      </div>
      {referenceError && <p role="alert">{t('referenceFailed')}</p>}
    </Modal>
  </div>
}
