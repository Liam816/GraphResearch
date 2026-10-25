/** Recorded Agent operations discover, read and reorder the same directory rendered by the browser. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { orderedTopicPapers } from '../../../packages/api/workspace-controller/src/research-order.ts'
import { assertFinalWorkspaceSnapshot, fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/research-paper-order', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')

it('discovers interface modules in every Agent scope and commits a recorded Topic reading order', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true })
  onTestFinished(() => scaffold.close())
  const root = (await scaffold.ctx.workspaceController.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  for (const id of ['order-session', 'alpha-session', 'beta-session', 'ordinary-session']) {
    await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId(id) })
  }
  const initialized = await scaffold.ctx.workspaceController.researchCreateTopic({
    title: 'Robot policies', workspaceId: workspace.id, sessionId: SessionId('order-session'),
  })
  const empty = { revision: 0, sha256: createHash('sha256').update('').digest('hex') }
  for (const folder of ['Alpha', 'Beta']) await mkdir(join(root, 'papers', folder), { recursive: true })
  await mkdir(join(root, 'topics', 'order-topic'), { recursive: true })
  await mkdir(join(root, 'agent-lib'), { recursive: true })
  await writeFile(join(root, 'agent-lib', 'library.json'), JSON.stringify({ version: 4, revision: initialized.revision + 1,
    topics: [{ id: 'order-topic', title: 'Robot policies', workspaceId: workspace.id, sessionId: 'order-session', notes: empty }],
    papers: ['Alpha', 'Beta'].map(title => ({ id: title.toLowerCase(), title, folder: title, topicIds: ['order-topic'],
      sessionId: `${title.toLowerCase()}-session`, pdfPath: '', repositoryUrl: '', ai: empty, learning: empty })),
  }))
  const controller = scaffold.ctx.workspaceController
  await controller.researchList()
  for (const id of ['order-session', 'alpha-session', 'ordinary-session']) {
    const agent = scaffold.ctx.agents.get(SessionId(id))!
    expect(scaffold.ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(expect.arrayContaining(['ui_capabilities', 'ui_read', 'ui_update']))
  }
  const agent = scaffold.ctx.agents.get(SessionId('order-session'))!
  const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  expect(prompts).toHaveLength(1)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompts[0]! }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(3)
  expect(results.every(event => event.data.message.isError !== true)).toBe(true)
  const catalog = await controller.researchList()
  expect(orderedTopicPapers(catalog, catalog.topics[0]!).map(paper => paper.id)).toEqual(['beta', 'alpha'])
  const index = JSON.parse(await readFile(join(root, 'agent-lib', 'library.json'), 'utf8')) as { topics: { paperOrder: string[] }[] }
  expect(index.topics[0]?.paperOrder).toEqual(['beta', 'alpha'])
  await assertFinalWorkspaceSnapshot(DIRECTORY, join(root, 'papers'))
})
