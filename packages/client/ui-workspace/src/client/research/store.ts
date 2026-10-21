/** Research navigation and paper-local panel preferences; catalog data remains Host-owned. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { ResearchNoteKind, ResearchPaperId, ResearchTopicId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Independently collapsible paper panels. */
export type ResearchPanel = 'agent' | 'pdf' | 'notes'
/** Default reading order, also used by preferences saved before panel sorting. */
export const DEFAULT_PANEL_ORDER: readonly ResearchPanel[] = ['agent', 'pdf', 'notes']
/** Placement relative to a neighboring panel. */
export type PanelPlacement = 'before' | 'after'
/** Draft retains the revision it started from until a durable save succeeds. */
export interface NoteDraft { text: string; revision: number }
/** One notebook surface's local scroll offsets. */
export interface NoteScrollPosition { top: number; left: number }
/** Editor caret and selection are restored without taking keyboard focus. */
export interface NoteEditorPosition extends NoteScrollPosition {
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
}
/** Independent viewing mode and positions for AI and learning notebooks. */
export interface NoteReadingView {
  mode?: 'edit' | 'preview'
  latest?: boolean
  editor?: NoteEditorPosition
  preview?: NoteScrollPosition
}
/** Independent directory proportions for stacked and side-by-side file layouts. */
export type FileSplitAxis = 'rows' | 'columns'
/** Default directory proportions before a paper has saved split preferences. */
export const DEFAULT_FILE_SPLIT: Record<FileSplitAxis, number> = { rows: 35, columns: 34 }
/** Inclusive directory percentage limits for both file layout axes. */
export const FILE_SPLIT_LIMITS = { min: 5, max: 95 } as const
/** File viewing preferences and drafts survive paper switches without caching disk contents. */
export interface PaperFileView {
  selected?: string
  split?: Partial<Record<FileSplitAxis, number>>
  expanded: Record<string, boolean>
  drafts: Record<string, { text: string; version: string }>
  reading: Record<string, NoteReadingView>
}
/** Paper-local layout and unsaved notebook edits. */
export interface PaperView {
  /** Absent in older browser preferences; resolvePanelOrder supplies the reading order. */
  order?: ResearchPanel[]
  files?: PaperFileView
  panels: Record<ResearchPanel, boolean>
  widths: Record<ResearchPanel, number>
  active: ResearchPanel
  notebook: ResearchNoteKind
  drafts: Partial<Record<ResearchNoteKind, NoteDraft>>
  /** Absent in earlier browser preferences. */
  reading?: Partial<Record<ResearchNoteKind, NoteReadingView>>
}

/**
 * Recognize a paper-panel identifier from drag events or browser preferences.
 * @param value - candidate identifier.
 * @returns whether it identifies one of the three reading panels.
 */
export function isResearchPanel(value: unknown): value is ResearchPanel {
  return value === 'agent' || value === 'pdf' || value === 'notes'
}

/**
 * Resolve missing or invalid browser-stored order to the default permutation.
 * @param view - browser preferences for one paper.
 * @returns the complete panel order, including folded panels.
 */
export function resolvePanelOrder(view: Pick<PaperView, 'order'>): readonly ResearchPanel[] {
  const stored: unknown = view.order
  return Array.isArray(stored) && stored.length === 3 && stored.every(isResearchPanel) && new Set(stored).size === 3
    ? stored : DEFAULT_PANEL_ORDER
}

/**
 * Move one panel before or after another while retaining every panel.
 * @param order - resolved complete panel order.
 * @param source - panel being moved.
 * @param target - insertion neighbor.
 * @param placement - insertion side of the neighbor.
 * @returns a new order; moving onto the source leaves its order unchanged.
 */
export function reorderPanels(
  order: readonly ResearchPanel[], source: ResearchPanel, target: ResearchPanel, placement: PanelPlacement,
): ResearchPanel[] {
  if (source === target) return [...order]
  const remaining = order.filter(panel => panel !== source)
  remaining.splice(remaining.indexOf(target) + (placement === 'after' ? 1 : 0), 0, source)
  return remaining
}

/**
 * Create independent default panel preferences with the notebook folded.
 * @returns fresh panel preferences.
 */
export function defaultPaperView(): PaperView {
  return {
    panels: { agent: true, pdf: true, notes: false }, widths: { agent: 38, pdf: 38, notes: 24 },
    active: 'agent', notebook: 'learning', drafts: {},
  }
}

