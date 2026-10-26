/** Reader-local history queries retain successful results while refreshes or retries are pending. */
import { useEffect, useRef, useState } from 'react'
import type { ResearchTranslationHistoryEntry } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PdfTranslation } from './highlights.ts'

/**
 * Load one PDF's saved translations and expose confirmed new results immediately.
 * @param translation - paper-owned commands and a PDF-version key.
 * @returns retained history, query recovery and selection commands with success publication.
 */
export function useTranslationHistory(translation: PdfTranslation | undefined): {
  readonly entries: readonly ResearchTranslationHistoryEntry[]
  readonly failed: boolean
  readonly retry: () => void
  readonly translation: PdfTranslation | undefined
} {
  const key = translation?.history?.key
  const callbacks = useRef(translation)
  const revision = useRef(0)
  callbacks.current = translation
  const [state, setState] = useState<{
    key: string | undefined
    entries: readonly ResearchTranslationHistoryEntry[]
    failed: boolean
  }>({ key, entries: [], failed: false })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const lifetime = new AbortController()
    const queryRevision = ++revision.current
    if (key === undefined || callbacks.current?.history === undefined) return
    void callbacks.current.history.list(lifetime.signal).then((entries) => {
      if (!lifetime.signal.aborted && revision.current === queryRevision) setState({ key, entries, failed: false })
    }, (_error: unknown) => {
      if (!lifetime.signal.aborted && revision.current === queryRevision) {
        setState(previous => ({ key, entries: previous.key === key ? previous.entries : [], failed: true }))
      }
    })
    return () => { lifetime.abort() }
  }, [key, attempt])
  return {
    entries: state.key === key ? state.entries : [],
    failed: state.key === key && state.failed,
    retry: () => { setAttempt(value => value + 1) },
    translation: translation === undefined ? undefined : { ...translation, translate: async (selection, signal) => {
      const result = await translation.translate(selection, signal)
      if (!signal.aborted && key !== undefined && callbacks.current?.history?.key === key) {
        revision.current++
        setState((previous) => {
          const entries = previous.key === key ? previous.entries : []
          const saved = entries.find(item => item.translation.key === result.key)
          const entry: ResearchTranslationHistoryEntry = { ...saved, translation: result,
            selection: { start: selection.start, end: selection.end, ...selection.rects === undefined ? {} : { rects: selection.rects } } }
          return { key, failed: false, entries: saved === undefined ? [...entries, entry]
            : entries.map(item => item.translation.key === result.key ? entry : item) }
        })
        // Restart an older query so it cannot replace a newly confirmed selection.
        setAttempt(value => value + 1)
      }
      return result
    } },
  }
}

/**
 * Find all saved explanations for one exact PDF occurrence, keeping repeated words independent.
 * @param entries - confirmed results for the current PDF version.
 * @param key - one saved explanation's key.
 * @returns the occurrence's results in newest-first storage order.
 */
export function translationOccurrence(
  entries: readonly ResearchTranslationHistoryEntry[], key: string,
): readonly ResearchTranslationHistoryEntry[] {
  const selected = entries.find(item => item.translation.key === key)
  if (selected === undefined) return []
  if (selected.selection === undefined) return [selected]
  const position = (item: ResearchTranslationHistoryEntry): string => JSON.stringify([item.translation.sourceSha256,
    item.selection?.start.page, item.selection?.start.item, item.selection?.start.offset,
    item.selection?.end.page, item.selection?.end.item, item.selection?.end.offset])
  return entries.filter(item => item.selection !== undefined
    && position(item) === position(selected)).toReversed()
}
