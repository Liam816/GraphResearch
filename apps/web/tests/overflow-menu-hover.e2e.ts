/** Assembled overflow menus share one row fill and retain independent menu targets. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const SHOTS = fileURLToPath(new URL('../../../.artifacts/overflow-menu-hover', import.meta.url))

async function colors(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node)
    return { background: style.backgroundColor, radius: style.borderRadius }
  })
}

async function hoverRow(trigger: Locator, label: Locator): Promise<Locator> {
  const row = trigger.locator('xpath=ancestor::*[@data-dsh-action-row][1]')
  await label.hover()
  await expect.poll(async () => (await colors(row)).background).not.toBe('rgba(0, 0, 0, 0)')
  const fill = (await colors(row)).background
  expect((await colors(trigger)).background).toBe('rgba(0, 0, 0, 0)')
  if (await label.getAttribute('data-dsh-action-label') !== null) {
    expect((await colors(label)).background).toBe('rgba(0, 0, 0, 0)')
  }
  await trigger.hover()
  expect((await colors(row)).background).toBe(fill)
  await expect.poll(async () => (await colors(trigger)).background).not.toBe('rgba(0, 0, 0, 0)')
  expect((await colors(trigger)).radius).toBe('8px')
  const outer = await row.boundingBox(), inner = await trigger.boundingBox()
  if (outer === null || inner === null) throw new Error('Both hover surfaces must be visible')
  expect(inner.x).toBeGreaterThanOrEqual(outer.x)
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1)
  expect(inner.y).toBeGreaterThanOrEqual(outer.y)
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 1)
  return row
}

it('groups overflow hover across research rows, conversation entries and header controls in both themes', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const directory = (await controller.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(directory)
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: '轻量化模型训练框架设计', workspaceId: workspace.id,
    sessionId: topicSession.sessionId })).topics[0]!
  const imported = await controller.researchImportPaper({ topicId: topic.id, title: 'VLA model architecture' }, new AbortController().signal)
  const paper = (await controller.researchList()).papers.find(item => item.id === imported.paperId)!
  const additional = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  await controller.researchCreateConversation({ paperId: paper.id, sessionId: additional.sessionId })
  await controller.researchUpdateConversation({ paperId: paper.id, sessionId: paper.sessionId, title: 'Overview', expectedTitle: '' })
  await controller.researchUpdateConversation({ paperId: paper.id, sessionId: additional.sessionId, title: 'Method details', expectedTitle: '' })
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'overflow-menu-hover'))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  const paperLabel = library.getByRole('button', { name: paper.title, exact: true })
  await paperLabel.click()
  await page.getByRole('button', { name: 'Switch conversation', exact: true }).waitFor()
  await mkdir(SHOTS, { recursive: true })

  for (const theme of ['light', 'dark'] as const) {
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click()
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    const topicLabel = library.getByRole('button', { name: topic.title, exact: true })
    const topicMenu = library.getByRole('button', { name: `Topic actions for ${topic.title}`, exact: true })
    await hoverRow(topicMenu, topicLabel)
    await page.screenshot({ path: join(SHOTS, `topic-${theme}.png`) })
    await topicMenu.click()
    await page.getByRole('menuitem', { name: 'Rename topic', exact: true }).waitFor()
    expect((await colors(topicMenu)).background).not.toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Escape')
    expect(await page.locator('[data-research-workbench] > header strong').textContent()).toBe(paper.title)

    const paperMenu = library.getByRole('button', { name: `Actions for ${paper.title}`, exact: true })
    const paperRow = await hoverRow(paperMenu, paperLabel)
    await page.screenshot({ path: join(SHOTS, `paper-${theme}.png`) })
    await page.mouse.move(1200, 900)
    expect((await colors(paperRow)).background).not.toBe('rgba(0, 0, 0, 0)')
    expect((await colors(paperLabel)).background).toBe('rgba(0, 0, 0, 0)')
    expect((await colors(paperMenu)).background).toBe('rgba(0, 0, 0, 0)')

    const libraryMenu = library.getByRole('button', { name: 'Paper library directory', exact: true })
    const location = libraryMenu.locator('xpath=ancestor::*[@data-dsh-action-row][1]').locator('p')
    await hoverRow(libraryMenu, location)
    for (const name of ['agent', 'pdf viewer']) {
      const panel = page.getByRole('region', { name, exact: true })
      await hoverRow(panel.getByRole('button', { name: `Arrange ${name}`, exact: true }), panel.locator('strong').first())
    }
    await page.getByRole('button', { name: 'Switch conversation', exact: true }).click()
    const popup = page.getByRole('dialog', { name: 'Paper conversations', exact: true })
    await hoverRow(popup.getByRole('button', { name: 'Conversation actions for Overview', exact: true }),
      popup.getByRole('button', { name: 'Overview Current', exact: true }))
    await page.screenshot({ path: join(SHOTS, `conversations-${theme}.png`) })
    await page.keyboard.press('Escape')
  }
  await paperLabel.focus()
  await page.keyboard.press('Tab')
  const paperMenu = library.getByRole('button', { name: `Actions for ${paper.title}`, exact: true })
  await expect.poll(() => paperMenu.evaluate(node => node === document.activeElement)).toBe(true)
  expect((await colors(paperMenu)).background).not.toBe('rgba(0, 0, 0, 0)')
  await paperMenu.press('Enter')
  await page.getByRole('menuitem', { name: 'Delete paper', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  expect(await page.getByRole('dialog', { name: /^Delete / }).count()).toBe(0)
  expect(errors.pageErrors).toEqual([])
})

it('groups native rows, Session and task headers, and the desktop account launcher', async () => {
  const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const session = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const agent = scaffold.ctx.agents.get(session.sessionId)!
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Reading questions' }],
    source: { kind: 'user' } }), { surfaceOp: 'append' })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  agent.session.append('session/title', { title: 'Reading questions', messageSeqs: [], source: { kind: 'user' } })
  await scaffold.ctx.schedule.create(session.sessionId, {
    prompt: 'Review research notes', title: 'Research review', after_seconds: 86_400,
  })
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'overflow-menu-secondary'))
  await page.addInitScript((id) => {
    Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
  }, session.sessionId)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const more = page.getByRole('button', { name: 'More actions', exact: true })
  await more.waitFor()
  const row = more.locator('xpath=ancestor::*[@data-dsh-action-row][1]')
  await hoverRow(more, row.locator('nav').first())
  await more.click()
  await page.getByRole('menuitem', { name: 'Download session log', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  const account = page.locator('button[data-dsh-action-row][data-signed-out=true]')
  const glyph = account.locator('[data-dsh-action-menu]')
  await hoverRow(glyph, account.locator('span').last())
  await glyph.click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  // Legacy navigation stays hidden in production; expose it only in this private fixture.
  await page.addStyleTag({ content: '[data-workspace-browser] > details { display: block; }' })
  for (const key of [`workspace:${workspace.id}`, `session:${session.sessionId}`]) {
    const nativeRow = page.locator(`[data-row-key="${key}"]`)
    const title = key.startsWith('workspace:')
      ? nativeRow.locator('span').filter({ hasText: /\S/u }).last()
      : nativeRow.getByText('Reading questions', { exact: true })
    await hoverRow(nativeRow.locator('[data-dsh-action-menu]'), title)
    if (key.startsWith('workspace:') && await nativeRow.getAttribute('aria-expanded') === 'false') await title.click()
  }
  await page.locator('[data-schedule-reminder-entry]').click()
  const taskMore = page.getByRole('button', { name: 'Automation task actions', exact: true })
  const taskRow = taskMore.locator('xpath=ancestor::*[@data-dsh-action-row][1]')
  await hoverRow(taskMore, taskRow.getByRole('tab', { name: 'Rules', exact: true }))
  await taskMore.click()
  await page.getByRole('menuitem', { name: 'Delete task', exact: true }).waitFor()
  await page.keyboard.press('Escape')
})
