/** Independent PDF factory, using the document preview package's existing renderer and file API. */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PdfAnnotations, PdfTranslation } from './highlights.ts'
import type { PdfView, PdfReadingPosition } from './store.ts'
import type { ZoomPreference } from '../zoom/types.ts'
import { ZoomViewport, zoomSurfaceClass, fitWidthZoom } from '../zoom/ZoomViewport.tsx'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type {} from './locales.ts'
import css from './EmbeddedPdf.module.css'

const Reader = lazy(async () => ({ default: (await import('./pdf.tsx')).PdfReader }))
const INITIAL_VIEW: PdfView = { page: 1 }

/** @returns per-file, Session-scoped PDF page and zoom preferences. */
export function createEmbeddedPdfStore() {
  return defineStore({
    persist: 'dsh.research.pdf.v1',
    init: () => ({ byPath: {} as Record<string, PdfView> }),
    actions: {
      adopt: (draft, key: string, path: string) => { draft.byPath[key] ??= draft.byPath[path] ?? { page: 1 } },
      page: (draft, path: string, page: number) => { draft.byPath[path] = { ...draft.byPath[path], page } },
      zoom: (draft, path: string, zoom: ZoomPreference) => {
        draft.byPath[path] = { ...draft.byPath[path], page: draft.byPath[path]?.page ?? 1, zoom }
      },
      position: (draft, path: string, position: PdfReadingPosition) => {
        draft.byPath[path] = { ...draft.byPath[path], page: position.page, position }
      },
    },
  })
}

/** File reads cross the validated generated Remote API. */
export interface EmbeddedPdfInjected {
  read: (path: string, signal: AbortSignal) => Promise<RemoteResult<Uint8Array<ArrayBuffer>>>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Selectable original PDF outside the right sidebar's tab system. */
    'document.pdf': {
      scope: 'session'
      props: {
        readonly path: string
        readonly viewKey?: string
        readonly annotations?: PdfAnnotations
        readonly translation?: PdfTranslation
      }
      store: ReturnType<typeof createEmbeddedPdfStore>
      locale: 'sidebarPdf'
      inject: EmbeddedPdfInjected
    }
  }
}

type ReadState = { readonly path: string; readonly signal: AbortSignal } & (
  | { readonly kind: 'loaded'; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'failed'; readonly message: string }
)

function EmbeddedPdf(props: FactoryComponentPropsOf<'document.pdf'>) {
  const { path, read, t, actions } = props
  const key = props.viewKey ?? path
  const view = props.useStore(value => value.byPath[key] ?? value.byPath[path] ?? INITIAL_VIEW)
  useLayoutEffect(() => { actions.adopt(key, path) }, [actions, key, path])
  const [state, setState] = useState<ReadState>()
  const [attempt, setAttempt] = useState(0)
  const onPage = useCallback((page: number) => { actions.page(key, page) }, [actions, key])
  const onZoom = useCallback((zoom: ZoomPreference) => { actions.zoom(key, zoom) }, [actions, key])
  const onPosition = useCallback((position: PdfReadingPosition) => { actions.position(key, position) }, [actions, key])
  const scrollportRef = useCallback(() => {}, [])
  useEffect(() => {
    const lifetime = new AbortController()
    const signal = lifetime.signal
    void read(path, signal).then((result) => {
      if (signal.aborted) return
      setState(result.ok ? { kind: 'loaded', path, signal, data: result.value }
        : { kind: 'failed', path, signal, message: result.error.message })
    }).catch((error: unknown) => {
      if (!signal.aborted) setState({ kind: 'failed', path, signal, message: error instanceof Error ? error.message : String(error) })
    })
    return () => { lifetime.abort() }
  }, [path, read, attempt])
  const loading = <LoadingIndicator label={t('loading')} />
  if (state?.path !== path || state.signal.aborted) return loading
  if (state.kind === 'failed') return <div className={css.status} role="alert"><p>{t('failed', { message: state.message })}</p>
    <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>
  return <div className={css.root}><Suspense fallback={loading}>
    <Reader annotations={props.annotations} translation={props.translation} data={state.data} view={view} signal={state.signal}
      onPage={onPage} onZoom={onZoom} reading={{ save: onPosition, fitWidthZoom }} t={t}
      ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass} scrollportRef={scrollportRef} loading={loading} />
  </Suspense></div>
}

/** @param ctx - owning document-preview plugin Context. */
export function registerEmbeddedPdf(ctx: Context): void {
  ctx.effect(() => ctx.slots.registerFactory({
    name: 'document.pdf', scope: 'session', locale: 'sidebarPdf', store: createEmbeddedPdfStore(),
    inject: (sessionId: SessionId): EmbeddedPdfInjected => ({ read: async (path, signal) => {
      const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
      return result.ok ? { ok: true, value: result.value.data } : result
    } }),
  }, EmbeddedPdf))
}
