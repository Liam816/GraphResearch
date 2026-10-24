/** User documents remain independent of private research metadata and Session backups. */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('starts empty, names attached originals, and previews freely organized documents without exposing runtime state', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const root = (await controller.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const session = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: 'Robot learning', workspaceId: workspace.id, sessionId: session.sessionId })).topics[0]!
  const imported = await controller.researchImportPaper({ topicId: topic.id, title: 'OpenVLA: an open vision-language-action model' }, new AbortController().signal)
  const paper = imported.catalog.papers.find(item => item.id === imported.paperId)!
  expect(await readdir(paper.directory!)).toEqual([])
  expect(JSON.parse(await readFile(join(root, 'agent-lib', 'papers', paper.id, 'session.json'), 'utf8')))
    .toMatchObject({ header: { id: paper.sessionId } })

  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const checkLeadingMode = async () => {
    expect(await page.getByRole('button', { name: 'Choose workspace', exact: true }).count()).toBe(0)
    const row = page.locator('[class*="heroWorkspaceRow"]').filter({ visible: true })
    const mode = row.getByRole('button', { name: 'Standard mode', exact: true })
    await mode.waitFor()
    await expect.poll(async () => {
      const bounds = await row.boundingBox(), button = await mode.boundingBox()
      return bounds === null || button === null ? Number.POSITIVE_INFINITY : button.x - bounds.x
    }).toBeLessThanOrEqual(24)
    expect(await row.getByRole('button').count()).toBe(1)
    await mode.click()
    await page.getByRole('menuitem', { name: /^Standard mode/ }).waitFor()
    await page.keyboard.press('Escape')
  }
  const library = page.getByRole('region', { name: 'Research library', exact: true })
  await library.getByRole('button', { name: topic.title, exact: true }).click()
  await checkLeadingMode()
  await library.getByRole('button', { name: paper.title, exact: true }).click()
  await checkLeadingMode()
  await page.getByRole('group', { name: 'Panel visibility', exact: true }).getByRole('button', { name: 'Related content', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Related content', exact: true })
  const tree = panel.getByRole('tree', { name: 'Paper files', exact: true })
  await tree.getByText('Empty folder', { exact: true }).waitFor()
  expect(await tree.getByRole('treeitem').count()).toBe(0)
  await mkdir('.artifacts/research-ui', { recursive: true })
  await page.screenshot({ path: '.artifacts/research-ui/content-empty.png' })
  const input = join(scaffold.workspaceCwd, 'original.pdf')
  await writeFile(input, pdfFixture())
  await controller.researchAttachPdf({ paperId: paper.id, source: input, abbreviation: 'OpenVLA' }, new AbortController().signal)
  for (const name of ['paper_OpenVLA.pdf', 'paper_OpenVLA.md', 'paper_OpenVLA.json']) {
    await tree.getByRole('treeitem', { name, exact: true }).waitFor()
  }
  expect(await tree.getByRole('treeitem').count()).toBe(3)
  await tree.getByRole('treeitem', { name: 'paper_OpenVLA.md', exact: true }).click()
  await panel.getByText('Selectable PDF text', { exact: true }).first().waitFor()
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Edit paper_OpenVLA.md', exact: true }).fill('# My edited original\n')
  await panel.getByRole('button', { name: 'Save file', exact: true }).click()
  await expect.poll(() => readFile(join(paper.directory!, 'paper_OpenVLA.md'), 'utf8')).toBe('# My edited original\n')

  await mkdir(join(paper.directory!, 'experiments', 'trial'), { recursive: true })
  await writeFile(join(paper.directory!, 'experiments', 'trial', 'model.py'), 'def policy():\n    return "action"\n')
  await writeFile(join(paper.directory!, 'experiments', 'trial', 'notes.md'), '# A custom notebook\n')
  await rm(join(paper.directory!, 'paper_OpenVLA.md'))
  await rm(join(paper.directory!, 'paper_OpenVLA.json'))
  await controller.researchList()
  await panel.getByRole('button', { name: 'Refresh files', exact: true }).click()
  await tree.getByRole('treeitem', { name: 'experiments', exact: true }).click()
  await tree.getByRole('treeitem', { name: 'trial', exact: true }).click()
  await tree.getByRole('treeitem', { name: 'model.py', exact: true }).click()
  await expect.poll(() => panel.textContent()).toContain('def policy():')
  expect(await tree.getByRole('treeitem', { name: 'paper_OpenVLA.md', exact: true }).count()).toBe(0)
  expect((await controller.researchList()).papers[0]?.sessionId).toBe(paper.sessionId)
})

