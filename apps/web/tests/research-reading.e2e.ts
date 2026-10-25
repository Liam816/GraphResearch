import { openResearchNote } from './research-files.helpers.ts'
/** Paper-local PDF, notebook, and older transcript positions survive switches and browser reloads. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

it('returns each paper to its PDF anchor, zoom, notebook selection and original conversation row', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await scaffold.ctx.workspaceController.researchCreateTopic({ title: 'Reading memory', workspaceId: workspace.id,
    sessionId: topicSession.sessionId })).topics[0]!
  const history = createChatScrollFixture({ markerPrefix: 'READING_A', title: 'Paper A', turns: 88 })
  const aId = await seedSession(scaffold, history.log, 'reading-paper-a')
  const bId = await seedSession(scaffold, createChatScrollFixture({ markerPrefix: 'READING_B', title: 'Paper B', turns: 4 }).log, 'reading-paper-b')
  await workspace.attachSession(aId); await workspace.attachSession(bId)
  await writeFile(join(scaffold.workspaceCwd, 'a.pdf'), pdfFixture(10))
  await writeFile(join(scaffold.workspaceCwd, 'b.pdf'), pdfFixture(11))
  await scaffold.ctx.workspaceController.researchCreatePaper({ topicId: topic.id, title: 'Paper A', sessionId: aId, pdfPath: 'a.pdf', repositoryUrl: '' })
  const catalog = await scaffold.ctx.workspaceController.researchCreatePaper({ topicId: topic.id, title: 'Paper B', sessionId: bId, pdfPath: 'b.pdf', repositoryUrl: '' })
  await scaffold.ctx.workspaceController.researchSaveNote({ paperId: catalog.papers.find(paper => paper.sessionId === bId)!.id,
    kind: 'learning', text: 'Paper B notes', expectedRevision: 0 })
  const a = catalog.papers.find(paper => paper.sessionId === aId)!
  await scaffold.ctx.workspaceController.researchSaveNote({ paperId: a.id, kind: 'learning', text: 'Reading paragraph\n'.repeat(200), expectedRevision: 0 })
  await scaffold.ctx.workspaceController.researchSaveNote({ paperId: a.id, kind: 'ai', text: '## Analysis\n\nPaper explanation with citations.\n\n'.repeat(80), expectedRevision: 0 })
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1800, height: 760 })
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'research-reading'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  const workbench = page.locator('[data-research-workbench]')
  await expect.poll(() => library.textContent()).toContain('Reading memory')
  await library.getByRole('button', { name: 'Paper A', exact: true }).click()
  await workbench.getByRole('group', { name: 'Panel visibility', exact: true }).getByRole('button', { name: 'files', exact: true }).click()
  const pdf = workbench.getByRole('region', { name: 'pdf viewer', exact: true })
  await pdf.getByRole('img', { name: 'PDF page 1', exact: true }).waitFor()
  await pdf.getByRole('button', { name: 'Choose zoom', exact: true }).focus()
  await pdf.getByRole('button', { name: 'Choose zoom', exact: true }).click()
  await page.getByRole('menuitem', { name: '150%', exact: true }).click()
  const pdfScroll = pdf.locator('[data-document-zoom-scrollport]')
  await pdfScroll.evaluate((node) => {
    const page = node.querySelector<HTMLElement>('[data-pdf-page="2"]')!
    const bounds = page.getBoundingClientRect()
    node.scrollTop += bounds.top - node.getBoundingClientRect().top + bounds.height * 0.3
    node.scrollLeft = (node.scrollWidth - node.clientWidth) * 0.35
    node.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => pdf.locator('[data-pdf-page="2"]').getAttribute('data-pdf-render-zoom')).toBe('1.5')
  const pdfPosition = async () => pdfScroll.evaluate((node) => {
    const page = node.querySelector<HTMLElement>('[data-pdf-page="2"]')!.getBoundingClientRect()
    return { y: (node.getBoundingClientRect().top - page.top) / page.height,
      x: node.scrollLeft / (node.scrollWidth - node.clientWidth), zoom: node.parentElement!.style.getPropertyValue('--document-zoom') }
  })
  const expectedPdf = await pdfPosition()
  await openResearchNote(workbench, 'learning', true)
  const editor = workbench.getByRole('textbox', { name: 'Learning notes', exact: true })
  await editor.evaluate((node: HTMLTextAreaElement) => {
    node.setSelectionRange(32, 48, 'backward'); node.scrollTop = 440; node.dispatchEvent(new Event('scroll'))
  })
  await openResearchNote(workbench, 'ai')
  await workbench.locator('[data-research-note-preview]').evaluate((node) => { node.scrollTop = 620; node.dispatchEvent(new Event('scroll')) })
  const marker = workbench.getByText(history.markers.user(12), { exact: false }).first()
  const chat = workbench.locator('[data-research-panel="agent"] [data-conversation-scroll]')
  for (let attempt = 0; attempt < 12 && await marker.count() === 0; attempt++) {
    const first = await chat.locator('[data-chat-anchor-seq]').first().getAttribute('data-chat-anchor-seq')
    await chat.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect.poll(() => chat.locator('[data-chat-anchor-seq]').first().getAttribute('data-chat-anchor-seq')).not.toBe(first)
  }
  await marker.waitFor()
  await marker.click()
  await marker.evaluate((node) => {
    const scroller = node.closest<HTMLElement>('[data-conversation-scroll]')!
    const anchor = node.closest<HTMLElement>('[data-chat-anchor-key]')!
    scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 60
    scroller.dispatchEvent(new Event('scroll'))
  })
  const chatOffset = () => marker.evaluate(node => node.closest('[data-chat-anchor-key]')!.getBoundingClientRect().top
    - node.closest('[data-conversation-scroll]')!.getBoundingClientRect().top)
  let expectedChat = await chatOffset()
  expect(Math.abs(expectedChat - 60)).toBeLessThan(3)
  await library.getByRole('button', { name: 'Paper B', exact: true }).click()
  await workbench.getByRole('group', { name: 'Panel visibility', exact: true }).getByRole('button', { name: 'files', exact: true }).click()
  await openResearchNote(workbench, 'learning', true)
  await workbench.getByRole('textbox', { name: 'Learning notes', exact: true }).waitFor()
  expect(await workbench.getByRole('textbox', { name: 'Learning notes', exact: true }).evaluate(node => node.scrollTop)).toBe(0)
  await library.getByRole('button', { name: 'Paper A', exact: true }).click()
  const restored = async (): Promise<void> => {
    await expect.poll(async () => Math.abs((await pdfPosition()).y - expectedPdf.y)).toBeLessThan(0.01)
    await expect.poll(async () => Math.abs((await pdfPosition()).x - expectedPdf.x)).toBeLessThan(0.01)
    expect((await pdfPosition()).zoom).toBe('1.5')
    await expect.poll(() => workbench.locator('[data-research-note-preview]').evaluate(node => node.scrollTop)).toBe(620)
    await expect.poll(() => marker.count()).toBeGreaterThan(0)
    await expect.poll(async () => Math.abs(await chatOffset() - expectedChat)).toBeLessThan(3)
  }
  await restored()
  await chat.evaluate((node) => { node.scrollTop += 40; node.dispatchEvent(new Event('scroll')) })
  expectedChat = await chatOffset()
  const panelControls = workbench.getByRole('group', { name: 'Panel visibility', exact: true })
  for (const name of ['agent', 'pdf viewer', 'files']) {
    await workbench.getByRole('button', { name: `Collapse ${name}`, exact: true }).click()
    await panelControls.getByRole('button', { name, exact: true }).click()
  }
  await restored()
  await page.reload({ waitUntil: 'load' })
  await library.getByRole('button', { name: 'Paper A', exact: true }).click()
  await restored()
  await openResearchNote(workbench, 'learning', true)
  const editorPosition = await editor.evaluate((node: HTMLTextAreaElement) =>
    [node.scrollTop, node.selectionStart, node.selectionEnd, node.selectionDirection])
  expect(editorPosition)
    .toEqual([440, 32, 48, 'backward'])
  expect(await editor.evaluate(node => node === document.activeElement)).toBe(false)
  expect(console.pageErrors).toEqual([])
})

it('keeps paper conversation history navigation visible within narrow Agent columns', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: 'Conversation navigation', workspaceId: workspace.id,
    sessionId: topicSession.sessionId })).topics[0]!
  const fixtures = [
    createChatScrollFixture({ markerPrefix: 'RAIL_A', title: 'Paper A', turns: 88 }),
    createChatScrollFixture({ markerPrefix: 'RAIL_B', title: 'Paper B', turns: 4 }),
  ] as const
  const sessionIds = await Promise.all(fixtures.map(async (fixture, index) => {
    const id = await seedSession(scaffold, fixture.log, `paper-rail-${String(index)}`)
    await workspace.attachSession(id)
    return id
  }))
  for (const index of [0, 1]) {
    await controller.researchCreatePaper({ topicId: topic.id, title: fixtures[index]!.title, sessionId: sessionIds[index]!,
      pdfPath: '', repositoryUrl: '' })
  }
  const paper = (await controller.researchList()).papers.find(item => item.sessionId === sessionIds[0])!
  const alternate = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  await controller.researchCreateConversation({ paperId: paper.id, sessionId: alternate.sessionId })
  await controller.researchUpdateConversation({ paperId: paper.id, sessionId: alternate.sessionId,
    title: 'Method discussion', expectedTitle: '' })
  await controller.researchProgress(paper.id, '', sessionIds[0])
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'research-turn-navigation'))
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  const workbench = page.locator('[data-research-workbench]')
  const agent = workbench.getByRole('region', { name: 'agent', exact: true })
  const rail = agent.getByRole('navigation', { name: 'Turn navigation', exact: true })
  await library.getByRole('button', { name: 'Paper A', exact: true }).click()
  await workbench.getByRole('group', { name: 'Panel visibility', exact: true }).getByRole('button', { name: 'files', exact: true }).click()
  await rail.waitFor({ state: 'visible' })
  expect((await agent.boundingBox())!.width).toBeLessThan(900)
  const fitsAgent = async (): Promise<void> => {
    await expect.poll(() => agent.evaluate((element) => {
      const rail = element.querySelector('nav[aria-label="Turn navigation"]')
      const column = element.querySelector('[data-chat-flow]')
      const composer = element.querySelector('[data-composer-seat]')
      if (rail === null || column === null || composer === null) return false
      const bounds = element.getBoundingClientRect(), marks = rail.getBoundingClientRect()
      return marks.left >= column.getBoundingClientRect().right + 8 && marks.right <= bounds.right
        && marks.top >= bounds.top && marks.bottom <= composer.getBoundingClientRect().top
    })).toBe(true)
  }
  await fitsAgent()
  await rail.locator('> div').first().evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  await rail.getByRole('button', { name: /^(?:Load and jump|Jump) to turn 1$/ }).click()
  await agent.getByText(fixtures[0].markers.user(1), { exact: false }).first().waitFor()
  const firstTurn = rail.getByRole('button', { name: 'Jump to turn 1', exact: true })
  await expect.poll(() => firstTurn.getAttribute('aria-current')).toBe('true')
  await firstTurn.hover()
  const preview = agent.getByRole('tooltip')
  await expect.poll(() => preview.textContent()).toContain(fixtures[0].markers.user(1))
  expect((await preview.boundingBox())!.x).toBeGreaterThanOrEqual((await agent.boundingBox())!.x)
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.screenshot({ path: '.artifacts/research-ui/paper-turn-navigation-light.png' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: '.artifacts/research-ui/paper-turn-navigation-dark.png' })
  await page.mouse.move(10, 10)
  await library.getByRole('button', { name: 'Paper B', exact: true }).click()
  await rail.getByRole('button', { name: 'Jump to turn 4', exact: true }).waitFor()
  expect(await agent.textContent()).not.toContain(fixtures[0].markers.user(1))
  await library.getByRole('button', { name: 'Paper A', exact: true }).click()
  await agent.getByRole('button', { name: 'Switch conversation', exact: true }).click()
  await page.getByRole('dialog', { name: 'Paper conversations', exact: true })
    .getByRole('button', { name: 'Method discussion', exact: true }).click()
  await expect.poll(() => agent.locator('[data-conversation-content]').getAttribute('data-conversation-session')).toBe(alternate.sessionId)
  expect(await rail.count()).toBe(0)
  await library.getByRole('button', { name: 'Paper B', exact: true }).click()
  const latest = rail.getByRole('button', { name: 'Jump to turn 4', exact: true })
  await expect.poll(() => latest.getAttribute('aria-current')).toBe('true')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport)
    await rail.waitFor({ state: 'visible' })
    await fitsAgent()
    await latest.focus()
    await expect.poll(() => preview.textContent()).toContain(fixtures[1].markers.user(4))
    expect((await preview.boundingBox())!.x).toBeGreaterThanOrEqual((await agent.boundingBox())!.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  expect(console.pageErrors).toEqual([])
})
