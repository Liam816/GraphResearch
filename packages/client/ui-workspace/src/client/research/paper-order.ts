/** Reading-order projection over the confirmed catalog supplied by the framework hook. */
import type { ResearchCatalog, ResearchPaper, ResearchTopic } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * Resolve a Topic's saved order, appending new members and omitting removed members.
 * @param catalog - confirmed library from the research hook.
 * @param topic - selected Topic.
 * @returns directory and navigation papers in the same order.
 */
export function orderedTopicPapers(catalog: ResearchCatalog, topic: ResearchTopic): ResearchPaper[] {
  const ranks = new Map(topic.paperOrder?.map((id, index) => [id, index]))
  return catalog.papers.filter(paper => paper.topicIds.includes(topic.id))
    .sort((a, b) => (ranks.get(a.id) ?? ranks.size) - (ranks.get(b.id) ?? ranks.size))
}
