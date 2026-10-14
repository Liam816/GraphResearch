/** Empty research service for Client Workspace tests that exercise the ordinary browser. */
import type { Context } from '@deepseek-ai/cordis'
import { ClientResearchModel } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** @param ctx - test Context receiving real catalog lifecycle and inert empty commands. */
export function installEmptyResearch(ctx: Context): void {
  const result = () => Promise.resolve({ ok: true as const, value: { revision: 0, topics: [], papers: [] } })
  ctx.provide('research', new ClientResearchModel({ researchList: result, researchCreateTopic: result, researchCreatePaper: result, researchSaveNote: result,
    researchConfigure: result, researchHighlight: result, researchExtractMarkdown: result,
    researchImportPaper: () => Promise.reject(new Error('paper imports are not used by this fixture')),
    researchMentions: () => Promise.resolve({ ok: true as const, value: [] }) }))
  ctx.provide('remote.workspaceFiles', {})
}
