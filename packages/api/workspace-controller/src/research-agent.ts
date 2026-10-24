/** Paper-scoped Agent tools share the Host library and its canonical Markdown files. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { paperConversations, paperForSession } from './research-conversations.ts'
import type { ResearchCatalog, ResearchPaperId, ResearchTopicId } from './research-types.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './index.ts'

/** Services inherited by the selected research Agent's existing execution scope. */
export const inject = ['workspaceController', 'tools', 'systemPrompt', 'workingDirectory']

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Attach research capabilities to an existing research entity's Agent scope.
 * @param ctx - scoped Agent context; ordinary Sessions never mount this plugin.
 */
export function apply(ctx: Context): void {
  const controller = ctx.workspaceController
  const currentPaper = (catalog: ResearchCatalog, exec: ToolRunContext, id?: string) => {
    const paper = id === undefined ? paperForSession(catalog, exec.agent?.session.id)
      : catalog.papers.find(item => item.id === id)
    if (paper === undefined) throw new Error('Choose a paper_id from research_context before operating on a paper')
    return paper
  }
  const currentTopic = (catalog: ResearchCatalog, exec: ToolRunContext, id?: string) => {
    const paper = paperForSession(catalog, exec.agent?.session.id)
    const topic = id === undefined ? catalog.topics.find(item => item.sessionId === exec.agent?.session.id)
      ?? catalog.topics.find(item => paper?.topicIds.includes(item.id)) : catalog.topics.find(item => item.id === id)
    if (topic === undefined) throw new Error('Choose a topic_id from research_context before importing a paper')
    return topic
  }
  ctx.systemPrompt.context({
    name: 'research:library', order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'), required: true, interpolate: false,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const catalog = controller.researchCurrent()
      const paper = paperForSession(catalog, agent.session.id)
      const topic = catalog.topics.find(item => item.sessionId === agent.session.id)
      return `Research library: ${catalog.directory ?? ''}\n${JSON.stringify({
        paper: paper === undefined ? null : { id: paper.id, title: paper.title, directory: paper.directory,
          progress: paperConversations(paper).find(item => item.sessionId === agent.session.id)?.progress,
          abbreviation: paper.abbreviation, pdf: paper.pdfPath, markdown: paper.markdown, repository: paper.repositoryUrl,
          aiNoteRevision: paper.ai.revision, learningNoteRevision: paper.learning.revision },
        topic: topic === undefined ? null : { id: topic.id, title: topic.title },
      })}\nPaper directories contain only user documents. Store downloads, notes, figures and repositories in the owning paper directory; organize, create, move or delete its contents as the user requests. There are no required assets, code or extracted folders. The library agent-lib directory belongs to the Harness; never place user documents there or edit its runtime records. `
        + 'Use research_import_paper to register and reuse papers; a title alone is enough. Supply a recognizable core abbreviation such as OpenVLA or RT2, and use the returned paper directory before saving files. '
        + 'An empty pdf means the original is not attached. When asked to download the current paper, find its original PDF URL and use research_attach_pdf; preserve its existing identity, session and notes. '
        + 'Attached PDFs automatically produce paper_<abbreviation>.md in the paper directory, with original page headings and all extracted text, including references and appendices. '
        + 'Use research_attach_pdf.folder for a user-chosen subfolder; the PDF, Markdown and bibliographic JSON stay together there. After moving an original inside its paper directory, attach its new local path with the same abbreviation to update the association without copying it back to the root. '
        + 'Read the recorded markdown.path only when markdown.status is ready; a failed conversion retains the original PDF and requires retry or OCR. '
        + 'Use research_read_paper for page-numbered original text. Read existing notes with research_context before writing them. '
        + 'Use research_write_note to publish Markdown to the live AI notebook; update it by section as reading progresses. '
        + 'Edit learning notes only when the user explicitly asks. '
        + 'Cite original page numbers and distinguish paper claims from your interpretation. '
        + 'Clone repositories in a user-chosen location under the owning paper directory and record the commit analyzed in the AI notebook. Create folders only when needed. General file tools may create, download, move, rename or delete any user content there, including notes and extracted Markdown. Deleting user files must not delete or alter the paper entity or its conversations. Refresh research_context after filesystem changes; explicitly retry conversion only when the user wants to recreate a deleted Markdown document. '
        + 'Keep continuation points and unresolved questions with research_update_progress. '
        + 'Use research_write_topic_note for comparisons with paper sources.'
    },
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent !== undefined) {
      const catalog = await controller.researchList()
      const paper = paperForSession(catalog, context.agent.session.id)
      const topic = catalog.topics.find(item => item.sessionId === context.agent?.session.id)
      const directory = paper?.directory
        ?? (topic === undefined ? undefined : `${catalog.directory}/topics/${topic.id}`)
      if (directory !== undefined && ctx.workingDirectory.get(context.agent.session) !== directory) {
        await ctx.workingDirectory.set(context.agent, directory, context.signal)
      }
    }
    return next()
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: 'research_context', description: 'Read the research catalog and existing Markdown notes before reading, comparing or updating papers.',
    parameters: { paper_id: { type: 'string', description: 'Optional paper to read in detail; omitted returns the current paper or topic catalog.' } }, output,
    async execute(args, exec) {
      const catalog = await controller.researchList()
      const paper = args.paper_id === undefined ? paperForSession(catalog, exec.agent?.session.id)
        : currentPaper(catalog, exec, args.paper_id)
      const conversation = paper === undefined ? undefined
        : paperConversations(paper).find(item => item.sessionId === exec.agent?.session.id)
      const entity = paper === undefined ? undefined : (({ conversations: _conversations, ...metadata }) => ({
        ...metadata,
        ...(conversation === undefined || conversation.sessionId === paper.sessionId) ? {} : {
          sessionId: conversation.sessionId, progress: conversation.progress,
        },
      }))(paper)
      const result = entity === undefined ? catalog : { directory: catalog.directory, paper: entity, topics: catalog.topics }
      return JSON.stringify(result, null, 2)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'research_import_paper', description: 'Register a paper in the fixed library with its independent Agent session; optionally import a PDF and reuse matching papers. To supply the current paper’s missing PDF, use research_attach_pdf.',
    parameters: {
      topic_id: { type: 'string', description: 'Owning Topic; defaults to the current research Topic.' },
      abbreviation: { type: 'string', required: true, description: 'Core paper acronym, such as OpenVLA or RT2, without a path, prefix or extension.' },
      title: { type: 'string', required: true, description: 'Use the user’s paper name; otherwise choose a recognizable paper title. This also names its directory.' },
      source: { type: 'string', description: 'Optional HTTP(S) PDF URL or local Host PDF path. arXiv abstract URLs are accepted. Omit to create the paper before obtaining its PDF.' },
      source_id: { type: 'string', description: 'arXiv ID including version, or DOI.' },
      repository_url: { type: 'string', description: 'Optional source-code repository URL.' },
    }, output,
    async execute(args, exec) {
      const topic = currentTopic(await controller.researchList(), exec, args.topic_id)
      const result = await controller.researchImportPaper({
        topicId: topic.id, title: args.title, abbreviation: args.abbreviation,
        ...args.source === undefined ? {} : { source: args.source },
        ...args.source_id === undefined ? {} : { sourceId: args.source_id },
        ...args.repository_url === undefined ? {} : { repositoryUrl: args.repository_url },
      }, exec.signal)
      return JSON.stringify(result.catalog.papers.find(item => item.id === result.paperId), null, 2)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'research_attach_pdf', description: 'Download or copy the original PDF into an existing paper, preserving its directory, Agent session and notes. The PDF preview updates automatically. A different existing PDF cannot be overwritten.',
    parameters: {
      abbreviation: { type: 'string', required: true, description: 'Choose the paper’s core acronym; the original and its converted Markdown and metadata use paper_<acronym> filenames.' },
      folder: { type: 'string', description: 'Optional paper-relative folder for the PDF, Markdown and bibliographic JSON. Local sources inside the paper retain their parent when omitted.' },
      paper_id: { type: 'string', description: 'Defaults to the paper owning this session; required from a Topic session.' },
      source: { type: 'string', required: true, description: 'HTTP(S) PDF URL, arXiv abstract URL, or local Host path. Relative paths start in the target paper directory.' },
    }, output,
    async execute(args, exec) {
      const paper = currentPaper(await controller.researchList(), exec, args.paper_id)
      const catalog = await controller.researchAttachPdf({
        paperId: paper.id, source: args.source, abbreviation: args.abbreviation,
        ...args.folder === undefined ? {} : { folder: args.folder },
      }, exec.signal)
      return JSON.stringify(catalog.papers.find(item => item.id === paper.id), null, 2)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'research_read_paper', description: 'Extract a bounded range of original PDF pages and cache the page-numbered text in private runtime storage. Image-only pages require OCR.',
    parameters: {
      paper_id: { type: 'string', description: 'Defaults to the paper owning this session.' },
      start_page: { type: 'integer', description: 'First original page, starting at 1.' },
      page_count: { type: 'integer', description: 'Number of pages; defaults to the configured page limit.' },
    }, output,
    async execute(args, exec) {
      const paper = currentPaper(await controller.researchList(), exec, args.paper_id)
      return JSON.stringify(await controller.researchReadPaper({
        paperId: paper.id, ...args.start_page === undefined ? {} : { startPage: args.start_page },
        ...args.page_count === undefined ? {} : { pageCount: args.page_count },
      }, exec.signal), null, 2)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'research_write_note', description: 'Publish Markdown to the live paper notebook with a revision check. Learning notes require an explicit user request.',
    parameters: {
      paper_id: { type: 'string', description: 'Defaults to the current paper.' },
      kind: { type: 'string', required: true, enum: ['ai', 'learning'], description: 'AI analysis or user-owned learning notes.' },
      operation: { type: 'string', required: true, enum: ['append', 'replace', 'section'],
        description: 'Append text, explicitly replace the notebook, or update one level-two heading.' },
      heading: { type: 'string', description: 'Heading text without ##; required for section updates.' },
      text: { type: 'string', required: true, description: 'Markdown text; include citations to original pages.' },
      expected_revision: { type: 'integer', required: true, description: 'Notebook revision read from research_context. Conflicts require rereading and merging.' },
    }, output,
    async execute(args, exec) {
      const paper = currentPaper(await controller.researchList(), exec, args.paper_id)
      const previous = paper[args.kind].text
      const text = args.operation === 'replace' ? args.text : args.operation === 'append'
        ? `${previous}${previous === '' || previous.endsWith('\n') ? '' : '\n'}${args.text}`
        : updateSection(previous, args.heading, args.text)
      const catalog = await controller.researchSaveNote({
        paperId: paper.id, kind: args.kind, text, expectedRevision: args.expected_revision,
      })
      const saved = catalog.papers.find(item => item.id === paper.id)
      return JSON.stringify({ paperId: paper.id, kind: args.kind, revision: saved?.[args.kind].revision,
        path: `${paper.directory}/notes/${args.kind}.md` })
    },
    presentCall: args => ({ card: 'diff', title: 'Update research notebook', diffs: [{ path: `notes/${args.kind}.md`, oldText: null, newText: args.text }] }),
  }))
  ctx.tools.register(defineTool({
    name: 'research_update_progress', description: 'Save where reading stopped and the remaining questions for the next reading session.',
    parameters: {
      paper_id: { type: 'string', description: 'Defaults to the current paper.' },
      text: { type: 'string', required: true, description: 'Continuation point, completed sections and unresolved questions.' },
    }, output,
    async execute(args, exec) {
      const paper = currentPaper(await controller.researchList(), exec, args.paper_id)
      const sessionId = paperConversations(paper).find(item => item.sessionId === exec.agent?.session.id)?.sessionId
      await controller.researchProgress(brandString<ResearchPaperId>(paper.id), args.text, sessionId)
      return JSON.stringify({ paperId: paper.id, progress: args.text })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'research_write_topic_note', description: 'Save a Markdown comparison of papers in a Topic, retaining sources for each conclusion.',
    parameters: {
      topic_id: { type: 'string', description: 'Defaults to the current Topic.' },
      text: { type: 'string', required: true, description: 'Complete Markdown topic summary, with paper identities and page references.' },
      expected_revision: { type: 'integer', required: true, description: 'Topic notes revision read from research_context.' },
    }, output,
    async execute(args, exec) {
      const topic = currentTopic(await controller.researchList(), exec, args.topic_id)
      const catalog = await controller.researchTopicNote(brandString<ResearchTopicId>(topic.id), args.text, args.expected_revision)
      return JSON.stringify(catalog.topics.find(item => item.id === topic.id)?.notes)
    },
  }))
}

function updateSection(previous: string, heading: string | undefined, text: string): string {
  if (heading === undefined || heading.trim() === '' || heading.includes('\n')) throw new Error('Provide a one-line heading for a section update')
  const lines = previous.split('\n'), title = `## ${heading.trim()}`
  const start = lines.findIndex(line => line.trim() === title)
  const replacement = `${title}\n\n${text}\n`
  if (start === -1) return `${previous}${previous === '' ? '' : '\n\n'}${replacement}`
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line))
  return [...lines.slice(0, start), replacement, ...end === -1 ? [] : lines.slice(end)].join('\n')
}
