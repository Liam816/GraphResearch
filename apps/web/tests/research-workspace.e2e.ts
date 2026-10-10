/** Real Loader research navigation, PDF factory, independent sessions, and durable notebooks. */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/research-workspace/paper.expected.md', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../.artifacts/research-ui', import.meta.url))

it('opens topic and paper sessions, restores folded panels and drafts, and persists notes after reload', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await writeFile(join(scaffold.workspaceCwd, 'paper.pdf'), pdfFixture())
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1800, height: 1080 })
  const console = watchConsole(page)
  const clientErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') clientErrors.push(message.text()) })
  onTestFailed(() => { process.stderr.write(`${JSON.stringify({ ...console, clientErrors })}\n`) })
  onTestFailed(() => saveFailureShot(page, 'research-workspace'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await library.getByRole('button', { name: 'New topic', exact: true }).click()
  const topicForm = page.getByRole('dialog', { name: 'New topic', exact: true })
  await topicForm.getByLabel('Title', { exact: true }).fill('Robot VLA')
  await topicForm.getByRole('button', { name: 'Create', exact: true }).click()
  const workbench = page.locator('[data-research-workbench]')
  await workbench.getByRole('heading', { name: 'Robot VLA', exact: true }).waitFor()
  expect(await workbench.getByRole('region', { name: 'Original PDF', exact: true }).count()).toBe(0)

  const addPaper = async (title: string): Promise<void> => {
    await library.getByRole('button', { name: 'Add paper', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add paper', exact: true })
    await form.getByLabel('Title', { exact: true }).fill(title)
    await form.getByLabel('PDF file path', { exact: true }).fill('paper.pdf')
    await form.getByRole('button', { name: 'Create', exact: true }).click()
    await expect.poll(() => workbench.locator('header strong').textContent()).toBe(title)
  }
  await addPaper('RT-2')
  await workbench.getByRole('img', { name: 'PDF page 1', exact: true }).waitFor()
  const notes = workbench.getByRole('textbox', { name: 'Learning notes', exact: true })
  await notes.fill('# RT-2\n\nUnderstand the action token representation.')
  await workbench.getByRole('button', { name: 'Save notes', exact: true }).click()
  await workbench.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor()
  await expect.poll(() => workbench.getByRole('button', { name: 'Save notes', exact: true }).isDisabled()).toBe(true)
  await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-research-workbench]', scaffold.workspaceCwd), webSnapshotMode())
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, 'paper-light.png') })

  await notes.fill('Unsaved RT-2 draft')
  await addPaper('OpenVLA')
  await workbench.getByRole('textbox', { name: 'Learning notes', exact: true }).fill('OpenVLA draft')
  await library.getByRole('button', { name: 'RT-2', exact: true }).click()
  await expect.poll(() => notes.inputValue()).toBe('Unsaved RT-2 draft')
  for (const panel of ['Agent chat', 'Original PDF', 'Reading notes']) {
    await workbench.getByRole('button', { name: `Collapse ${panel}`, exact: true }).click()
  }
  await workbench.getByRole('heading', { name: 'All panels are collapsed' }).waitFor()
  await workbench.getByRole('button', { name: 'Restore three panels', exact: true }).last().click()
  await expect.poll(async () => (await workbench.getByRole('img', { name: 'PDF page 1', exact: true }).boundingBox())?.width).toBeGreaterThan(100)
  await expect.poll(() => notes.inputValue()).toBe('Unsaved RT-2 draft')
  await notes.fill('# RT-2\n\nUnderstand the action token representation.')
  await workbench.getByRole('button', { name: 'Save notes', exact: true }).click()
  await workbench.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor()
  await expect.poll(() => workbench.getByRole('button', { name: 'Save notes', exact: true }).isDisabled()).toBe(true)

  await workbench.getByRole('button', { name: 'Reference papers', exact: true }).click()
  const references = page.getByRole('dialog', { name: 'Reference papers', exact: true })
  await references.getByRole('checkbox', { name: 'OpenVLA', exact: true }).check()
  await references.getByRole('button', { name: 'Insert references', exact: true }).click()
  await workbench.getByText('References added to the composer', { exact: true }).waitFor()
  const catalog = await scaffold.ctx.workspaceController.researchList()
  expect(new Set([...catalog.topics.map(item => item.sessionId), ...catalog.papers.map(item => item.sessionId)]).size).toBe(3)
  expect(catalog.papers.find(item => item.title === 'RT-2')?.learning.text).toContain('action token')

  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Dark', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
  await page.screenshot({ path: join(SHOTS, 'paper-dark.png') })
  await page.reload({ waitUntil: 'load' })
  await workbench.waitFor()
  await expect.poll(() => notes.inputValue()).toContain('action token')
  await page.setViewportSize({ width: 760, height: 900 })
  await library.getByRole('button', { name: 'Reading notes', exact: true }).first().click()
  await expect.poll(() => notes.isVisible()).toBe(true)
  expect(await workbench.getByRole('region', { name: 'Agent chat', exact: true }).isVisible()).toBe(false)
  await page.screenshot({ path: join(SHOTS, 'paper-narrow.png') })
  expect(console.pageErrors).toEqual([])
}, 120_000)
