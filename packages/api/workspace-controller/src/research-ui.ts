/** Research directory module delegates to the same durable commands as pointer and keyboard sorting. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { orderedTopicPapers } from './research-order.ts'
import type { ResearchCatalog, ResearchReorderPapersRequest, ResearchReorderTopicsRequest, ResearchTopicId, ResearchPaperId } from './research-types.ts'
import type { UiModule } from './ui-modules.ts'

const targetSchema = z.strictObject({
  topicId: z.string().min(1).describe('Topic identity for paper-order changes. Omit to read or reorder the Topic directory.').optional(),
})
const paperChangeSchema = z.strictObject({
  paperIds: z.array(z.string().min(1)).describe('Every current paper ID exactly once, in the desired reading order.'),
  expectedPaperIds: z.array(z.string().min(1)).describe('Complete paperIds from the last ui_read; a concurrent order or membership change is rejected.'),
})
const topicChangeSchema = z.strictObject({
  topicIds: z.array(z.string().min(1)).describe('Every current Topic ID exactly once, in the desired directory order. Use an empty target.'),
  expectedTopicIds: z.array(z.string().min(1)).describe('Complete topicIds from the last ui_read; concurrent order or membership changes are rejected.'),
})
const changeSchema = z.union([paperChangeSchema, topicChangeSchema])

/**
 * Define the reading-order provider; other modules can register independently of these tools.
 * @param commands - current library and shared persistent reorder command.
 * @returns module definition for registration through ctx.effect.
 */
export function researchDirectoryModule(commands: {
  list: () => Promise<ResearchCatalog>
  reorder: (request: ResearchReorderPapersRequest) => Promise<ResearchCatalog>
  reorderTopics: (request: ResearchReorderTopicsRequest) => Promise<ResearchCatalog>
}): UiModule<z.infer<typeof targetSchema>, z.infer<typeof changeSchema>> {
  const state = (catalog: ResearchCatalog, topicId: string) => {
    const topic = catalog.topics.find(item => item.id === topicId)
    if (topic === undefined) throw new RemoteError('research/not-found', 'Choose an existing Topic from research_context', { id: topicId })
    const papers = orderedTopicPapers(catalog, topic)
    return { topicId: topic.id, title: topic.title, paperIds: papers.map(paper => paper.id),
      papers: papers.map(paper => ({ id: paper.id, title: paper.title })) }
  }
  const directory = (catalog: ResearchCatalog) => ({
    topicIds: catalog.topics.map(topic => topic.id), topics: catalog.topics.map(topic => state(catalog, topic.id)),
  })
  return {
    name: 'research.directory',
    description: 'Reorder the Topic directory or papers within one Topic. Any conversation can manage an explicitly selected order. With an empty target, read topicIds then submit a permutation with expectedTopicIds. With topicId, read paperIds then submit a permutation with expectedPaperIds. New entities append; shared papers have an independent order in each Topic. Files, membership and conversations are preserved.',
    target: { jsonSchema: z.toJSONSchema(targetSchema), parse: value => targetSchema.parse(value) },
    change: { jsonSchema: z.toJSONSchema(changeSchema), parse: value => changeSchema.parse(value) },
    read: async (target) => {
      const catalog = await commands.list()
      return target.topicId === undefined
        ? directory(catalog) : state(catalog, target.topicId)
    },
    update: async (target, change) => {
      if ('topicIds' in change) {
        if (target.topicId !== undefined) {
          throw new RemoteError('ui/invalid-arguments', 'Use an empty target to reorder the Topic directory', {})
        }
        return directory(await commands.reorderTopics({
          topicIds: change.topicIds.map(id => brandString<ResearchTopicId>(id)),
          expectedTopicIds: change.expectedTopicIds.map(id => brandString<ResearchTopicId>(id)),
        }))
      }
      if (target.topicId === undefined) throw new RemoteError('ui/invalid-arguments', 'Choose a topicId from ui_read before updating its reading order', {})
      return state(await commands.reorder({
        topicId: brandString<ResearchTopicId>(target.topicId),
        paperIds: change.paperIds.map(id => brandString<ResearchPaperId>(id)),
        expectedPaperIds: change.expectedPaperIds.map(id => brandString<ResearchPaperId>(id)),
      }), target.topicId)
    },
  }
}
