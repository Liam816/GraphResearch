/** Shipped Web composition: native PDF text selection, marker persistence, zoom, and deletion. */
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/research-workspace/highlight-toolbar.expected.md', import.meta.url))

it('highlights selected original text across pages and restores the markers after reload and resizing', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  await writeFile(join(scaffold.workspaceCwd, 'highlight.pdf'), pdfFixture(3))
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'research-highlights'))
  await page.setViewportSize({ width: 1800, height: 1080 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await library.getByRole('button', { name: 'New topic', exact: true }).click()
  const topicForm = page.getByRole('dialog', { name: 'New topic', exact: true })
  await topicForm.getByLabel('Title', { exact: true }).fill('Highlight study')
  await topicForm.getByRole('button', { name: 'Create', exact: true }).click()
  await topicForm.waitFor({ state: 'hidden' })
  const workbench = page.locator('[data-research-workbench]')
  await workbench.getByRole('heading', { name: 'Highlight study', exact: true }).waitFor()
  await library.getByRole('button', { name: 'Add paper to Highlight study', exact: true }).click()
  const paperForm = page.getByRole('dialog', { name: 'Add paper', exact: true })
  await paperForm.getByLabel('Title', { exact: true }).fill('Selected original')
  await paperForm.getByLabel('PDF file path', { exact: true }).fill(join(scaffold.workspaceCwd, 'highlight.pdf'))
  await paperForm.getByRole('button', { name: 'Create', exact: true }).click()
  await paperForm.waitFor({ state: 'hidden' })
  const text = workbench.locator('[data-pdf-page="1"] [data-pdf-text] span').filter({ hasText: 'Selectable PDF text' })
  await text.waitFor()
  const box = await text.boundingBox()
  if (box === null) throw new Error('the original text must be selectable')
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  const toolbar = page.getByRole('toolbar', { name: 'Choose highlight color', exact: true })
  await toolbar.waitFor()
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.screenshot({ path: '.artifacts/research-ui/highlight-toolbar-light.png' })
  expect(await toolbar.getByRole('button').count()).toBe(7)
  await compareOrRefreshGolden(EXPECTED,
    await captureStableAria(page, '[role="toolbar"][aria-label="Choose highlight color"]', scaffold.workspaceCwd), webSnapshotMode())
  await toolbar.getByRole('button', { name: 'Yellow highlight', exact: true }).click()
  await toolbar.waitFor({ state: 'hidden' })
  const marker = workbench.locator('[data-pdf-highlight]')
  await expect.poll(() => marker.count()).toBe(1)
  const paper = (await scaffold.ctx.workspaceController.researchList()).papers[0]
  if (paper === undefined || paper.directory === undefined) throw new Error('the created paper must be managed')
  expect(paper.highlights?.[0]?.text).toContain('Selectable PDF text')
  expect((JSON.parse(await readFile(join(paper.directory, '..', '..', 'agent-lib', 'papers', paper.id, 'metadata.json'), 'utf8')) as { highlights: typeof paper.highlights }).highlights).toEqual(paper.highlights)

  // Select across the already rendered page text with the browser's actual Range geometry.
  await workbench.locator('[data-pdf-page="2"] [data-pdf-text] span').waitFor()
  await workbench.locator('[data-pdf-preview]').evaluate((root) => {
    const first = root.querySelector('[data-pdf-page="1"] [data-pdf-text] span')?.firstChild
    const second = root.querySelector('[data-pdf-page="2"] [data-pdf-text] span')?.firstChild
    if (first === undefined || first === null || second === undefined || second === null) throw new Error('both original pages must have text')
    const range = document.createRange()
    range.setStart(first, 0); range.setEnd(second, second.textContent!.length)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    second.parentElement!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await toolbar.waitFor()
  const toolbarBox = await toolbar.boundingBox()
  if (toolbarBox === null) throw new Error('the marker toolbar must be visible')
  expect(toolbarBox.x).toBeGreaterThanOrEqual(0)
  expect(toolbarBox.y).toBeGreaterThanOrEqual(0)
  expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(1800)
  await toolbar.getByRole('button', { name: 'Blue highlight', exact: true }).click()
  await expect.poll(() => marker.count()).toBe(3)
  const selected = (await scaffold.ctx.workspaceController.researchList()).papers[0]?.highlights
  expect(selected?.[1]?.rects.map(rect => rect.page)).toEqual([1, 2])

  await page.reload({ waitUntil: 'load' })
  await library.getByRole('button', { name: 'Selected original', exact: true }).click()
  await expect.poll(() => marker.count()).toBe(3)
  await text.waitFor()
  const aligned = async (): Promise<void> => {
    await expect.poll(async () => {
      const geometry = await workbench.locator('[data-pdf-page="1"]').evaluate((root) => {
        const range = document.createRange()
        range.selectNodeContents(root.querySelector('[data-pdf-text] span')!.firstChild!)
        const text = range.getBoundingClientRect()
        const marker = root.querySelector('[data-pdf-highlight]')!.getBoundingClientRect()
        return { text: { x: text.x, y: text.y, width: text.width, height: text.height },
          marker: { x: marker.x, y: marker.y, width: marker.width, height: marker.height } }
      })
      return Math.max(Math.abs(geometry.text.x - geometry.marker.x), Math.abs(geometry.text.y - geometry.marker.y),
        Math.abs(geometry.text.width - geometry.marker.width))
    }).toBeLessThan(3)
  }
  await aligned()
  const pdf = workbench.locator('[data-research-panel="pdf"]')
  await pdf.getByRole('button', { name: 'Choose zoom', exact: true }).focus()
  await pdf.getByRole('button', { name: 'Choose zoom', exact: true }).click()
  await page.getByRole('menuitem', { name: '150%', exact: true }).click()
  await expect.poll(() => pdf.locator('[data-document-zoom-frame]').getAttribute('data-document-zoom-mode')).toBe('fixed')
  await aligned()
  await page.setViewportSize({ width: 1280, height: 900 })
  await aligned()
  await page.locator('body').evaluate((node) => { node.setAttribute('data-ds-dark-theme', '') })
  await aligned()
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.screenshot({ path: '.artifacts/research-ui/highlights-dark.png' })

  await marker.last().scrollIntoViewIfNeeded()
  const marked = await marker.last().boundingBox()
  const viewport = await pdf.locator('[data-document-zoom-scrollport]').boundingBox()
  if (marked === null || viewport === null) throw new Error('the restored highlight must be visible')
  const left = Math.max(marked.x, viewport.x), right = Math.min(marked.x + marked.width, viewport.x + viewport.width)
  const top = Math.max(marked.y, viewport.y), bottom = Math.min(marked.y + marked.height, viewport.y + viewport.height)
  expect(right).toBeGreaterThan(left); expect(bottom).toBeGreaterThan(top)
  await page.mouse.click((left + right) / 2, (top + bottom) / 2)
  await page.getByRole('toolbar', { name: 'Highlight actions', exact: true }).getByRole('button', { name: 'Remove highlight', exact: true }).click()
  await expect.poll(() => marker.count()).toBe(1)
  const remaining = (await scaffold.ctx.workspaceController.researchList()).papers[0]?.highlights
  expect(remaining).toHaveLength(1)
  const keyboardRemove = workbench.getByRole('button', { name: /^Remove highlight:/ })
  await keyboardRemove.focus(); await keyboardRemove.press('Enter')
  await expect.poll(() => marker.count()).toBe(0)
  expect((await scaffold.ctx.workspaceController.researchList()).papers[0]?.highlights).toEqual([])
})
