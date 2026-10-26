import { openResearchNote } from './research-files.helpers.ts'
/** Shipped Web reading flow: explicit translation, restored occurrence history and learning-note export. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import type { ResearchTranslation, ResearchTranslationHistoryEntry } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { translationPdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { assertFinalWorkspaceSnapshot, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/research-translation', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')

it('translates an explicit selection with five original sentences and retains it across reloads', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: false })
  onTestFinished(() => scaffold.close())
  const root = (await scaffold.ctx.workspaceController.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const paperSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('translation-paper-session') })
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, sessionId: SessionId('translation-topic-session') })
  let paperDirectory = join(root, 'papers', 'Translation paper')
  await mkdir(paperDirectory, { recursive: true }); await mkdir(join(root, 'topics', 'translation-topic'), { recursive: true })
  await writeFile(join(paperDirectory, 'paper_Translation.pdf'), translationPdfFixture())
  const empty = { revision: 0, sha256: createHash('sha256').update('').digest('hex') }
  await writeFile(join(root, 'agent-lib', 'library.json'), JSON.stringify({ version: 4, revision: 1,
    topics: [{ id: 'translation-topic', title: 'Translation study', workspaceId: workspace.id, sessionId: topicSession.sessionId, notes: empty }],
    papers: [{ id: 'translation-paper', title: 'Translation paper', folder: 'Translation paper', abbreviation: 'Translation', topicIds: ['translation-topic'],
      sessionId: paperSession.sessionId, pdfPath: 'paper_Translation.pdf', repositoryUrl: '', ai: empty, learning: empty }],
  }))
  const catalog = await scaffold.ctx.workspaceController.researchList()
  paperDirectory = catalog.papers.find(paper => paper.id === 'translation-paper')!.directory!
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'research-translation'))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await library.getByRole('button', { name: 'Translation paper', exact: true }).click()
  const workbench = page.locator('[data-research-workbench]')
  const select = async (): Promise<void> => {
    const item = workbench.locator('[data-pdf-page="1"] [data-pdf-text-item="2"]')
    await item.waitFor()
    await item.evaluate((span) => {
      const text = span.firstChild!
      const range = document.createRange(); range.setStart(text, 4); range.setEnd(text, 10)
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
      span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
    await page.getByRole('button', { name: 'Translate', exact: true }).waitFor()
  }
  await select()
  const agent = scaffold.ctx.agents.get(paperSession.sessionId)!
  expect(agent.session.snapshotEvents().some(event => event.type === 'research/translation-request')).toBe(false)
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  const card = page.getByRole('region', { name: 'Selection translation', exact: true })
  await card.getByText('机器人动作策略', { exact: true }).waitFor()
  await card.getByText('View context · PDF page 1', { exact: true }).click()
  expect(await card.getByText('First context sentence.', { exact: true }).isVisible()).toBe(true)
  expect(await card.getByText('Last context sentence.', { exact: true }).isVisible()).toBe(true)
  const saved = JSON.parse(await readFile(join(root, 'agent-lib', 'papers', 'translation-paper', 'translations.json'), 'utf8')) as { version: number; entries: ResearchTranslation[] }
  const expectedStore = JSON.parse(await readFile(join(DIRECTORY, 'runtime.expected', 'translations.json'), 'utf8')) as { version: number; entries: ResearchTranslation[] }
  expect({ version: saved.version, entries: saved.entries }).toEqual(expectedStore)
  expect(saved.entries).toHaveLength(1)
  const located: readonly ResearchTranslationHistoryEntry[] = await scaffold.ctx.workspaceController.researchListTranslations(
    catalog.papers[0]!.id, new AbortController().signal)
  expect(located).toHaveLength(1)
  expect(located[0]?.translation).toEqual(saved.entries[0])
  expect(located[0]?.selection).toMatchObject({ start: { page: 1, item: 2, offset: 4 }, end: { page: 1, item: 2, offset: 10 } })
  expect(located[0]?.selection?.rects?.length).toBeGreaterThan(0)
  expect(saved.entries[0]?.context.before).toEqual(['First context sentence.', 'Second context sentence.'])
  expect(saved.entries[0]?.context.after).toEqual(['Next context sentence.', 'Last context sentence.'])
  await expect(readFile(join(paperDirectory, 'notes', 'learning.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await card.getByRole('button', { name: 'Add to learning notes', exact: true }).click()
  await card.getByRole('button', { name: 'Added to notes', exact: true }).waitFor()
  expect(await readFile(join(paperDirectory, 'notes', 'learning.md'), 'utf8')).toContain('(../paper_Translation.pdf#page=1)')
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.screenshot({ path: '.artifacts/research-ui/translation-light.png' })
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  await card.getByRole('button', { name: 'Ask Agent', exact: true }).click()
  await card.getByText('The original and explanation are in the Agent composer. Add your question and send.', { exact: true }).waitFor()
  expect(await workbench.locator('[contenteditable="true"]').textContent()).toContain('First context sentence.')
  await workbench.getByRole('group', { name: 'Panel visibility', exact: true })
    .getByRole('button', { name: 'files', exact: true }).click()
  const notes = workbench.getByRole('region', { name: 'files', exact: true })
  await openResearchNote(workbench, 'learning')
  await expect.poll(() => notes.textContent()).toContain('机器人动作策略')
  await page.keyboard.press('Escape')
  const historyButton = workbench.getByRole('button', { name: 'View translation history: policy', exact: true })
  const history = page.getByRole('region', { name: 'Translation history', exact: true })
  await historyButton.waitFor()
  expect(await workbench.locator('[data-pdf-translation]').count()).toBeGreaterThan(0)
  await historyButton.click()
  await history.getByText('机器人动作策略', { exact: true }).waitFor()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'research/translation-request')).toHaveLength(1)
  await page.screenshot({ path: '.artifacts/research-ui/translation-history-light.png' })
  await page.keyboard.press('Escape')
  await history.waitFor({ state: 'hidden' })
  await page.reload({ waitUntil: 'load' })
  await library.getByRole('button', { name: 'Translation paper', exact: true }).click()
  await historyButton.waitFor()
  await historyButton.click()
  await history.getByText('机器人动作策略', { exact: true }).waitFor()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'research/translation-request')).toHaveLength(1)
  await page.keyboard.press('Escape')
  await history.waitFor({ state: 'hidden' })
  await select(); await page.getByRole('button', { name: 'Translate', exact: true }).click()
  await card.getByText('机器人动作策略', { exact: true }).waitFor()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'research/translation-request')).toHaveLength(1)
  await page.getByRole('button', { name: 'Pin', exact: true }).click()
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Dark', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await page.screenshot({ path: '.artifacts/research-ui/translation-dark.png' })
  await page.setViewportSize({ width: 375, height: 812 })
  await card.waitFor()
  const bounds = await card.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  expect(await page.locator('body').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '.artifacts/research-ui/translation-narrow.png' })
  await page.keyboard.press('Escape')
  await workbench.getByRole('group', { name: 'Reading panel', exact: true })
    .getByRole('button', { name: 'pdf viewer', exact: true }).click()
  await historyButton.scrollIntoViewIfNeeded()
  await historyButton.click()
  await history.getByText('机器人动作策略', { exact: true }).waitFor()
  const historyBounds = await history.boundingBox()
  expect(historyBounds).not.toBeNull()
  expect(historyBounds!.x).toBeGreaterThanOrEqual(0)
  expect(historyBounds!.x + historyBounds!.width).toBeLessThanOrEqual(375)
  expect(historyBounds!.y).toBeGreaterThanOrEqual(0)
  expect(historyBounds!.y + historyBounds!.height).toBeLessThanOrEqual(812)
  await page.screenshot({ path: '.artifacts/research-ui/translation-history-narrow-dark.png' })
  await page.locator('body').dispatchEvent('pointerdown')
  await history.waitFor({ state: 'hidden' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'research/translation-request')).toHaveLength(1)
  const events = agent.session.snapshotEvents()
  expect(events.some(event => event.type === 'user/message' || event.type === 'assistant/message')).toBe(false)
  const raw = [JSON.stringify({ type: 'session', ...agent.session.header, delegationDepth: agent.session.header.delegationDepth ?? 0 }),
    ...events.map(event => JSON.stringify(event))].join('\n') + '\n'
  const actual = normalizeSessionSnapshots([raw], { cwd: agent.session.header.cwd!, sessionIds: [String(agent.id)] })[0]!
  if (webSnapshotMode() === 'refresh') {
    const header = { type: 'session', ...agent.session.header, id: '{{session:1}}', cwd: '{{cwd}}', createdAt: 0,
      delegationDepth: agent.session.header.delegationDepth ?? 0 }
    const projected = events.map(({ seq: _seq, time: _time, ...event }) => event)
    await writeFile(FIXTURE, [header, ...projected].map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  const expected = await readFile(FIXTURE, 'utf8')
  expect(actual).toBe(normalizeSessionSnapshots([expected], { cwd: '{{cwd}}', sessionIds: ['{{session:1}}'] })[0])
  await assertFinalWorkspaceSnapshot(DIRECTORY, paperDirectory, {
    ignoredRootEntries: ['paper_Translation.pdf', 'paper_Translation.md', 'paper_Translation.json'],
  })
  await writeFile('.artifacts/research-ui/translation-audit.jsonl', raw)
})
