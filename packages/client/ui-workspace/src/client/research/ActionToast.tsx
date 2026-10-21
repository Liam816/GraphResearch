/** Paper-operation notices hosted outside the research directory and reading panels. */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchKey } from './locales.ts'

/** One transient paper operation outcome. */
export interface ResearchNotice { readonly seq: number; readonly message: ResearchKey; readonly success: boolean }
/** Research notice source and dismissal command. */
export interface ResearchNoticeInjected {
  hooks: { notice: HostObservable<ResearchNotice | null> }
  dismiss: () => void
}

/** @param props - root-owned operation outcome and locale. @returns a notice that survives directory unmounts. */
export function ResearchActionToast({ useNotice, dismiss, t }: PropsRuntime<'shell.overlay'> & PropsLocale<'research'>
  & PropsHooks<ResearchNoticeInjected['hooks']> & Omit<ResearchNoticeInjected, 'hooks'>) {
  const notice = useNotice(value => value)
  return notice === null ? null : <Toast key={notice.seq} text={t(notice.message)} {...notice.success ? { tone: 'success' } : {}}
    icon={notice.success ? undefined : <IconWarningOutlineRegular />} holdMs={notice.success ? 3000 : 6000} onDone={dismiss} />
}