function researchViewDefinition() {
  return defineStore({
    persist: 'dsh.research.view.v1',
    init: () => ({
      expanded: {} as Record<string, boolean>, topicId: undefined as ResearchTopicId | undefined,
      papers: {} as Record<ResearchPaperId, PaperView>,
    }),
    actions: {
      forgetPaper: (draft, id: ResearchPaperId) => {
        draft.papers = Object.fromEntries(Object.entries(draft.papers).filter(([key]) => key !== id))
      },
      expand: (draft, id: string, value: boolean) => { draft.expanded[id] = value },
      topic: (draft, id: ResearchTopicId) => { draft.topicId = id; draft.expanded[id] = true },
      place: (draft, id: ResearchPaperId, source: ResearchPanel, target: ResearchPanel, placement: PanelPlacement) => {
        const view = draft.papers[id] ??= defaultPaperView()
        view.order = reorderPanels(resolvePanelOrder(view), source, target, placement)
      },
      panel: (draft, id: ResearchPaperId, panel: ResearchPanel) => {
        const view = draft.papers[id] ??= defaultPaperView()
        view.panels[panel] = !view.panels[panel]
        if (view.panels[panel]) view.active = panel
        else if (view.active === panel) view.active = resolvePanelOrder(view).find(item => view.panels[item]) ?? 'agent'
      },
      focus: (draft, id: ResearchPaperId, panel: ResearchPanel) => {
        const view = draft.papers[id] ??= defaultPaperView()
        view.panels[panel] = true; view.active = panel
      },
      widths: (draft, id: ResearchPaperId, left: ResearchPanel, right: ResearchPanel, delta: number) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const bounded = Math.max(12 - view.widths[left], Math.min(view.widths[right] - 12, delta))
        view.widths[left] += bounded; view.widths[right] -= bounded
      },
      reset: (draft, id: ResearchPaperId) => {
        const previous = draft.papers[id] ?? defaultPaperView()
        draft.papers[id] = { ...defaultPaperView(), panels: { agent: true, pdf: true, notes: true },
          drafts: previous.drafts, notebook: previous.notebook,
          ...previous.files === undefined ? {} : { files: previous.files },
          ...previous.reading === undefined ? {} : { reading: previous.reading } }
      },
      fileSelect: (draft, id: ResearchPaperId, path: string) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const files = view.files ??= { expanded: {}, drafts: {}, reading: {} }
        files.selected = path
        if (path === 'notes/ai.md' || path === 'notes/learning.md') {
          view.notebook = path === 'notes/ai.md' ? 'ai' : 'learning'
          const reading = view.reading ??= {}
          reading[view.notebook] ??= { mode: 'preview' }
        }
      },
      fileExpand: (draft, id: ResearchPaperId, path: string, expanded: boolean) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const files = view.files ??= { expanded: {}, drafts: {}, reading: {} }
        files.expanded[path] = expanded
      },
      fileSplit: (draft, id: ResearchPaperId, axis: FileSplitAxis, percent: number) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const files = view.files ??= { expanded: {}, drafts: {}, reading: {} }
        const split = files.split ??= {}
        split[axis] = Math.max(FILE_SPLIT_LIMITS.min, Math.min(FILE_SPLIT_LIMITS.max, percent))
      },
      fileEdit: (draft, id: ResearchPaperId, path: string, text: string, version: string) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const files = view.files ??= { expanded: {}, drafts: {}, reading: {} }
        files.drafts[path] = { text, version: files.drafts[path]?.version ?? version }
      },
      fileSaved: (draft, id: ResearchPaperId, path: string, text: string, version: string) => {
        const files = draft.papers[id]?.files
        const file = files?.drafts[path]
        if (file === undefined || files === undefined) return
        if (file.text === text) files.drafts = Object.fromEntries(Object.entries(files.drafts).filter(([key]) => key !== path))
        else file.version = version
      },
      fileDiscard: (draft, id: ResearchPaperId, path: string) => {
        const files = draft.papers[id]?.files
        if (files !== undefined) files.drafts = Object.fromEntries(Object.entries(files.drafts).filter(([key]) => key !== path))
      },
      fileReading: (draft, id: ResearchPaperId, path: string, reading: NoteReadingView) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const files = view.files ??= { expanded: {}, drafts: {}, reading: {} }
        files.reading[path] = { ...files.reading[path], ...reading }
      },
      notebook: (draft, id: ResearchPaperId, kind: ResearchNoteKind) => { (draft.papers[id] ??= defaultPaperView()).notebook = kind },
      noteMode: (draft, id: ResearchPaperId, kind: ResearchNoteKind, mode: 'edit' | 'preview', latest: boolean = false) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const reading = view.reading ??= {}
        reading[kind] = { ...reading[kind], mode, latest }
      },
      noteEditor: (draft, id: ResearchPaperId, kind: ResearchNoteKind, position: NoteEditorPosition) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const reading = view.reading ??= {}
        reading[kind] = { ...reading[kind], editor: position }
      },
      notePreview: (draft, id: ResearchPaperId, kind: ResearchNoteKind, position: NoteScrollPosition) => {
        const view = draft.papers[id] ??= defaultPaperView()
        const reading = view.reading ??= {}
        reading[kind] = { ...reading[kind], preview: position }
      },
      edit: (draft, id: ResearchPaperId, kind: ResearchNoteKind, text: string, revision: number) => {
        const view = draft.papers[id] ??= defaultPaperView()
        view.drafts[kind] = { text, revision: view.drafts[kind]?.revision ?? revision }
      },
      saved: (draft, id: ResearchPaperId, kind: ResearchNoteKind, text: string, revision: number) => {
        const view = draft.papers[id]
        if (view?.drafts[kind]?.text === text) view.drafts = Object.fromEntries(Object.entries(view.drafts).filter(([key]) => key !== kind))
        else if (view?.drafts[kind] !== undefined) view.drafts[kind].revision = revision
      },
      discard: (draft, id: ResearchPaperId, kind: ResearchNoteKind) => {
        const view = draft.papers[id]
        if (view !== undefined) view.drafts = Object.fromEntries(Object.entries(view.drafts).filter(([key]) => key !== kind))
      },
    },
  })
}

/**
 * Declare persisted research navigation and notebook drafts.
 * @returns the shared directory and workbench store declaration.
 */
export function createResearchViewStore(): ReturnType<typeof researchViewDefinition> {
  return researchViewDefinition()
}

/** Store shared by both registered research views. */
export type ResearchViewStore = ReturnType<typeof createResearchViewStore>
