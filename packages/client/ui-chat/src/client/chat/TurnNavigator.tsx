/** Chat-specific destinations and copy for the shared short-line navigator. */
import { forwardRef, memo, useImperativeHandle, useMemo, useRef, type ForwardedRef } from 'react'
import { NavigationRail, type NavigationRailHandle } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
import css from './TurnNavigator.module.css'

interface TurnNavigatorProps {
  readonly items: readonly TurnRailItem[]
  readonly activeTurn: number | null
  /** Turn whose jump is still loading history; its mark pulses. */
  readonly busyTurn: number | null
  readonly onNavigate: (item: TurnRailItem) => void
  readonly t: ChatViewSlotProps['t']
}

/** Imperative controls for known turns; unknown turn numbers are ignored. */
export interface TurnNavigatorHandle {
  /** @param turn - turn to activate through the navigation callback. */
  activateTurn(turn: number): void
  /** @param turn - turn to center in the rail without navigating the transcript. */
  scrollToTurn(turn: number): void
}

function TurnNavigatorRail({ items, activeTurn, busyTurn, onNavigate, t }: TurnNavigatorProps, ref: ForwardedRef<TurnNavigatorHandle>) {
  const rail = useRef<NavigationRailHandle>(null)
  const byId = useMemo(() => new Map(items.map(item => [String(item.turn), item])), [items])
  const marks = useMemo(() => items.map(item => ({
    id: String(item.turn), title: item.prompt || t('chat.turnNavigation.turn', { turn: item.turn }), description: item.response,
    label: t(item.anchor.kind === 'loaded' ? 'chat.turnNavigation.jump' : 'chat.turnNavigation.jumpLoad', { turn: item.turn }),
    muted: item.anchor.kind === 'unloaded',
  })), [items, t])
  useImperativeHandle(ref, () => ({
    activateTurn(turn) { const item = byId.get(String(turn)); if (item !== undefined) onNavigate(item) },
    scrollToTurn(turn) { rail.current?.scrollTo(String(turn)) },
  }), [byId, onNavigate])
  if (items.length < 2) return null
  return <div className={css.slot} data-chat-turn-navigation=""><NavigationRail ref={rail} className={css.frame}
    items={marks} activeId={activeTurn === null ? null : String(activeTurn)} busyId={busyTurn === null ? null : String(busyTurn)}
    label={t('chat.turnNavigation.label')} onNavigate={(item) => {
      const target = byId.get(item.id)
      if (target !== undefined) onNavigate(target)
    }} /></div>
}

/** Existing Turn navigation keeps its transcript destinations and placement. */
export const TurnNavigator = memo(forwardRef(TurnNavigatorRail))
