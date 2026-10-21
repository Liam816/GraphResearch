/** File previews share the app's PDF, Markdown, and syntax-highlighted code renderers. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, CodeBlock, MarkdownText, StateDot, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchFileContent } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PaperFilesProps } from './Files.tsx'
import css from './Files.module.css'

type TextContent = Extract<ResearchFileContent, { kind: 'text' }>

function TextPreview({ content, reload, saved, ...props }: PaperFilesProps & {
  content: TextContent
  reload: () => void
  saved: (content: TextContent) => void
}) {
  const { path } = content
  const { paper, view, viewActions: actions, t, saveFile } = props
  const draft = view.files?.drafts[path]
  const reading = view.files?.reading[path]
  const preview = reading?.mode !== 'edit' || !content.editable
  const text = draft?.text ?? content.text
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'fileConflict' | 'fileSaveFailed'>()
  const [latest, setLatest] = useState(false)
  const rendered = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const readingRef = useRef(reading)
  readingRef.current = reading
  const conflict = draft !== undefined && draft.version !== content.version
  useLayoutEffect(() => {
    let restored = false
    const restore = (): void => {
      const node = preview ? rendered.current : editor.current
      if (restored || node === null || node.clientHeight === 0) return
      const current = readingRef.current
      const position = preview ? current?.preview : current?.editor
      if (position !== undefined) { node.scrollTop = position.top; node.scrollLeft = position.left }
      if (!preview && current?.editor !== undefined && node instanceof HTMLTextAreaElement) {
        node.setSelectionRange(current.editor.start, current.editor.end, current.editor.direction)
      }
      restored = true
    }
    restore()
    const node = preview ? rendered.current : editor.current
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(restore)
    if (node !== null) observer?.observe(node)
    return () => { observer?.disconnect() }
  }, [path, preview])
  const savePosition = (node: HTMLTextAreaElement): void => {
    if (node.clientHeight > 0) actions.fileReading(paper.id, path, { editor: { top: node.scrollTop, left: node.scrollLeft,
      start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection } })
  }
  const save = async (): Promise<void> => {
    if (draft === undefined || busy || conflict) return
    setBusy(true); setError(undefined)
    try {
      const result = await saveFile({ paperId: paper.id, path, text, expectedVersion: draft.version })
      if (result.kind !== 'text') throw new Error('Markdown save did not return text')
      saved(result)
      actions.fileSaved(paper.id, path, text, result.version)
    } catch (reason: unknown) {
      setError(typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'research/file-conflict' ? 'fileConflict' : 'fileSaveFailed')
    } finally { setBusy(false) }
  }
  return <div className={css.document}>
    <div className={css.toolbar}>
      <span role="status">{content.editable ? t(busy ? 'saving' : draft !== undefined ? 'unsaved' : 'saved') : t('readOnly')}</span>
      {content.editable && <><Button size="sm" onClick={() => { actions.fileReading(paper.id, path, { mode: preview ? 'edit' : 'preview' }); setLatest(false) }}>{t(preview ? 'edit' : 'preview')}</Button>
        <Button size="sm" disabled={busy || draft === undefined || conflict} onClick={() => { void save() }}>{t('saveFile')}</Button></>}
    </div>
    {(conflict || error !== undefined) && <div className={css.notice} role="alert">{t(conflict ? 'fileConflict' : error ?? 'fileSaveFailed')}
      <Button size="sm" onClick={reload}>{t('reloadFile')}</Button>
      <Button size="sm" onClick={() => { setLatest(!latest); actions.fileReading(paper.id, path, { mode: 'preview' }) }}>{t(latest ? 'viewDraft' : 'latestSaved')}</Button>
      <Button size="sm" disabled={busy} onClick={() => { actions.fileDiscard(paper.id, path); setError(undefined); setLatest(false); reload() }}>{t('discard')}</Button>
    </div>}
    {preview ? <div ref={rendered} className={css.preview} data-paper-file-preview onScroll={(event) => {
      const node = event.currentTarget
      if (node.clientHeight > 0) actions.fileReading(paper.id, path, { preview: { top: node.scrollTop, left: node.scrollLeft } })
    }}>
      {content.editable ? <MarkdownText text={latest ? content.text : text} labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />
        : <CodeBlock className={css.code} code={content.text} lang={languageForPath(path)} lineNumbers copyLabel={t('copy')} copiedLabel={t('copied')} />}
    </div> : <textarea ref={editor} className={css.editor} aria-label={t('editFile', { path })} value={text} spellCheck={false}
      onChange={(event) => { actions.fileEdit(paper.id, path, event.target.value, content.version); savePosition(event.currentTarget) }}
      onSelect={(event) => { savePosition(event.currentTarget) }} onScroll={(event) => { savePosition(event.currentTarget) }}
      onBlur={(event) => { savePosition(event.currentTarget) }}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save() } }} />}
  </div>
}

/**
 * Preview the selected paper file using the existing document renderers.
 * @param props - selected paper-relative file and retained view preferences.
 * @returns its PDF, image, Markdown, or code preview.
 */
export function PaperFilePreview({ path, ...props }: PaperFilesProps & { path: string }) {
  const { paper, readFile, t, revision } = props
  const [content, setContent] = useState<ResearchFileContent>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const pdf = /\.pdf$/i.test(path)
  useEffect(() => {
    if (pdf) return
    let active = true
    void readFile({ paperId: paper.id, path }).then((value) => { if (active) { setContent(value); setFailed(false) } })
      .catch((_error: unknown) => { if (active) setFailed(true) })
    return () => { active = false }
  }, [paper.id, path, readFile, revision, attempt, pdf])
  if (pdf) {
    const absolute = `${paper.directory?.replace(/[\\/]$/, '') ?? paper.pdfPath.replace(/[\\/][^\\/]+$/, '')}/${path}`
    return props.renderFactorySlot('document.pdf', { path: absolute, viewKey: path === 'paper.pdf' ? paper.id : `${paper.id}/${path}` })
  }
  const reload = (): void => { setAttempt(value => value + 1) }
  return <div className={css.document}>
    {failed && <div className={css.notice} role="alert">{t('fileReadFailed')}<Button size="sm" onClick={reload}>{t('retry')}</Button></div>}
    {content === undefined ? !failed && <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={28} /></div>
      : content.kind === 'text' ? <TextPreview {...props} content={content} reload={reload} saved={(value) => { setContent(value); reload() }} />
        : content.kind === 'image' ? <div className={css.image}><img src={content.src} alt={path} /></div>
          : <div className={css.empty}><p>{t(content.reason === 'too-large' ? 'fileTooLarge' : 'fileUnsupported')}</p></div>}
  </div>
}
