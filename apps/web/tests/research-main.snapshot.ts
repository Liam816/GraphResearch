/** The ordinary main Agent reads across the library and commits Topic creation and order to the live directory. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts,
  normalizedToolSchemas, normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { assertFinalWorkspaceSnapshot, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  normalizeWebSessionVolatiles, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/research-main', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')
const OVERRIDE = join(DIRECTORY, 'replay.override.json')
const TOPIC_NOTE = '# Existing direction\n\nCompare action policies across the library.\n'
const AI_NOTE = '# Existing insight\n\nThe policy returns a seven-dimensional action.\n'
const CODE = 'def predict_action(observation):\n    return [0.0] * 7\n'

/** @param text - captured model-visible text. @param identities - confirmed catalog identities. @returns typed relationship tokens. */
function retainIdentities(text: string, identities: readonly (readonly [string, string])[]): string {
  return identities.reduce((value, [id, token]) => value.split(id).join(token), text)
}

it('lets the main Agent read every research entity, create a Topic and persist its position in the live directory', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: OVERRIDE, compareReplaySession: false })
  onTestFinished(() => scaffold.close())
  const root = (await scaffold.ctx.workspaceController.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('main-existing-topic') })
  const paperSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('main-existing-paper') })
  const main = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('main-library-session') })
  const paperDirectory = join(root, 'papers', 'Existing')
  await mkdir(join(paperDirectory, 'notes'), { recursive: true }); await mkdir(join(paperDirectory, 'src'), { recursive: true })
  await mkdir(join(root, 'topics', 'existing-topic'), { recursive: true })
  await writeFile(join(root, 'topics', 'existing-topic', 'notes.md'), TOPIC_NOTE)
  await writeFile(join(paperDirectory, 'notes', 'ai.md'), AI_NOTE)
  await writeFile(join(paperDirectory, 'src', 'policy.py'), CODE)
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const empty = { revision: 0, sha256: digest('') }
  await writeFile(join(root, 'agent-lib', 'library.json'), JSON.stringify({ version: 4, revision: 1,
    topics: [{ id: 'existing-topic', title: 'Existing topic', workspaceId: workspace.id,
      sessionId: topicSession.sessionId, notes: { revision: 1, sha256: digest(TOPIC_NOTE) } }],
    papers: [{ id: 'existing-paper', title: 'Existing', folder: 'Existing', topicIds: ['existing-topic'],
      sessionId: paperSession.sessionId, pdfPath: '', repositoryUrl: '', ai: { revision: 1, sha256: digest(AI_NOTE) }, learning: empty }],
  }))
  await scaffold.ctx.workspaceController.researchList()
  const agent = scaffold.ctx.agents.get(main.sessionId)!
  expect(scaffold.ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
    'research_context', 'research_create_topic', 'research_list_files', 'research_read_file', 'research_read_paper', 'research_read_conversation',
    'ui_capabilities', 'ui_read', 'ui_update',
  ]))
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'research-main'))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await library.getByRole('button', { name: 'Existing topic', exact: true }).waitFor()
  const locationBefore = page.url()
  const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  expect(prompts).toHaveLength(1)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompts[0]! }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(8)
  expect(results.every(event => event.data.message.isError !== true)).toBe(true)
  const textOf = (index: number) => results[index]?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  expect(textOf(0)).toContain(AI_NOTE.replaceAll('\n', '\\n'))
  expect(textOf(0)).toContain(TOPIC_NOTE.replaceAll('\n', '\\n'))
  expect(textOf(1)).toContain('policy.py')
  expect(textOf(2)).toContain(CODE.replaceAll('\n', '\\n'))
  expect(textOf(3)).toContain(TOPIC_NOTE.replaceAll('\n', '\\n'))
  expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context'
    && event.data.content.some(block => block.type === 'text' && block.text.includes('"scope":"library"')
      && block.text.includes('existing-topic') && block.text.includes('existing-paper')))).toBe(true)
  const catalog = await scaffold.ctx.workspaceController.researchList()
  const created = catalog.topics.find(topic => topic.title === 'Robot VLA')!
  expect(created).toBeDefined()
  expect(catalog.topics.map(topic => topic.title)).toEqual(['Robot VLA', 'Existing topic'])
  expect(created.sessionId).not.toBe(main.sessionId)
  expect(catalog.topics.some(topic => topic.sessionId === main.sessionId)).toBe(false)
  expect(catalog.papers.some(paper => paper.sessionId === main.sessionId)).toBe(false)
  expect(scaffold.ctx.sessions.get(created.sessionId)).toBeDefined()
  expect((await stat(join(root, 'topics', created.id))).isDirectory()).toBe(true)
  const index = JSON.parse(await readFile(join(root, 'agent-lib', 'library.json'), 'utf8')) as { topics: { id: string }[] }
  expect(index.topics.map(topic => topic.id)).toEqual([created.id, 'existing-topic'])
  const topicTitles = library.getByRole('navigation', { name: 'Research library', exact: true })
    .locator('> ul > li > [data-dsh-action-row] > button[data-dsh-action-label]')
  await expect.poll(() => topicTitles.allTextContents()).toEqual(['Robot VLA', 'Existing topic'])
  expect(page.url()).toBe(locationBefore)
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => topicTitles.allTextContents()).toEqual(['Robot VLA', 'Existing topic'])
  await assertFinalWorkspaceSnapshot(DIRECTORY, join(root, 'papers'))
  const identities: readonly (readonly [string, string])[] = [
    [workspace.id, '{{id:1}}'], [created.id, '{{id:2}}'], [created.sessionId, '{{session:2}}'],
  ]
  const raw = [JSON.stringify({ type: 'session', ...agent.session.header, delegationDepth: agent.session.header.delegationDepth ?? 0 }),
    ...events.map(event => JSON.stringify(event))].join('\n') + '\n'
  const captured = retainIdentities(normalizeWebSessionVolatiles(raw, root), identities).split(scaffold.harnessHome).join('{{harnessHome}}')
  const context = { cwd: root, sessionIds: [String(agent.id)] }
  const actual = normalizeSessionSnapshots([captured], context)[0]!
  const mode = webSnapshotMode()
  if (mode === 'refresh') {
    const [header, ...rows] = actual.trimEnd().split('\n')
    await writeFile(FIXTURE, [JSON.stringify({ ...JSON.parse(header!), version: agent.session.header.version }), ...rows].join('\n') + '\n')
  }
  const expected = await readFile(FIXTURE, 'utf8')
  expect(actual).toBe(normalizeSessionSnapshots([expected], { cwd: '{{cwd}}', sessionIds: ['{{session:1}}'] })[0])
  const promptsSnapshot = normalizedSystemPrompts(captured, context).map(prompt => prompt.split(REPO_ROOT).join('{{sourceRoot}}')
    .split(scaffold.baseUrl).join('{{webUrl}}'))
  await compareOrRefreshGolden(join(DIRECTORY, 'system-prompt.expected.md'),
    formatSystemPromptSnapshot(promptsSnapshot[0]!, promptsSnapshot.slice(1)).trimEnd(), mode)
  const schemas = normalizedToolSchemas(captured, context)
  await compareOrRefreshGolden(join(DIRECTORY, 'tool-schemas.expected.json'),
    formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1)).trimEnd(), mode)
})
