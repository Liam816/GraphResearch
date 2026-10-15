/** Per-Session Chat view store. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ChatStoreState, TurnProcessViewEntry } from './contract/store.ts'
import type { TurnProcessSpec } from './contract/turn-process.ts'
import type { ChatScrollPosition } from './contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

type ChatReadingState = { positions: Record<SessionId, ChatScrollPosition> }
type ChatReadingActions = { save: (draft: ChatReadingState, id: SessionId, position: ChatScrollPosition | null) => void }

type ChatActions = {
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    answerStep: number,
    open: boolean,
  ) => void
}

/**
 * Resolve the manual disclosure choice for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

/**
 * Whether a foldable Turn's process is open: the reader's choice for the current answer generation
 * wins; otherwise the latest completed Turn stays open until the next input, and older Turns fold.
 * @param state - Chat store snapshot.
 * @param spec - the Turn's process specification.
 * @param defaultOpen - whether this Turn is exempt from automatic folding.
 * @returns the effective open state.
 */
export function turnProcessOpen(
  state: Readonly<ChatStoreState>,
  spec: Pick<TurnProcessSpec, 'turn' | 'answerStep'>,
  defaultOpen: boolean,
): boolean {
  const stored = storedTurnProcessEntry(state, spec.turn)
  if (stored === undefined || stored.answerStep !== (spec.answerStep ?? 0)) return defaultOpen
  return stored.collapsed !== true
}

/**
 * Create the Chat view store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    persist: 'dsh.chat.view.v1',
    init: (): ChatStoreState => ({ turnProcesses: [] }),
    actions: {
      setTurnProcessOpen: (draft, turn, answerStep, open) => {
        const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
        const next = (open ? { turn, answerStep } : { turn, answerStep, collapsed: true }) satisfies TurnProcessViewEntry
        if (index < 0) draft.turnProcesses.push(next)
        else draft.turnProcesses[index] = next
      },
    },
  })
}

/**
 * Retain Session-specific semantic reading anchors through navigation and page reloads.
 * @returns a root store declaration; following the tail removes only that Session's anchor.
 */
export function createChatReadingStore(): EngineStoreHandle<ChatReadingState, ChatReadingActions> {
  return defineStore({
    persist: 'dsh.chat.reading.v1',
    init: () => ({ positions: {} as Record<SessionId, ChatScrollPosition> }),
    actions: {
      save: (draft, id: SessionId, position: ChatScrollPosition | null) => {
        if (position === null) draft.positions = Object.fromEntries(Object.entries(draft.positions).filter(([key]) => key !== id))
        else draft.positions[id] = position
      },
    },
  })
}
