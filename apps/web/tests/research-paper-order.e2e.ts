/** Real pointer and keyboard sorting share durable Topic state with all Agent scopes. */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'
import { orderedTopicPapers } from '../../../packages/api/workspace-controller/src/research-order.ts'

it('drags papers within a Topic, restores their order and shares updates with another browser', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const root = (await controller.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const session = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: 'Robot policies', workspaceId: workspace.id, sessionId: session.sessionId })).topics[0]!
  const papers = []
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    const imported = await controller.researchImportPaper({ topicId: topic.id, title }, new AbortController().signal)
    papers.push(imported.catalog.papers.find(item => item.id === imported.paperId)!)
  }
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await library.getByRole('button', { name: 'Beta', exact: true }).click()
  const selected = library.getByRole('button', { name: 'Beta', exact: true })
  await expect.poll(() => selected.getAttribute('aria-current')).toBe('page')
  const order = () => library.locator('[data-research-paper] [data-dsh-action-label]').allTextContents()
  const grip = library.getByRole('button', { name: 'Reorder paper: Gamma', exact: true })
  const first = library.locator(`[data-research-paper="${papers[0]!.id}"]`)
  await grip.hover()
  const start = await grip.boundingBox(), end = await first.boundingBox()
  if (start === null || end === null) throw new Error('Paper drag targets must be visible')
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 - 8, { steps: 3 })
  await page.mouse.move(end.x + 32, end.y + end.height / 3, { steps: 12 })
  await expect.poll(() => first.getAttribute('data-drop-edge')).toBe('before')
  await page.mouse.up()
  await expect.poll(order).toEqual(['Gamma', 'Alpha', 'Beta'])
  expect(await selected.getAttribute('aria-current')).toBe('page')
  await page.reload({ waitUntil: 'load' })
  await expect.poll(order).toEqual(['Gamma', 'Alpha', 'Beta'])

  const keyboard = library.getByRole('button', { name: 'Reorder paper: Gamma', exact: true })
  const alpha = library.locator(`[data-research-paper="${papers[0]!.id}"]`)
  await keyboard.focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => alpha.getAttribute('data-drop-edge')).toBe('after')
  await page.keyboard.press('Escape')
  expect(await order()).toEqual(['Gamma', 'Alpha', 'Beta'])
  await page.reload({ waitUntil: 'load' })
  await expect.poll(order).toEqual(['Gamma', 'Alpha', 'Beta'])
  await keyboard.focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => alpha.getAttribute('data-drop-edge')).toBe('after')
  await page.keyboard.press('Space')
  await expect.poll(order).toEqual(['Alpha', 'Gamma', 'Beta'])

  const second = await newEnglishPage(browser)
  await second.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const secondOrder = () => second.locator('[data-research-paper] [data-dsh-action-label]').allTextContents()
  await expect.poll(secondOrder).toEqual(['Alpha', 'Gamma', 'Beta'])
  const catalog = await controller.researchList()
  await controller.researchReorderPapers({ topicId: topic.id,
    expectedPaperIds: orderedTopicPapers(catalog, catalog.topics[0]!).map(paper => paper.id),
    paperIds: papers.map(paper => paper.id) })
  await expect.poll(order).toEqual(['Alpha', 'Beta', 'Gamma'])
  await expect.poll(secondOrder).toEqual(['Alpha', 'Beta', 'Gamma'])
  await library.getByRole('textbox', { name: 'Search topics or papers', exact: true }).fill('Alpha')
  expect(await library.getByRole('button', { name: 'Reorder paper: Alpha', exact: true }).isDisabled()).toBe(true)
  await library.getByRole('textbox', { name: 'Search topics or papers', exact: true }).fill('')
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: '.artifacts/research-ui/paper-order-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: '.artifacts/research-ui/paper-order-light.png' })
})
