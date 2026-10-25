/** Topic-local reading order shared by the catalog, Agent tools and directory views. */
import type { ResearchCatalog, ResearchPaper, ResearchTopic } from './research-types.ts'

/**
 * Resolve existing members once, then append new members in catalog order.
 * @param catalog - confirmed library.
 * @param topic - Topic whose stored order may predate membership changes.
 * @returns current papers in this Topic's reading order.
 */
export function orderedTopicPapers(catalog: ResearchCatalog, topic: ResearchTopic): ResearchPaper[] {
  const members = new Map(catalog.papers.filter(paper => paper.topicIds.includes(topic.id)).map(paper => [paper.id, paper]))
  const ordered: ResearchPaper[] = []
  for (const id of topic.paperOrder ?? []) {
    const paper = members.get(id)
    if (paper !== undefined) { ordered.push(paper); members.delete(id) }
  }
  return [...ordered, ...members.values()]
}
