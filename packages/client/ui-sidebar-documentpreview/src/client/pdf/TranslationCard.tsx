/** Explicit, cancellable vocabulary explanation with original context and paper-owned actions. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchTranslation } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PdfSelection, PdfTranslation } from './highlights.ts'
import type {} from './locales.ts'
import css from './HighlightControls.module.css'

function translationFailure(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'research/translation-failed'
    || !('details' in error) || typeof error.details !== 'object' || error.details === null || !('reason' in error.details)) return
  return typeof error.details.reason === 'string' ? error.details.reason : undefined
}

/**
 * Request a single explicitly chosen passage and discard responses after selection changes or dismissal.
 * @param props - immutable selection, paper callbacks and PDF locale.
 * @returns a selectable result card with retained errors and explicit retries.
 */
export function TranslationCard({ selection, translation, t }: PropsLocale<'sidebarPdf'> & {
  readonly selection: PdfSelection
  readonly translation: PdfTranslation
}): ReactNode {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'failed'; reason: string | undefined } | { kind: 'ready'; value: ResearchTranslation }>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const callbacks = useRef(translation)
  callbacks.current = translation
  useEffect(() => {
    const lifetime = new AbortController()
    setState({ kind: 'loading' })
    if (selection.start === undefined || selection.end === undefined) { setState({ kind: 'failed', reason: 'selection' }); return }
    void callbacks.current.translate({ text: selection.text, start: selection.start, end: selection.end }, lifetime.signal)
      .then((value) => { if (!lifetime.signal.aborted) setState({ kind: 'ready', value }) }, (error: unknown) => {
        if (!lifetime.signal.aborted) setState({ kind: 'failed', reason: translationFailure(error) })
      })
    return () => { lifetime.abort() }
  }, [selection, attempt])
  return <div className={css.translation} role="region" aria-label={t('translationTitle')} aria-busy={state.kind === 'loading'}>
    {state.kind === 'loading' ? <div className={css.translationLoading} role="status" aria-label={t('translationLoading')}><StateDot state="ongoing" size={20} /></div>
      : state.kind === 'failed' ? <div className={css.translationError} role="alert">
        <p>{t(state.reason === 'unavailable' ? 'translationUnavailable' : state.reason === 'selection' ? 'translationSelectionFailed'
          : state.reason === 'no-text' ? 'translationNoText' : state.reason === 'timeout' ? 'translationTimeout'
            : state.reason === 'source-changed' ? 'translationSourceChanged' : state.reason === 'limit' ? 'translationLimit' : 'translationFailed')}</p>
        <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
      </div> : <TranslationResult value={state.value} translation={translation} t={t} />}
  </div>
}

function TranslationResult({ value, translation, t }: PropsLocale<'sidebarPdf'> & {
  readonly value: ResearchTranslation
  readonly translation: PdfTranslation
}): ReactNode {
  const { result, context, pronunciation } = value
  const [saving, setSaving] = useState(false), [saved, setSaved] = useState(false)
  const [actionFailed, setActionFailed] = useState<'save' | 'ask' | 'speak'>()
  const [asking, setAsking] = useState(false), [inserted, setInserted] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const voice = useRef<SpeechSynthesisUtterance>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (voice.current !== undefined) { voice.current.onend = null; voice.current.onerror = null; window.speechSynthesis.cancel() }
    }
  }, [])
  const speak = (): void => {
    setActionFailed(undefined)
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { setActionFailed('speak'); return }
    if (speaking) { window.speechSynthesis.cancel(); voice.current = undefined; setSpeaking(false); return }
    const utterance = new SpeechSynthesisUtterance(result.kind === 'sentence' ? context.selected : result.lemma)
    utterance.lang = 'en-US'
    utterance.onend = () => { voice.current = undefined; if (mounted.current) setSpeaking(false) }
    utterance.onerror = () => { voice.current = undefined; if (mounted.current) { setSpeaking(false); setActionFailed('speak') } }
    voice.current = utterance; setSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }
  const act = async (action: 'save' | 'ask'): Promise<void> => {
    setActionFailed(undefined)
    if (action === 'save') setSaving(true); else setAsking(true)
    try {
      if (action === 'save') await translation.save(value); else await translation.ask(value)
      if (mounted.current) { if (action === 'save') setSaved(true); else setInserted(true) }
    } catch (_error: unknown) { if (mounted.current) setActionFailed(action) }
    finally { if (mounted.current) { setSaving(false); setAsking(false) } }
  }
  return <>
    <header className={css.translationHeading}><strong>{result.lemma}</strong><span>{result.partOfSpeech}</span>
      <Button size="sm" variant="ghost" onClick={speak}>{t(speaking ? 'translationStopSpeaking' : 'translationSpeak')}</Button>
    </header>
    {result.kind === 'word' && <div className={css.phonetics}>
      {pronunciation.status === 'ready' ? <>{pronunciation.phonetics.join(' · ')} <a href={pronunciation.sourceUrl} target="_blank" rel="noreferrer">{t('translationDictionary')}</a></>
        : <span>{t('translationPhoneticsUnavailable')}</span>}
      <span>{t('translationSpeechHint')}</span>
    </div>}
    <section><h3>{t(result.kind === 'sentence' ? 'translationKeyMeaning' : 'translationMeanings')}</h3>
      <ul>{result.meanings.map((meaning, index) => <li key={index}>{meaning}</li>)}</ul>
    </section>
    <section><h3>{t('translationContextual')}</h3><p>{result.contextualMeaning}</p><p className={css.translationDetail}>{result.explanation}</p></section>
    <section><h3>{t('translationSentence')}</h3><blockquote>
      <SelectedSentence text={context.sentence} selected={context.selected} start={context.selectionStart} />
    </blockquote><p>{result.translation}</p></section>
    <details className={css.translationContext}><summary>{t('translationContext', { page: context.startPage })}</summary>
      {context.before.map((sentence, index) => <p key={`before-${index}`}>{sentence}</p>)}
      <p><SelectedSentence text={context.sentence} selected={context.selected} start={context.selectionStart} /></p>
      {context.after.map((sentence, index) => <p key={`after-${index}`}>{sentence}</p>)}
      {context.limited && <p className={css.translationDetail}>{t('translationContextLimited')}</p>}
    </details>
    <footer className={css.translationActions}>
      <Button size="sm" disabled={saving || saved} onClick={() => { void act('save') }}>{t(saving ? 'translationSaving' : saved ? 'translationSaved' : 'translationSave')}</Button>
      <Button size="sm" disabled={asking} onClick={() => { void act('ask') }}>{t('translationAsk')}</Button>
    </footer>
    {inserted && <p className={css.translationDetail} role="status">{t('translationInserted')}</p>}
    {actionFailed !== undefined && <p className={css.translationError} role="alert">{t(actionFailed === 'save' ? 'translationSaveFailed' : actionFailed === 'ask' ? 'translationAskFailed' : 'translationSpeakFailed')}</p>}
  </>
}

function SelectedSentence({ text, selected, start }: {
  readonly text: string
  readonly selected: string
  readonly start: number
}): ReactNode {
  return <>{text.slice(0, start)}<mark>{selected}</mark>{text.slice(start + selected.length)}</>
}
