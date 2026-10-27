/** Global research conversations retain independent drafts and stay separate from entity conversations. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, selectedSessionFixture,
  watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/research-workspace/library-conversations.expected.md', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../.artifacts/research-ui', import.meta.url))

it.each(['empty-library', 'cold-main', 'unbound-main'] as const)('starts the global research composer without a Workspace choice after %s boot', async (initialState) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  await controller.researchList()
  const previous = SessionId('cold-library-main')
  if (initialState !== 'empty-library') {
    const fixture = await selectedSessionFixture(fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url)))
    await seedSession(scaffold, await readFile(fixture, 'utf8'), previous, undefined, { createdAt: WEB_FIXTURE_TIME })
    if (initialState === 'cold-main') {
      const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
      await workspace.attachSession(previous)
    } else expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
    expect(scaffold.ctx.sessions.get(previous)).toBeUndefined()
    expect(scaffold.ctx.agents.get(previous)).toBeUndefined()
  } else {
    expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
    expect(scaffold.ctx.sessions.list()).toEqual([])
  }
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `research-library-${initialState}-boot`))
  if (initialState !== 'empty-library') await page.addInitScript((sessionId) => {
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
  }, previous)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const header = page.locator('[data-research-library-header]')
  try { await header.waitFor({ state: 'visible', timeout: 10_000 }) }
  catch (error: unknown) {
    await saveFailureShot(page, `research-library-${initialState}-boot`)
    throw error
  }
  const composer = page.locator('[data-research-workbench] [data-composer-input][contenteditable="true"]')
  await composer.waitFor({ state: 'visible' })
  if (initialState !== 'empty-library') await page.locator('[data-research-workbench]').getByText('DONE', { exact: true }).waitFor()
  expect(await page.getByRole('alert').count()).toBe(0)
  expect(await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).count()).toBe(0)
  await composer.fill('Ready to research the library')
  const entries = (await controller.researchList()).libraryConversations ?? []
  expect(entries).toHaveLength(1)
  if (initialState !== 'empty-library') expect(entries[0]?.sessionId).toBe(previous)
  await page.reload({ waitUntil: 'load' })
  await header.waitFor({ state: 'visible' })
  await composer.waitFor({ state: 'visible' })
  expect(await page.getByRole('alert').count()).toBe(0)
  expect((await controller.researchList()).libraryConversations?.map(item => item.sessionId)).toEqual(entries.map(item => item.sessionId))
  expect(errors.pageErrors).toEqual([])
})

it('manages global conversations independently and restores their selection, drafts and compact navigation', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const directory = (await controller.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(directory)
  const topicSession = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: 'Entity conversations', workspaceId: workspace.id,
    sessionId: topicSession.sessionId })).topics[0]!
  const imported = await controller.researchImportPaper({ topicId: topic.id, title: 'Private paper chat' }, new AbortController().signal)
  const paper = (await controller.researchList()).papers.find(item => item.id === imported.paperId)!
  const unlisted = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const initial = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })

  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.addInitScript((sessionId) => {
    if (localStorage.getItem('dsh.sessions.current') === null) {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }
  }, initial.sessionId)
  const errors = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'research-library-conversations'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await expect.poll(async () => (await controller.researchList()).libraryConversations
    ?.map(item => item.sessionId)).toEqual([initial.sessionId])
  await controller.researchUpdateLibraryConversation({ sessionId: initial.sessionId, title: 'Library planning', expectedTitle: '' })
  await page.getByRole('button', { name: 'Open global Agent', exact: true }).click()
  const workbench = page.locator('[data-research-workbench]')
  const header = page.locator('[data-research-library-header]')
  const picker = header.getByRole('button', { name: 'Switch conversation', exact: true })
  const popup = page.getByRole('dialog', { name: 'Global conversations', exact: true })
  const composer = workbench.locator('[data-composer-input]')
  await expect.poll(() => picker.textContent()).toContain('Library planning')
  expect(await header.getByText('Global Agent', { exact: true }).count()).toBe(0)
  expect(await library.getByRole('button', { name: 'Global Agent', exact: true }).count()).toBe(0)
  const originalHeight = (await header.boundingBox())!.height
  const pickerBounds = (await picker.boundingBox())!
  const newBounds = (await header.getByRole('button', { name: 'New conversation', exact: true }).boundingBox())!
  expect(newBounds.x - pickerBounds.x - pickerBounds.width).toBeGreaterThanOrEqual(0)
  expect(newBounds.x - pickerBounds.x - pickerBounds.width).toBeLessThanOrEqual(12)
  await composer.fill('Draft for the whole library')
  await header.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect.poll(async () => (await controller.researchList()).libraryConversations?.length).toBe(2)
  await expect.poll(() => composer.textContent()).toBe('')
  expect((await header.boundingBox())!.height).toBeCloseTo(originalHeight, 0)
  const current = (await controller.researchList()).libraryConversations!.find(item => item.sessionId !== initial.sessionId)!
  expect([topic.sessionId, paper.sessionId, unlisted.sessionId]).not.toContain(current.sessionId)
  expect(scaffold.ctx.sessions.get(current.sessionId)?.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
  await composer.fill('Draft for a separate research direction')

  await picker.click()
  await popup.waitFor({ state: 'visible' })
  const desktopPopup = (await popup.boundingBox())!
  expect(desktopPopup.width).toBeGreaterThan(360)
  expect(desktopPopup.width).toBeLessThanOrEqual(480)
  expect(desktopPopup.x + desktopPopup.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await popup.locator('[data-conversation-option]').filter({ hasText: 'New conversation' }).hover()
  await popup.getByRole('button', { name: 'Conversation actions for New conversation', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename conversation', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename conversation', exact: true })
  await rename.getByRole('textbox', { name: 'Conversation name', exact: true }).fill('Embodied research')
  await rename.getByRole('button', { name: 'Save name', exact: true }).click()
  await rename.waitFor({ state: 'hidden' })
  await expect.poll(() => picker.textContent()).toContain('Embodied research')

  await picker.click()
  const search = popup.getByRole('textbox', { name: 'Search global conversations', exact: true })
  await search.fill('Library planning')
  expect(await popup.locator('[data-conversation-option]').count()).toBe(1)
  await search.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect.poll(() => composer.textContent()).toBe('Draft for the whole library')
  await picker.click()
  expect(await popup.locator('[data-conversation-option]').count()).toBe(2)
  await popup.getByRole('button', { name: /^Embodied research/ }).click()
  await expect.poll(() => composer.textContent()).toBe('Draft for a separate research direction')
  await picker.click()
  await popup.locator('[data-conversation-option]').filter({ hasText: 'Embodied research' }).hover()
  await popup.getByRole('button', { name: 'Conversation actions for Embodied research', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Pin conversation', exact: true }).click()
  await expect.poll(async () => (await controller.researchList()).libraryConversations
    ?.find(item => item.sessionId === current.sessionId)?.pinned).toBe(true)
  await picker.click()
  await popup.getByText('Pinned', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'hidden' })
  expect(await picker.evaluate(node => node === document.activeElement)).toBe(true)

  await library.getByRole('button', { name: topic.title, exact: true }).click()
  const topicHeight = (await workbench.locator('> header').boundingBox())!.height
  expect(topicHeight).toBeCloseTo(originalHeight, 0)
  await library.getByRole('button', { name: paper.title, exact: true }).click()
  expect((await workbench.locator('> header').boundingBox())!.height).toBeCloseTo(originalHeight, 0)
  await page.reload({ waitUntil: 'load' })
  await workbench.locator('> header').getByText(paper.title, { exact: true }).waitFor()
  expect(await header.count()).toBe(0)
  const beforeLogo = (await controller.researchList()).libraryConversations?.map(item => item.sessionId)
  await page.getByRole('button', { name: 'Open global Agent', exact: true }).click()
  await expect.poll(() => picker.textContent()).toContain('Embodied research')
  expect((await controller.researchList()).libraryConversations?.map(item => item.sessionId)).toEqual(beforeLogo)
  await library.getByRole('button', { name: paper.title, exact: true }).click()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Open global Agent', exact: true }).waitFor({ state: 'hidden' })
  expect(await page.getByRole('button', { name: 'Open global Agent', exact: true }).count()).toBe(0)
  expect(await workbench.locator('> header').getByText(paper.title, { exact: true }).isVisible()).toBe(true)
  expect((await controller.researchList()).libraryConversations?.map(item => item.sessionId)).toEqual(beforeLogo)
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Open global Agent', exact: true }).click()
  await expect.poll(() => picker.textContent()).toContain('Embodied research')
  expect((await controller.researchList()).libraryConversations?.map(item => item.sessionId)).toEqual(beforeLogo)
  await expect.poll(() => composer.textContent()).toBe('Draft for a separate research direction')
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => picker.textContent()).toContain('Embodied research')
  await expect.poll(() => composer.textContent()).toBe('Draft for a separate research direction')

  await picker.click()
  await popup.locator('[data-conversation-option]').filter({ hasText: 'Embodied research' }).hover()
  await popup.getByRole('button', { name: 'Conversation actions for Embodied research', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click()
  await expect.poll(() => picker.textContent()).toContain('Library planning')
  expect((await controller.researchList()).libraryConversations?.find(item => item.sessionId === current.sessionId)?.archived).toBe(true)
  await picker.click()
  await popup.getByRole('button', { name: 'Show archived conversations', exact: true }).click()
  await popup.getByRole('button', { name: /^Embodied research/ }).click()
  await expect.poll(() => picker.textContent()).toContain('Embodied research')
  expect((await controller.researchList()).libraryConversations?.find(item => item.sessionId === current.sessionId)?.archived).toBe(false)

  const heldAgent = scaffold.ctx.agents.get(initial.sessionId)!
  let release!: () => void, arrived!: () => void, turnSignal: AbortSignal | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { arrived = resolve })
  const stopGate = scaffold.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent !== heldAgent) return next()
    turnSignal = signal; arrived(); await gate
    return { kind: 'reject' }
  })
  onTestFinished(async () => { release(); await heldAgent.whenIdle(); stopGate() })
  heldAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the library research' }], source: { kind: 'user' } }))
  await entered
  await picker.click()
  await popup.getByRole('button', { name: 'Show active conversations', exact: true }).click()
  const heldOption = popup.locator('[data-conversation-option]').filter({ hasText: 'Library planning' })
  await heldOption.getByText('Running', { exact: true }).waitFor()
  await heldOption.hover()
  await popup.getByRole('button', { name: 'Conversation actions for Library planning', exact: true }).click()
  expect(await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).isDisabled()).toBe(true)
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'hidden' })
  await picker.click()
  await popup.locator('[data-conversation-option]').filter({ hasText: 'Library planning' }).click()
  await picker.click()
  await popup.locator('[data-conversation-option]').filter({ hasText: 'Embodied research' }).click()
  expect(heldAgent.status).toBe('running')
  expect(turnSignal?.aborted).toBe(false)
  release(); await heldAgent.whenIdle(); stopGate()

  const finalCatalog = await controller.researchList()
  expect(finalCatalog.topics.map(item => item.id)).toEqual([topic.id])
  expect(finalCatalog.papers.map(item => item.id)).toEqual([paper.id])
  const index = JSON.parse(await readFile(join(directory, 'agent-lib', 'library.json'), 'utf8')) as { libraryConversations: { sessionId: string }[] }
  expect(index.libraryConversations.map(item => item.sessionId).sort()).toEqual([initial.sessionId, current.sessionId].sort())

  await mkdir(SHOTS, { recursive: true })
  await page.getByText('Conversation settings saved', { exact: true }).waitFor({ state: 'hidden' })
  await picker.click()
  await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.screenshot({ path: join(SHOTS, 'library-conversations-light.png') })
  await page.keyboard.press('Escape')
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Dark', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await picker.click()
  await page.screenshot({ path: join(SHOTS, 'library-conversations-dark.png') })
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport)
    await picker.click()
    const bounds = (await popup.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
    expect(await page.locator('body').evaluate(node => node.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(SHOTS, `library-conversations-${viewport.width}.png`) })
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1680, height: 1000 })
  const expand = page.getByRole('button', { name: 'Open sidebar', exact: true })
  if (await expand.isVisible()) await expand.click()
  await library.getByRole('button', { name: paper.title, exact: true }).click()
  await page.keyboard.press('ControlOrMeta+Alt+N')
  await expect.poll(async () => (await controller.researchList()).libraryConversations?.length).toBe(3)
  await header.waitFor()
  await expect.poll(() => composer.textContent()).toBe('')
  const shortcutConversation = (await controller.researchList()).libraryConversations
    ?.find(item => item.sessionId !== initial.sessionId && item.sessionId !== current.sessionId)
  expect(shortcutConversation).toBeDefined()
  expect(scaffold.ctx.sessions.get(shortcutConversation!.sessionId)?.header.cwd).toBe(directory)
  await controller.researchUpdateLibraryConversation({ sessionId: shortcutConversation!.sessionId,
    title: 'Temporary research', expectedTitle: '' })
  await expect.poll(() => picker.textContent()).toContain('Temporary research')
  await composer.fill('Keep this draft while another history is deleted')

  const openDelete = async (title: string) => {
    await picker.click()
    const option = popup.locator('[data-conversation-option]').filter({ hasText: title })
    await option.hover()
    await popup.getByRole('button', { name: `Conversation actions for ${title}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
    return page.getByRole('dialog', { name: 'Delete conversation', exact: true })
  }
  let deletion = await openDelete('Library planning')
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await controller.researchList()).libraryConversations?.map(item => item.sessionId))
    .toEqual(expect.arrayContaining([initial.sessionId, current.sessionId, shortcutConversation!.sessionId]))

  let blockDelete = true
  const stopActivity = scaffold.ctx.on('workspace/session-activity', async ({ sessionId }, next) => [
    ...await next(), ...blockDelete && sessionId === initial.sessionId
      ? [{ kind: 'job' as const, items: [{ id: 'delete-hold', label: 'Retained research work' }] }] : [],
  ])
  onTestFinished(() => { stopActivity() })
  deletion = await openDelete('Library planning')
  await deletion.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await deletion.getByRole('alert').waitFor()
  expect(await deletion.isVisible()).toBe(true)
  expect((await controller.researchList()).libraryConversations?.some(item => item.sessionId === initial.sessionId)).toBe(true)
  blockDelete = false
  await deletion.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await deletion.waitFor({ state: 'hidden' })
  await expect.poll(async () => (await controller.researchList()).libraryConversations?.length).toBe(2)
  expect((await controller.researchList()).libraryConversations?.some(item => item.sessionId === initial.sessionId)).toBe(false)
  expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).toContain(initial.sessionId)
  await expect.poll(() => picker.textContent()).toContain('Temporary research')
  expect(await composer.textContent()).toBe('Keep this draft while another history is deleted')
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => picker.textContent()).toContain('Temporary research')
  expect((await controller.researchList()).libraryConversations?.some(item => item.sessionId === initial.sessionId)).toBe(false)

  deletion = await openDelete('Temporary research')
  await deletion.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await deletion.waitFor({ state: 'hidden' })
  await expect.poll(() => picker.textContent()).toContain('Embodied research')
  expect((await controller.researchList()).libraryConversations?.map(item => item.sessionId)).toEqual([current.sessionId])
  deletion = await openDelete('Embodied research')
  await deletion.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await deletion.waitFor({ state: 'hidden' })
  await expect.poll(() => composer.getAttribute('contenteditable')).toBe('true')
  await expect.poll(async () => (await controller.researchList()).libraryConversations?.length).toBe(1)
  const replacement = (await controller.researchList()).libraryConversations![0]!
  expect([initial.sessionId, current.sessionId, shortcutConversation!.sessionId]).not.toContain(replacement.sessionId)
  await composer.fill('Ready after deleting the last conversation')
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => composer.textContent()).toBe('Ready after deleting the last conversation')
  expect((await controller.researchList()).topics.map(item => item.id)).toEqual([topic.id])
  expect((await controller.researchList()).papers.map(item => item.id)).toEqual([paper.id])
  expect(errors.pageErrors).toEqual([])
})
