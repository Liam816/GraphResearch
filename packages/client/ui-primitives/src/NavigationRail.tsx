/** Fixed-pitch navigation marks with virtual scrolling and pointer/focus previews. */
import {
  forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ForwardedRef,
} from 'react'
import { defaultRangeExtractor, elementScroll, observeElementOffset, useVirtualizer, type Range } from '@tanstack/react-virtual'
import css from './NavigationRail.module.css'

/** One navigation destination; copy and domain identifiers belong to the caller. */
export interface NavigationRailItem {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly description: string
  readonly muted?: boolean
}

/** Shared navigation state and localized copy, independent of any domain. */
export interface NavigationRailProps {
  readonly items: readonly NavigationRailItem[]
  readonly activeId: string | null
  readonly busyId?: string | null
  readonly label: string
  readonly side?: 'left' | 'right'
  readonly className?: string | undefined
  readonly onNavigate: (item: NavigationRailItem) => void
}

/** Separate destination activation and scrolling; unknown identities are ignored. */
export interface NavigationRailHandle {
  /** @param id - destination to activate through the callback. */
  activate(id: string): void
  /** @param id - destination to center without activating it. */
  scrollTo(id: string): void
}

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const MARK_SPACING_PX = 10
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24

function preferredScrollBehavior(): 'auto' | 'smooth' {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
}

interface NavigationMarkProps extends Pick<NavigationRailProps, 'onNavigate'> {
  readonly item: NavigationRailItem
  readonly index: number
  readonly active: boolean
  readonly busy: boolean
  readonly previewId: string | undefined
  readonly registerElement: (element: HTMLButtonElement | null) => void
  readonly onPreview: (id: string | null) => void
  readonly onFocusChange: (id: string | null) => void
}

const NavigationMark = memo(function NavigationMark({
  item, index, active, busy, previewId, registerElement, onNavigate, onPreview, onFocusChange,
}: NavigationMarkProps) {
  const classes = [css.mark]
  if (item.muted === true) classes.push(css.markMuted)
  if (active) classes.push(css.markActive)
  else if (previewId !== undefined) classes.push(css.markPreview)
  if (busy) classes.push(css.markBusy)
  return (
    <button
      ref={registerElement}
      data-index={index}
      type="button"
      className={classes.join(' ')}
      aria-label={item.label}
      aria-current={active ? 'true' : undefined}
      aria-busy={busy ? 'true' : undefined}
      aria-describedby={previewId}
      onPointerMove={() => { onPreview(item.id) }}
      onClick={() => { onNavigate(item) }}
      onFocus={() => { onFocusChange(item.id) }}
      onBlur={() => { onFocusChange(null) }}
    />
  )
})

