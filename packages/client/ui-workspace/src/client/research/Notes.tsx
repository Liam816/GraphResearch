/** Independently saved AI and learning notebooks; drafts survive paper switches. */
import { useState } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchSeats } from './contract.ts'
import type { PaperView } from './store.ts'
import css from './Research.module.css'

/** @param props - confirmed paper, saved panel preferences, and injected note commands. @returns a Markdown notebook editor. */
export function ResearchNotes({ paper, view, ...props }: Pick<ResearchSeats, 't' | 'actions' | 'saveNote' | 'refresh'> & { paper: ResearchPaper; view: PaperView }) {
  const { t, actions } = props
  const kind = view.notebook
  const draft = view.drafts[kind]
  const text = draft?.text ?? paper[kind].text
  const [mode, setMode] = useState<'auto' | 'edit' | 'preview'>('auto')
  const [latest, setLatest] = useState(false)
  const preview = mode === 'preview' || (mode === 'auto' && kind === 'ai')
  const conflict = draft !== undefined && draft.revision !== paper[kind].revision
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'conflict' | 'failed'>()
  const save = async (): Promise<void> => {
    if (draft === undefined || busy) return
    setBusy(true); setError(undefined)
    try {
      await props.saveNote({ paperId: paper.id, kind, text, expectedRevision: draft.revision })
      actions.saved(paper.id, kind, text, draft.revision + 1)
    } catch (reason: unknown) {
      setError(typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'research/note-conflict' ? 'conflict' : 'failed')
    } finally { setBusy(false) }
  }
  return <div className={css.notebook}>
    <div className={css.noteTabs} role="group" aria-label={t('notes')}>
      {(['learning', 'ai'] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={value === kind}
        onClick={() => { actions.notebook(paper.id, value); setMode('auto'); setLatest(false); setError(undefined) }}>{t(value)}</button>)}
    </div>
    <div className={css.noteToolbar}><span className={css.hint} role="status">{t(busy ? 'saving' : draft !== undefined ? 'unsaved' : 'saved')}</span>
      <Button size="sm" onClick={() => { setMode(preview ? 'edit' : 'preview'); setLatest(false) }}>{t(preview ? 'edit' : 'preview')}</Button>
      <Button size="sm" disabled={busy || draft === undefined} onClick={() => { void save() }}>{t('save')}</Button>
    </div>
    {kind === 'ai' && <p className={css.noteHint}>{t('aiHint')}</p>}
    {(error !== undefined || conflict) && <div className={css.notice} role="alert">{t(conflict ? 'conflict' : error ?? 'conflict')}
      {(error === 'conflict' || conflict) && <>
        <Button size="sm" onClick={() => { setLatest(true); setMode('preview') }}>{t('latestSaved')}</Button>
        <Button size="sm" onClick={() => { void props.refresh().catch(() => { setError('failed') }) }}>{t('refresh')}</Button>
        <Button size="sm" onClick={() => { actions.discard(paper.id, kind); setLatest(false); setError(undefined) }}>{t('discard')}</Button></>}
    </div>}
    {preview ? <div className={css.notePreview} data-research-note-preview>{(latest ? paper[kind].text : text) === '' ? <p className={css.hint}>{t('emptyNote')}</p>
      : <MarkdownText text={latest ? paper[kind].text : text} labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />}</div>
      : <textarea className={css.noteEditor} aria-label={t(kind)} placeholder={t('notePlaceholder')} value={text}
        onChange={(event) => { actions.edit(paper.id, kind, event.target.value, paper[kind].revision) }}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save() } }} />}
  </div>
}