it('opens a legacy library with its PDF and conversations while moving runtime files out of the explorer', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.workspaceController
  const root = (await controller.researchList()).directory!
  const workspace = await scaffold.ctx.workspaceRegistry.create(root)
  const session = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id })
  const topic = (await controller.researchCreateTopic({ title: 'Legacy study', workspaceId: workspace.id, sessionId: session.sessionId })).topics[0]!
  const input = join(scaffold.workspaceCwd, 'legacy-original.pdf')
  await writeFile(input, pdfFixture())
  const imported = await controller.researchImportPaper({ topicId: topic.id, title: 'Legacy paper', source: input }, new AbortController().signal)
  const paper = imported.catalog.papers[0]!, markdown = paper.markdown
  if (markdown?.status !== 'ready') throw new Error('The fixture original must be converted')
  const legacyRoot = join(scaffold.workspaceCwd, 'legacy-library')
  const original = join(legacyRoot, 'papers', paper.id)
  for (const name of ['notes', 'assets', 'code', 'extracted']) await mkdir(join(original, name), { recursive: true })
  await mkdir(join(legacyRoot, 'topics', topic.id), { recursive: true })
  await copyFile(paper.pdfPath, join(original, 'paper.pdf'))
  await copyFile(join(paper.directory!, markdown.path), join(original, 'paper.md'))
  await copyFile(join(root, 'agent-lib', 'papers', paper.id, 'session.json'), join(original, 'session.json'))
  await copyFile(join(root, 'agent-lib', 'topics', topic.id, 'session.json'), join(legacyRoot, 'topics', topic.id, 'session.json'))
  await writeFile(join(original, 'notes', 'ai.md'), '')
  await writeFile(join(original, 'notes', 'learning.md'), '')
  await writeFile(join(original, 'extracted', 'pages-1.json'), '{"pages":[]}')
  await writeFile(join(legacyRoot, 'topics', topic.id, 'notes.md'), '')
  const empty = { revision: 0, sha256: createHash('sha256').update('').digest('hex') }
  await writeFile(join(legacyRoot, 'library.json'), JSON.stringify({ version: 1, revision: 1,
    topics: [{ id: topic.id, title: topic.title, workspaceId: workspace.id, sessionId: topic.sessionId, notes: empty }],
    papers: [{ id: paper.id, title: paper.title, topicIds: [topic.id], sessionId: paper.sessionId,
      pdfPath: 'paper.pdf', pdfSha256: paper.pdfSha256, markdown: { ...markdown, path: 'paper.md' }, repositoryUrl: '', ai: empty, learning: empty }],
  }))
  const migrated = await controller.researchConfigure({ directory: legacyRoot, mode: 'open' })
  const restored = migrated.papers[0]!
  expect(restored).toMatchObject({ id: paper.id, sessionId: paper.sessionId, title: paper.title })
  expect(await readdir(restored.directory!)).toEqual(['paper.md', 'paper.pdf'])
  expect(JSON.parse(await readFile(join(legacyRoot, 'agent-lib', 'library.json'), 'utf8'))).toMatchObject({ version: 4 })
  expect(await readFile(join(legacyRoot, 'agent-lib', 'papers', paper.id, 'extracted', 'pages-1.json'), 'utf8')).toBe('{"pages":[]}')

  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('region', { name: 'Research library', exact: true }).getByRole('button', { name: paper.title, exact: true }).click()
  await page.getByRole('img', { name: 'PDF page 1', exact: true }).waitFor()
  await page.getByRole('group', { name: 'Panel visibility', exact: true }).getByRole('button', { name: 'Related content', exact: true }).click()
  const tree = page.getByRole('tree', { name: 'Paper files', exact: true })
  await tree.getByRole('treeitem', { name: 'paper.pdf', exact: true }).waitFor()
  expect(await tree.getByRole('treeitem').count()).toBe(2)
})
