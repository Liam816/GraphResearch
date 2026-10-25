/** Research directory module delegates to the same durable commands as pointer and keyboard sorting. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { orderedTopicPapers } from './research-order.ts'
import type { ResearchCatalog, ResearchReorderPapersRequest, ResearchTopicId, ResearchPaperId } from './research-types.ts'
import type { UiModule } from './ui-modules.ts'

const targetSchema = z.strictObject({
  topicId: z.string().min(1).describe('Topic identity. Omit to list all Topic reading orders; required for updates.').optional(),
})
const changeSchema = z.strictObject({
  paperIds: z.array(z.string().min(1)).describe('Every current paper ID exactly once, in the desired reading order.'),
  expectedPaperIds: z.array(z.string().min(1)).describe('Complete paperIds from the last ui_read; a concurrent order or membership change is rejected.'),
})

/**
 * Define the reading-order provider; other modules can register independently of these tools.
 * @param commands - current library and shared persistent reorder command.
 * @returns module definition for registration through ctx.effect.
 */
export function researchDirectoryModule(commands: {
  list: () => Promise<ResearchCatalog>
  reorder: (request: ResearchReorderPapersRequest) => Promise<ResearchCatalog>
}): UiModule<z.infer<typeof targetSchema>, z.infer<typeof changeSchema>> {
  const state = (catalog: ResearchCatalog, topicId: string) => {
    const topic = catalog.topics.find(item => item.id === topicId)
    if (topic === undefined) throw new RemoteError('research/not-found', 'Choose an existing Topic from research_context', { id: topicId })
    const papers = orderedTopicPapers(catalog, topic)
    return { topicId: topic.id, title: topic.title, paperIds: papers.map(paper => paper.id),
      papers: papers.map(paper => ({ id: paper.id, title: paper.title })) }
  }
  return {
    name: 'research.directory',
    description: 'Reorder papers within one Topic. Topic and paper conversations can manage any explicitly selected Topic. Read its complete paperIds, then submit a permutation with expectedPaperIds. New papers append; shared papers have an independent order in each Topic. This changes reading order only, preserving files, membership and conversations.',
    target: { jsonSchema: z.toJSONSchema(targetSchema), parse: value => targetSchema.parse(value) },
    change: { jsonSchema: z.toJSONSchema(changeSchema), parse: value => changeSchema.parse(value) },
    read: async (target) => {
      const catalog = await commands.list()
      return target.topicId === undefined
        ? { topics: catalog.topics.map(topic => state(catalog, topic.id)) } : state(catalog, target.topicId)
    },
    update: async (target, change) => {
      if (target.topicId === undefined) throw new RemoteError('ui/invalid-arguments', 'Choose a topicId from ui_read before updating its reading order', {})
      return state(await commands.reorder({
        topicId: brandString<ResearchTopicId>(target.topicId),
        paperIds: change.paperIds.map(id => brandString<ResearchPaperId>(id)),
        expectedPaperIds: change.expectedPaperIds.map(id => brandString<ResearchPaperId>(id)),
      }), target.topicId)
    },
  }
}
