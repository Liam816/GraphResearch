/** Translation requests belong to the open PDF, independently of selection popover visibility. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResearchTranslation } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PdfSelection, PdfTranslation } from './highlights.ts'

/** Reader-owned progress for one explicitly requested occurrence. */
export type TranslationRequestState = {
  readonly key: string
  readonly selection: PdfSelection
} & ({ readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly reason: string | undefined }
  | { readonly kind: 'ready'; readonly value: ResearchTranslation })

interface Operation {
  readonly lifetime: AbortController
  state: TranslationRequestState
}

function failureReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'research/translation-failed'
    || !('details' in error) || typeof error.details !== 'object' || error.details === null || !('reason' in error.details)) return
  return typeof error.details.reason === 'string' ? error.details.reason : undefined
}

/** @param selection - captured source positions; viewport placement is excluded. @returns a reader-local occurrence identity. */
export function translationSelectionKey(selection: PdfSelection): string {
  return JSON.stringify([selection.text, selection.start?.page, selection.start?.item, selection.start?.offset,
    selection.end?.page, selection.end?.item, selection.end?.offset])
}

/**
 * Keep explicitly started requests alive while their card is hidden, and cancel them when the PDF leaves.
 * @param translation - current paper callbacks and PDF-version identity.
 * @returns progress snapshots plus explicit start and cancellation commands; pending duplicate starts share one request.
 */
export function useTranslationRequests(translation: PdfTranslation | undefined): {
  readonly requests: readonly TranslationRequestState[]
  readonly start: (selection: PdfSelection) => void
  readonly cancel: (key: string) => void
} {
  const sourceKey = translation?.history?.key
  const available = translation !== undefined
  const owner = useMemo(() => new Map<string, Operation>(), [sourceKey, available])
  const active = useRef<Map<string, Operation>>()
  const callbacks = useRef(translation)
  active.current = owner
  callbacks.current = translation
  const [snapshot, setSnapshot] = useState<{
    owner: Map<string, Operation>
    requests: readonly TranslationRequestState[]
  }>({ owner, requests: [] })
  useEffect(() => {
    active.current = owner
    return () => {
      if (active.current === owner) active.current = undefined
      for (const operation of owner.values()) operation.lifetime.abort()
      owner.clear()
    }
  }, [owner])
  const publish = (): void => {
    if (active.current === owner) setSnapshot({ owner, requests: [...owner.values()].map(operation => operation.state) })
  }
  return {
    requests: snapshot.owner === owner ? snapshot.requests : [],
    start: (selection) => {
      const execute = callbacks.current?.translate
      if (active.current !== owner || execute === undefined) return
      const key = translationSelectionKey(selection)
      if (owner.get(key)?.state.kind === 'loading') return
      const lifetime = new AbortController()
      const operation: Operation = { lifetime, state: { key, selection, kind: 'loading' } }
      owner.set(key, operation)
      publish()
      void (async () => {
        try {
          if (selection.start === undefined || selection.end === undefined) {
            operation.state = { key, selection, kind: 'failed', reason: 'selection' }
          } else {
            const value = await execute({ text: selection.text, start: selection.start, end: selection.end, rects: selection.rects },
              lifetime.signal)
            operation.state = { key, selection, kind: 'ready', value }
          }
        } catch (error: unknown) {
          operation.state = { key, selection, kind: 'failed', reason: failureReason(error) }
        }
        if (!lifetime.signal.aborted && owner.get(key) === operation) publish()
      })()
    },
    cancel: (key) => {
      const operation = owner.get(key)
      if (operation === undefined) return
      operation.lifetime.abort()
      owner.delete(key)
      publish()
    },
  }
}
