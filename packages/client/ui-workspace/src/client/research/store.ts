/** Research navigation and paper-local panel preferences; catalog data remains Host-owned. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { ResearchNoteKind, ResearchPaperId, ResearchTopicId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Independently collapsible paper panels. */
export type ResearchPanel = 'agent' | 'pdf' | 'notes'
/** Draft retains the revision it started from until a durable save succeeds. */
export interface NoteDraft { text: string; revision: number }
/** Paper-local layout and unsaved notebook edits. */
export interface PaperView {
  panels: Record<ResearchPanel, boolean>
  widths: Record<ResearchPanel, number>
  active: ResearchPanel
  notebook: ResearchNoteKind
  drafts: Partial<Record<ResearchNoteKind, NoteDraft>>
}

/**
 * Create independent default panel preferences.
 * @returns fresh panel preferences.
 */
export function defaultPaperView(): PaperView {
  return {
    panels: { agent: true, pdf: true, notes: true }, widths: { agent: 38, pdf: 38, notes: 24 },
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
      expand: (draft, id: string, value: boolean) => { draft.expanded[id] = value },
      topic: (draft, id: ResearchTopicId) => { draft.topicId = id; draft.expanded[id] = true },
      panel: (draft, id: ResearchPaperId, panel: ResearchPanel) => {
        const view = draft.papers[id] ??= defaultPaperView()
        view.panels[panel] = !view.panels[panel]
        if (view.panels[panel]) view.active = panel
        else if (view.active === panel) view.active = (['agent', 'pdf', 'notes'] as const).find(item => view.panels[item]) ?? 'agent'
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
        draft.papers[id] = { ...defaultPaperView(), drafts: previous.drafts, notebook: previous.notebook }
      },
      notebook: (draft, id: ResearchPaperId, kind: ResearchNoteKind) => { (draft.papers[id] ??= defaultPaperView()).notebook = kind },
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
