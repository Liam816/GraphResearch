/** Current Topic papers remain reachable while the main directory is collapsed. */
import { useMemo } from 'react'
import { NavigationRail } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchPaper, ResearchTopic } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchWorkbenchProps } from './contract.ts'
import css from './Research.module.css'

/** @param props - current Topic, its confirmed papers, selection and existing navigation. @returns a leading paper rail. */
export function PaperNavigator({ topic, papers, activeId, open, t }: Pick<ResearchWorkbenchProps, 'open' | 't'> & {
  topic: ResearchTopic
  papers: readonly ResearchPaper[]
  activeId: ResearchPaper['id'] | null
}) {
  const items = useMemo(() => papers.map(paper => ({
    id: paper.id, title: paper.title, label: t('openPaper', { title: paper.title }),
    description: paper.progress || topic.title,
  })), [papers, topic.title, t])
  if (items.length === 0) return null
  return <div className={css.paperRailSlot} data-topic-paper-rail>
    <NavigationRail key={topic.id} className={css.paperRail} side="left" items={items} activeId={activeId}
      label={t('paperNavigation', { topic: topic.title })} onNavigate={(item) => {
        const paper = papers.find(candidate => candidate.id === item.id)
        if (paper !== undefined) open(paper.sessionId)
      }} />
  </div>
}
