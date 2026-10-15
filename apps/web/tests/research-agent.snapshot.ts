/** The shipped Web Agent reads a paper and publishes Markdown through recorded tool calls. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { chromium } from 'playwright'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { assertFinalWorkspaceSnapshot, fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/research-notebook', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')

it('records research context, reads original pages, and saves the live AI notebook through the Agent loop', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true })
  onTestFinished(() => scaffold.close())
  const root = (await scaffold.ctx.workspaceController.researchList()).directory
  if (root === undefined) throw new Error('the library must be initialized')
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const paperSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('research-paper') })
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('research-topic') })
  const paperDirectory = join(root, 'papers', 'fixture-paper')
  await mkdir(join(paperDirectory, 'notes'), { recursive: true })
  await mkdir(join(root, 'topics', 'fixture-topic'), { recursive: true })
  await writeFile(join(paperDirectory, 'paper.pdf'), pdfFixture(3))
  await writeFile(join(paperDirectory, 'notes', 'ai.md'), '')
  await writeFile(join(paperDirectory, 'notes', 'learning.md'), '')
  await writeFile(join(root, 'topics', 'fixture-topic', 'notes.md'), '')
  const empty = { revision: 0, sha256: createHash('sha256').update('').digest('hex') }
  await writeFile(join(root, 'library.json'), JSON.stringify({ version: 1, revision: 1,
    topics: [{ id: 'fixture-topic', title: 'Robotics', workspaceId: workspace.id, sessionId: topicSession.sessionId, notes: empty }],
    papers: [{ id: 'fixture-paper', title: 'Fixture paper', topicIds: ['fixture-topic'], sessionId: paperSession.sessionId,
      pdfPath: 'paper.pdf', repositoryUrl: '', ai: empty, learning: empty, progress: '' }],
  }))
  await scaffold.ctx.workspaceController.researchList()
  expect(await readFile(join(paperDirectory, 'paper.md'), 'utf8'))
    .toBe('## Page 1\n\nSelectable PDF text\n\n## Page 2\n\nSelectable PDF text\n')
  const agent = scaffold.ctx.agents.get(paperSession.sessionId)
  if (agent === undefined) throw new Error('the paper Agent must exist')
  const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  expect(prompts).toHaveLength(1)
  const prompt = prompts[0]
  if (prompt === undefined) throw new Error('the fixture must own one user prompt')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  expect(results.every(event => event.data.message.isError !== true)).toBe(true)
  expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context'
    && event.data.content.some(block => block.type === 'text' && block.text.includes('Research library:')))).toBe(true)
  expect(await readFile(join(paperDirectory, 'notes', 'ai.md'), 'utf8'))
    .toBe('## Key idea\n\nThe original page contains selectable text (page 1).\n')
  expect(await readFile(join(paperDirectory, 'notes', 'learning.md'), 'utf8')).toBe('')
  await expect.poll(async () => (JSON.parse(await readFile(join(paperDirectory, 'session.json'), 'utf8')) as { events: unknown[] }).events.length)
    .toBe(events.length)
  await assertFinalWorkspaceSnapshot(DIRECTORY, paperDirectory, { ignoredRootEntries: ['session.json'] })
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('region', { name: 'Research library', exact: true }).getByRole('button', { name: 'Fixture paper', exact: true }).click()
  const workbench = page.locator('[data-research-workbench]')
  await workbench.getByRole('button', { name: 'AI notes', exact: true }).click()
  await workbench.getByRole('button', { name: 'Edit', exact: true }).click()
  expect(await workbench.getByRole('textbox', { name: 'AI notes', exact: true }).inputValue()).toContain('The original page contains selectable text')
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => workbench.getByRole('textbox', { name: 'AI notes', exact: true }).inputValue())
    .toContain('The original page contains selectable text')
})