function NavigationRailControl(
  { items, activeId, busyId = null, onNavigate, label, side = 'right', className }: NavigationRailProps,
  ref: ForwardedRef<NavigationRailHandle>,
) {
  const [previewItem, setPreviewItem] = useState<string | null>(null)
  const [focusedItem, setFocusedItem] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const initialization = useRef({
    placed: false,
    index: 0,
    follow: null as { index: number; count: number; height: number } | null,
    publishOffset: null as ((offset: number, scrolling: boolean) => void) | null,
  })
  /** While the pointer works the rail, follow must not move it under the hand. */
  const pointerInsideRef = useRef(false)
  const previewId = useId()
  const itemIndexes = useMemo(() => {
    const indexes = new Map<string, number>()
    items.forEach((item, index) => { indexes.set(item.id, index) })
    return indexes
  }, [items])
  const activeIndex = activeId === null ? undefined : itemIndexes.get(activeId)
  useLayoutEffect(() => { initialization.current.index = activeIndex ?? 0 }, [activeIndex])
  const focusedIndex = focusedItem === null ? undefined : itemIndexes.get(focusedItem)
  const previewIndex = previewItem === null ? undefined : itemIndexes.get(previewItem)
  const onFocusChange = useCallback((id: string | null) => {
    setFocusedItem(id)
    setPreviewItem(id)
  }, [])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: items.length,
    enabled: items.length > 0,
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
    useScrollendEvent: true,
    getScrollElement: useCallback(() => scrollerRef.current, []),
    getItemKey: useCallback((index: number) => items[index]?.id ?? index, [items]),
    estimateSize: () => MARK_SPACING_PX,
    measureElement: () => MARK_SPACING_PX,
    initialRect: { width: 0, height: 0 },
    initialOffset: 0,
    scrollToFn: (offset, options, instance) => {
      if (initialization.current.placed) elementScroll(offset, options, instance)
    },
    observeElementOffset: (instance, notify) => {
      initialization.current.publishOffset = notify
      const dispose = observeElementOffset(instance, notify)
      return () => {
        dispose?.()
        initialization.current.placed = false
        initialization.current.follow = null
        initialization.current.publishOffset = null
      }
    },
    observeElementRect: (instance, notify) => {
      const element = instance.scrollElement
      const Observer = instance.targetWindow?.ResizeObserver
      if (element === null || Observer === undefined) return
      const observer = new Observer(([entry]) => {
        if (entry === undefined) return
        const box = entry.borderBoxSize[0]
        const rect = {
          width: Math.round(box?.inlineSize ?? entry.contentRect.width),
          height: Math.round(box?.blockSize ?? entry.contentRect.height),
        }
        const initial = initialization.current
        if (!initial.placed && rect.height > 0) {
          const max = Math.max(0, instance.getTotalSize() - rect.height)
          const center = initial.index * MARK_SPACING_PX + RAIL_INSET_PX
          const target = Math.max(0, Math.min(max, center - rect.height / 2))
          initial.placed = true
          initial.follow = { index: initial.index, count: instance.options.count, height: rect.height }
          element.scrollTop = target
          initial.publishOffset?.(target, false)
        }
        notify(rect)
      })
      observer.observe(element, { box: 'border-box' })
      return () => { observer.disconnect() }
    },
    paddingStart: RAIL_INSET_PX - MARK_SPACING_PX / 2,
    paddingEnd: RAIL_INSET_PX - MARK_SPACING_PX / 2,
    scrollPaddingStart: FADE_PX,
    scrollPaddingEnd: FADE_PX,
    overscan: 3,
    rangeExtractor: useCallback((range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedIndex !== undefined) {
        const last = Math.min(range.count - 1, focusedIndex + 1)
        for (let index = Math.max(0, focusedIndex - 1); index <= last; index++) {
          if (!indexes.includes(index)) indexes.push(index)
        }
        indexes.sort((left, right) => left - right)
      }
      return indexes
    }, [focusedIndex]),
  })
  const scrollTop = virtualizer.scrollOffset ?? 0
  const viewHeight = virtualizer.scrollRect?.height ?? 0
  const virtualItems = virtualizer.getVirtualItems()

  const scrollToIndex = useCallback((
    index: number, reveal: 'if-needed' | 'always', behavior: 'auto' | 'smooth' | 'instant' = preferredScrollBehavior(),
  ): void => {
    const item = virtualizer.measurementsCache[index]
    const height = virtualizer.scrollRect?.height ?? 0
    if (item === undefined || height <= 0) return
    const current = virtualizer.scrollOffset ?? 0
    const center = item.start + item.size / 2
    if (reveal === 'if-needed') {
      const { scrollPaddingStart, scrollPaddingEnd } = virtualizer.options
      if (center >= current + scrollPaddingStart && center <= current + height - scrollPaddingEnd) return
    }
    const target = center - height / 2
    const max = Math.max(0, virtualizer.getTotalSize() - height)
    const delta = Math.max(0, Math.min(max, target)) - current
    if (delta !== 0) virtualizer.scrollBy(delta, { behavior })
  }, [virtualizer])

  useImperativeHandle(ref, (): NavigationRailHandle => ({
    activate(id) {
      const index = itemIndexes.get(id)
      const item = index === undefined ? undefined : items[index]
      if (item !== undefined) onNavigate(item)
    },
    scrollTo(id) {
      const index = itemIndexes.get(id)
      if (index !== undefined) scrollToIndex(index, 'always')
    },
  }), [items, itemIndexes, onNavigate, scrollToIndex])

  useEffect(() => {
    if (viewHeight <= 0) {
      initialization.current.follow = null
      return
    }
    if (activeIndex === undefined || pointerInsideRef.current) return
    const previous = initialization.current.follow
    if (previous?.index === activeIndex && previous.count === items.length && previous.height === viewHeight) return
    initialization.current.follow = { index: activeIndex, count: items.length, height: viewHeight }
    const behavior = previous?.count === items.length && previous.height === viewHeight
      ? preferredScrollBehavior()
      : 'instant'
    scrollToIndex(activeIndex, 'if-needed', behavior)
  }, [activeIndex, items.length, viewHeight, scrollToIndex])

  if (items.length === 0) return null
  const preview = previewIndex === undefined ? undefined : items[previewIndex]
  const previewPosition = virtualItems.find(item => item.index === previewIndex)
  const fadeClasses = [css.scroller]
  if (scrollTop > 1) fadeClasses.push(css.fadeTop)
  if (scrollTop < virtualizer.getTotalSize() - viewHeight - 1) fadeClasses.push(css.fadeBottom)
  return (
    <nav
      className={[css.frame, className].filter(Boolean).join(' ')}
      data-side={side}
      aria-label={label}
      onKeyDown={(event) => { if (event.key === 'Escape') setPreviewItem(null) }}
      onPointerEnter={() => { pointerInsideRef.current = true }}
      onPointerLeave={() => {
        pointerInsideRef.current = false
        setPreviewItem(null)
      }}
    >
      <div ref={scrollerRef} className={fadeClasses.join(' ')}>
        <div ref={virtualizer.containerRef} className={css.marks}>
          {virtualItems.map(({ index, key }) => {
            const item = items[index]
            if (item === undefined) return null
            return (
              <NavigationMark
                key={key}
                item={item}
                index={index}
                active={item.id === activeId}
                busy={item.id === busyId}
                previewId={item.id === previewItem ? previewId : undefined}
                registerElement={virtualizer.measureElement}
                onNavigate={onNavigate}
                onPreview={setPreviewItem}
                onFocusChange={onFocusChange}
              />
            )
          })}
        </div>
      </div>
      {preview !== undefined && previewPosition !== undefined && (
        <div
          id={previewId}
          role="tooltip"
          className={css.preview}
          style={{
            '--navigation-preview-center': `${String(previewPosition.start + previewPosition.size / 2 - scrollTop)}px`,
          } as CSSProperties}
        >
          <div className={css.previewPrompt}>
            {preview.title}
          </div>
          {preview.description !== '' && <div className={css.previewResponse}>{preview.description}</div>}
        </div>
      )}
    </nav>
  )
}

/**
 * Virtual short-line navigation with fixed spacing and bounded preview cards.
 * Owners supply placement, visibility, copy and navigation; pointer movement and
 * keyboard focus select previews without activating a destination. The active
 * destination follows only outside the visible band while the pointer is elsewhere.
 */
export const NavigationRail = memo(forwardRef(NavigationRailControl))
