// @vitest-environment jsdom
/** Session-specific reading memory and checkpoints before the normal scroll sampling interval. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createChatReadingStore } from '../src/client/stores.ts'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'
import type { ChatScrollPosition } from '../src/client/contract/slots.ts'

beforeEach(() => { localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

it('restores independent Session anchors after reload and clears only the Session following the tail', () => {
  const store = createChatReadingStore().create()
  const a = SessionId('A'), b = SessionId('B')
  const position = { anchorKey: 'message', anchorTop: 60, scrollTop: 800, seq: SessionSeq(10), turn: 2 }
  store.actions.save(a, position)
  store.actions.save(b, { ...position, scrollTop: 1400 })
  const reopened = createChatReadingStore().create()
  expect(reopened.getSnapshot().positions[a]).toEqual(position)
  expect(reopened.getSnapshot().positions[b]?.scrollTop).toBe(1400)
  reopened.actions.save(a, null)
  expect(createChatReadingStore().create().getSnapshot().positions).toEqual({ B: { ...position, scrollTop: 1400 } })
})

it('captures an unsampled semantic row before detach and ignores a hidden viewport on page unload', () => {
  const node = document.createElement('div'), row = document.createElement('div')
  row.textContent = 'Visible message'
  row.dataset.chatAnchorKey = 'message'; row.dataset.chatFlowKey = 'message'; row.dataset.chatAnchorSeq = '10'; row.dataset.chatTurn = '2'
  node.append(row); document.body.append(node)
  Object.defineProperties(node, { clientHeight: { value: 300 }, scrollHeight: { value: 1400 } })
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 600, 300))
  vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 180 - node.scrollTop, 600, 80))
  const viewport = new ChatViewport()
  viewport.attach(node, node)
  let saved: ChatScrollPosition | null = null
  const reading = new ChatReading(viewport, { read: () => saved, save: (value) => { saved = value } },
    { initialized: true, followingTail: false, activeTurn: 2 }, vi.fn(), new ScrollFollow(false, 25))
  viewport.connect({ checkpoint: (onlyPending) => { reading.checkpoint(onlyPending) }, scroll: reading.onScroll,
    scrollEnd: reading.onScrollEnd, resize: () => {}, interact: () => {} })
  try {
    node.scrollTop = 120; node.dispatchEvent(new Event('scroll'))
    expect(saved).toBeNull()
    viewport.detach()
    expect(saved).toEqual({ anchorKey: 'message', anchorTop: 60, scrollTop: 120, seq: 10, turn: 2 })
    viewport.attach(node, node)
    viewport.connect({ checkpoint: (onlyPending) => { reading.checkpoint(onlyPending) }, scroll: reading.onScroll,
      scrollEnd: reading.onScrollEnd, resize: () => {}, interact: () => {} })
    node.scrollTop = 140; node.dispatchEvent(new Event('scroll'))
    reading.checkpoint()
    expect(saved).toMatchObject({ scrollTop: 140 })
    row.dataset.chatAnchorSeq = '10.5'
    node.scrollTop = 150; node.dispatchEvent(new Event('scroll'))
    reading.checkpoint()
    expect(saved).toMatchObject({ scrollTop: 150, seq: 10 })
    node.scrollTop = 900
    viewport.detach()
    expect(saved).toMatchObject({ scrollTop: 150 })
    viewport.attach(node, node)
    viewport.connect({ checkpoint: (onlyPending) => { reading.checkpoint(onlyPending) }, scroll: reading.onScroll,
      scrollEnd: reading.onScrollEnd, resize: () => {}, interact: () => {} })
    node.scrollTop = 160; node.dispatchEvent(new Event('scroll'))
    const collapse = document.createElement('button'); document.body.append(collapse)
    collapse.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(saved).toMatchObject({ scrollTop: 160 })
    node.hidden = true; node.scrollTop = 0; window.dispatchEvent(new Event('pagehide'))
    expect(saved).toMatchObject({ scrollTop: 160 })
  } finally { viewport.detach(); reading.dispose() }
  expect(vi.getTimerCount()).toBe(0)
})
