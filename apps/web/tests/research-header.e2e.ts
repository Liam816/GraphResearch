/** Centered reading controls and Agent-scoped reference menus share the existing composer flow. */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('centers reading controls and opens paper references from Topic and paper Agent menus', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const root = (await controller.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const session = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: 'Robotics and vision-language-action policies',
    workspaceId: workspace.id, sessionId: session.sessionId })).topics[0]!
  const title = 'OpenVLA: an open vision-language-action model for generalist robot learning'
  await controller.researchImportPaper({ topicId: topic.id, title }, new AbortController().signal)
  await controller.researchImportPaper({ topicId: topic.id, title: 'RT-2' }, new AbortController().signal)
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1800, height: 1080 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  const workbench = page.locator('[data-research-workbench]')
  const header = workbench.locator('> header')
  await library.getByRole('button', { name: topic.title, exact: true }).click()
  expect(await header.getByRole('button', { name: 'Reference papers', exact: true }).count()).toBe(0)
  await workbench.getByRole('button', { name: 'Actions for agent', exact: true }).click()
  expect(await page.getByRole('menuitem', { name: 'Move left', exact: true }).count()).toBe(0)
  await page.getByRole('menuitem', { name: 'Reference papers', exact: true }).click()
  const references = page.getByRole('dialog', { name: 'Reference papers', exact: true })
  await references.getByRole('checkbox', { name: title, exact: true }).check()
  await references.getByRole('button', { name: 'Insert references', exact: true }).click()
  await references.waitFor({ state: 'hidden' })
  await workbench.getByText('References added to the composer', { exact: true }).waitFor()
  await expect.poll(() => workbench.locator('[data-composer-input]').textContent()).not.toBe('')

  await library.getByRole('button', { name: title, exact: true }).click()
  const centered = async (groupName: string) => {
    const group = header.getByRole('group', { name: groupName, exact: true })
    await expect.poll(async () => {
      const controls = await group.boundingBox(), bounds = await header.boundingBox()
      return controls === null || bounds === null ? Infinity : Math.abs(controls.x + controls.width / 2 - bounds.x - bounds.width / 2)
    }).toBeLessThan(2)
  }
  await centered('Panel visibility')
  expect(await header.getByRole('button', { name: 'Reference papers', exact: true }).count()).toBe(0)
  const agent = workbench.getByRole('region', { name: 'agent', exact: true })
  await agent.getByRole('button', { name: 'Actions for agent', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Reference papers', exact: true }).click()
  expect(await references.getByRole('checkbox', { name: title, exact: true }).count()).toBe(0)
  await references.getByRole('checkbox', { name: 'RT-2', exact: true }).check()
  await references.getByRole('button', { name: 'Insert references', exact: true }).click()
  await references.waitFor({ state: 'hidden' })
  await workbench.getByText('References added to the composer', { exact: true }).waitFor()
  await expect.poll(() => agent.locator('[data-composer-input]').textContent()).not.toBe('')
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.screenshot({ path: '.artifacts/research-ui/centered-panel-controls-light.png' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: '.artifacts/research-ui/centered-panel-controls-dark.png' })

  await page.setViewportSize({ width: 1000, height: 800 })
  await centered('Reading panel')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport)
    await centered('Reading panel')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await agent.getByRole('button', { name: 'Actions for agent', exact: true }).click()
    const menu = page.getByRole('menu')
    const bounds = await menu.boundingBox()
    expect(bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width).toBe(true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
  }
})
