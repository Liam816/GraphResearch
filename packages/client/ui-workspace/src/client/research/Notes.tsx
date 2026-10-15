/** Independently saved AI and learning notebooks; drafts survive paper switches. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
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
  const reading = view.reading?.[kind]
  const readingRef = useRef(reading)
  readingRef.current = reading
  const latest = reading?.latest === true
  const preview = reading?.mode === 'preview' || (reading?.mode !== 'edit' && kind === 'ai')
  const editor = useRef<HTMLTextAreaElement>(null)
  const rendered = useRef<HTMLDivElement>(null)
  const saveEditor = useCallback((node: HTMLTextAreaElement): void => {
    if (node.clientHeight === 0 || node.closest('[hidden]') !== null) return
    actions.noteEditor(paper.id, kind, { top: node.scrollTop, left: node.scrollLeft,
      start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })
  }, [actions, paper.id, kind])
  const savePreview = useCallback((node: HTMLDivElement): void => {
    if (node.clientHeight > 0 && node.closest('[hidden]') === null) actions.notePreview(paper.id, kind, { top: node.scrollTop, left: node.scrollLeft })
  }, [actions, paper.id, kind])
  useLayoutEffect(() => {
    let restored = false
    const restore = (): void => {
      if (restored) return
      const current = readingRef.current
      const node = preview ? rendered.current : editor.current
      if (node === null || node.clientHeight === 0 || node.closest('[hidden]') !== null) return
      const position = preview ? current?.preview : current?.editor
      if (position !== undefined) {
        if (!preview && node instanceof HTMLTextAreaElement && current?.editor !== undefined) {
          const selection = current.editor
          const start = Number.isFinite(selection.start) ? Math.max(0, Math.min(node.value.length, selection.start)) : 0
          const end = Number.isFinite(selection.end) ? Math.max(start, Math.min(node.value.length, selection.end)) : start
          node.setSelectionRange(start, end, selection.direction === 'backward' ? 'backward' : selection.direction === 'forward' ? 'forward' : 'none')
        }
        node.scrollTop = Number.isFinite(position.top) ? Math.max(0, position.top) : 0
        node.scrollLeft = Number.isFinite(position.left) ? Math.max(0, position.left) : 0
      }
      restored = true
    }
    restore()
    const node = preview ? rendered.current : editor.current
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(restore)
    if (node !== null) observer?.observe(node)
    // Live edits and scroll samples must not repeatedly restore an already mounted surface.
    return () => { observer?.disconnect() }
  }, [paper.id, kind, preview, latest])
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
        onClick={() => { actions.notebook(paper.id, value); setError(undefined) }}>{t(value)}</button>)}
    </div>
    <div className={css.noteToolbar}><span className={css.hint} role="status">{t(busy ? 'saving' : draft !== undefined ? 'unsaved' : 'saved')}</span>
      <Button size="sm" onClick={() => { actions.noteMode(paper.id, kind, preview ? 'edit' : 'preview') }}>{t(preview ? 'edit' : 'preview')}</Button>
      <Button size="sm" disabled={busy || draft === undefined} onClick={() => { void save() }}>{t('save')}</Button>
    </div>
    {kind === 'ai' && <p className={css.noteHint}>{t('aiHint')}</p>}
    {(error !== undefined || conflict) && <div className={css.notice} role="alert">{t(conflict ? 'conflict' : error ?? 'conflict')}
      {(error === 'conflict' || conflict) && <>
        <Button size="sm" onClick={() => { actions.noteMode(paper.id, kind, 'preview', true) }}>{t('latestSaved')}</Button>
        <Button size="sm" onClick={() => { void props.refresh().catch(() => { setError('failed') }) }}>{t('refresh')}</Button>
        <Button size="sm" onClick={() => { actions.discard(paper.id, kind); actions.noteMode(paper.id, kind, preview ? 'preview' : 'edit'); setError(undefined) }}>{t('discard')}</Button></>}
    </div>}
    {preview ? <div ref={rendered} key={`${kind}-preview`} className={css.notePreview} data-research-note-preview
      onScroll={(event) => { savePreview(event.currentTarget) }}>{(latest ? paper[kind].text : text) === '' ? <p className={css.hint}>{t('emptyNote')}</p>
        : <MarkdownText text={latest ? paper[kind].text : text} labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />}</div>
      : <textarea ref={editor} key={`${kind}-editor`} className={css.noteEditor} aria-label={t(kind)} placeholder={t('notePlaceholder')} value={text}
        onScroll={(event) => { saveEditor(event.currentTarget) }} onSelect={(event) => { saveEditor(event.currentTarget) }}
        onBlur={(event) => { saveEditor(event.currentTarget) }}
        onChange={(event) => { actions.edit(paper.id, kind, event.target.value, paper[kind].revision); saveEditor(event.currentTarget) }}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save() } }} />}
  </div>
}
