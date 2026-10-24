/** Located paper excerpts and structured vocabulary explanations shared with the reader. */
import type { LlmCallConfig, RequestUserInput } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResearchPaperId } from './research-types.ts'

/** A UTF-16 position inside a nonempty PDF.js text item, independent of reader zoom. */
export interface ResearchTextPosition {
  readonly page: number
  readonly item: number
  readonly offset: number
}

/** Explicit reader selection; surrounding sentences are resolved from the managed original. */
export interface ResearchTranslationRequest {
  readonly sessionId?: SessionId
  readonly paperId: ResearchPaperId
  readonly text: string
  readonly start: ResearchTextPosition
  readonly end: ResearchTextPosition
}

/** Original sentences around a position-confirmed selection. */
export interface ResearchTranslationContext {
  readonly selected: string
  readonly sentence: string
  /** UTF-16 start of the selected occurrence inside sentence. */
  readonly selectionStart: number
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly startPage: number
  readonly endPage: number
  readonly limited: boolean
}

/** Model-produced explanation; phonetics are supplied separately by a dictionary. */
export interface ResearchTranslationExplanation {
  readonly kind: 'word' | 'phrase' | 'sentence'
  readonly lemma: string
  readonly partOfSpeech: string
  readonly meanings: readonly string[]
  readonly contextualMeaning: string
  readonly explanation: string
  readonly translation: string
}

/** Confirmed phonetics from a dictionary, or an explicit unavailable outcome. */
export interface ResearchPronunciation {
  readonly status: 'ready' | 'unavailable'
  readonly phonetics: readonly string[]
  readonly sourceUrl: string
}

/** Complete, reusable result owned by one PDF version and occurrence. */
export interface ResearchTranslation {
  readonly key: string
  readonly paperId: ResearchPaperId
  readonly sourceSha256: string
  readonly context: ResearchTranslationContext
  readonly result: ResearchTranslationExplanation
  readonly pronunciation: ResearchPronunciation
}

/** Exact auxiliary inference input, logged before dispatch without adding a conversation turn. */
export interface ResearchTranslationRequestRecord {
  readonly paperId: ResearchPaperId
  readonly key: string
  readonly modelRequest: {
    readonly config: LlmCallConfig
    readonly system: string
    readonly messages: readonly RequestUserInput[]
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Retains the exact independent translation request before model dispatch.
     * @param data - owning paper, occurrence key and complete model input.
     */
    'research/translation-request': ResearchTranslationRequestRecord
    /**
     * Retains a validated explanation before publishing it to the reader.
     * @param data - preceding request sequence and complete located translation.
     */
    'research/translation-result': { readonly requestSeq: import('@deepseek-ai/dsh-session/types').SessionSeq; readonly translation: ResearchTranslation }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Translation failures retain the original PDF, selection and notebooks. */
    'research/translation-failed': {
      readonly reason: 'unavailable' | 'selection' | 'no-text' | 'limit' | 'timeout' | 'model' | 'invalid-response' | 'source-changed' | 'storage'
    }
  }
}
