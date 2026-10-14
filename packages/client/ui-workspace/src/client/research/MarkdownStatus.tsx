/** Confirmed full-text conversion status and paper-local retry feedback. */
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchWorkbenchProps } from './contract.ts'
import css from './Research.module.css'

/**
 * Keep complete-publication and retry failures visible beside the original PDF.
 * @param props - confirmed paper, localized copy, and owning Host retry operation.
 * @returns filename and page count, or actionable failure feedback.
 */
export function PaperMarkdownStatus({ paper, t, extractMarkdown }: Pick<ResearchWorkbenchProps, 't' | 'extractMarkdown'> & { paper: ResearchPaper }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const retry = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setFailed(false)
    try { await extractMarkdown(paper.id) } catch (error: unknown) {
      // A transport failure retains the previous paper and its extraction status for retry.
      console.error('Paper Markdown retry failed:', error)
      if (mounted.current) setFailed(true)
    } finally { if (mounted.current) setBusy(false) }
  }
  const markdown = paper.markdown
  if (markdown === undefined) return null
  return <div className={css.notice} role={markdown.status === 'failed' || failed ? 'alert' : 'status'}>
    <span>{markdown.status === 'ready' ? t('markdownReady', { pages: String(markdown.pages) })
      : t(markdown.code === 'no-text' ? 'markdownNoText' : markdown.code === 'text-limit' ? 'markdownLimit'
        : markdown.code === 'timeout' ? 'markdownTimeout' : markdown.code === 'source-changed' ? 'markdownSourceChanged' : 'markdownFailed')}</span>
    {markdown.status === 'failed' && <Button size="sm" disabled={busy} onClick={() => { void retry() }}>
      {t(busy ? 'markdownConverting' : 'retry')}</Button>}
    {failed && <span>{t('markdownRetryFailed')}</span>}
  </div>
}
