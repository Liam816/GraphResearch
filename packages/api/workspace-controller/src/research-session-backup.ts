/** Restore library-owned Session snapshots only when the native provider has no matching Session. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { ResearchCatalog } from './research-types.ts'
import { missing } from './research-files.ts'
import type { ResearchFiles } from './research-files.ts'

const headerSchema: z.ZodType<SessionHeader> = z.object({
  version: z.literal(SESSION_FORMAT_VERSION), id: z.string().transform(SessionId), createdAt: z.number().int().nonnegative(),
  isSeeded: z.boolean(), cwd: z.string().refine(isAbsolute).optional(), parentSession: z.string().transform(SessionId).optional(),
  origin: z.literal('subagent').optional(), delegationDepth: z.number().int().nonnegative().optional(), agentPreset: z.string().optional(),
}).transform(value => ({
  version: value.version, id: value.id, createdAt: value.createdAt, isSeeded: value.isSeeded,
  ...value.cwd === undefined ? {} : { cwd: value.cwd },
  ...value.parentSession === undefined ? {} : { parentSession: value.parentSession },
  ...value.origin === undefined ? {} : { origin: value.origin },
  ...value.delegationDepth === undefined ? {} : { delegationDepth: value.delegationDepth },
  ...value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset },
}))
const backupSchema = z.object({
  header: headerSchema, events: z.array(z.unknown()), inheritedEventCount: z.number().int().nonnegative().optional(),
})

/**
 * Recover native Sessions and missing Workspace bindings from a copied library without replacing existing logs.
 * @param ctx - native persistence and Workspace owners.
 * @param files - selected canonical library.
 * @param catalog - committed library metadata.
 * @returns metadata with current Workspace bindings; callers publish any changed bindings.
 */
export async function restoreResearchSessions(ctx: Context, files: ResearchFiles, catalog: ResearchCatalog): Promise<ResearchCatalog> {
  for (const item of [...catalog.topics, ...catalog.papers]) {
    const path = await files.path(catalog.papers.some(paper => paper.id === item.id) ? 'papers' : 'topics', item.id, 'session.json')
    let content: string
    try { content = await readFile(path, 'utf8') } catch (error: unknown) { if (missing(error)) continue; throw error }
    try {
      const value: unknown = JSON.parse(content)
      const backup = backupSchema.parse(value)
      if (backup.header.id !== item.sessionId) throw new Error('Session identity differs from the library entity')
      if (await ctx.sessionPersistence.stat(item.sessionId) !== undefined) continue
      if (backup.header.isSeeded && backup.inheritedEventCount === undefined) throw new Error('Seeded snapshot is missing its inherited event count')
      const inherited = SessionLogOffset(backup.inheritedEventCount ?? 0)
      // The installed validator checks the decoded records before any native log is created.
      const events = validateStoredEvents(backup.header, backup.events as SessionEvent[])
      Session.fromRestore(item.sessionId, events, backup.header, inherited, 'detached')
      const handle = await ctx.sessionPersistence.create(backup.header, { inheritedEventCount: inherited })
      try { await handle.append(events); await handle.flush() } finally { await handle.close() }
    } catch (error: unknown) {
      throw new RemoteError('research/invalid-library',
        'Cannot restore this Session snapshot; use a compatible release or repair the snapshot', { path }, { cause: error })
    }
  }
  const topics: ResearchCatalog['topics'][number][] = []
  let changed = false
  for (const topic of catalog.topics) {
    let workspace = ctx.workspaceRegistry.get(topic.workspaceId)
    if (workspace === undefined) {
      const header = ctx.sessions.get(topic.sessionId)?.header
        ?? (await ctx.sessionPersistence.stat(topic.sessionId))?.header
      workspace = await ctx.workspaceRegistry.create(header?.cwd ?? files.directory)
      changed = true
    }
    const paperSessions = catalog.papers.filter(paper => paper.topicIds.includes(topic.id)).map(paper => paper.sessionId)
    for (const id of [topic.sessionId, ...paperSessions]) {
      if (workspace.sessionIds.includes(id)) continue
      const header = ctx.sessions.get(id)?.header ?? (await ctx.sessionPersistence.stat(id))?.header
      const owner = header?.cwd === undefined ? workspace : await ctx.workspaceRegistry.create(header.cwd)
      await owner.attachSession(id)
    }
    topics.push({ ...topic, workspaceId: workspace.id })
  }
  return changed ? { ...catalog, topics, revision: catalog.revision + 1 } : catalog
}
