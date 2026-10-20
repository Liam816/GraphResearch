/** Sent questions remain editable after cancellation without replacing history or the composer draft. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { fixtureUserPrompts, launchWebScaffold, recordFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

const DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/edit-question', import.meta.url))
const FIXTURE = join(DIRECTORY, 'session.v4.jsonl')

it.skipIf(webSnapshotMode() === 'record')('edits an interrupted question without replacing history or the composer draft', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-edit-question-'))
  const owner: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    const failures: unknown[] = []
    const releases = [() => owner.browser?.close(), () => owner.scaffold?.close(),
      () => rm(temporary, { recursive: true, force: true })]
    for (const dispose of releases) {
      try { await dispose() } catch (error: unknown) {
        const nested: readonly unknown[] = error instanceof AggregateError ? error.errors : [error]
        failures.push(...nested)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 0) throw new AggregateError(failures, 'Edit-question cleanup failed')
  })
  const ready = join(temporary, 'stream-ready')
  const override = join(temporary, 'replay.override.json')
  const script: ReplayOverrideDoc = [
    { kind: 'hang', readyFile: ready },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'REVISED_REPLY' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'REVISED_REPLY' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  await writeFile(override, JSON.stringify(script))
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: override })
  owner.scaffold = scaffold
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  owner.browser = browser
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'edit-question'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const newSession = page.locator('[data-sidebar-new-session]')
  await newSession.first().waitFor({ state: 'attached' })
  for (const button of await newSession.all()) expect(await button.isVisible()).toBe(false)
  expect(await page.getByRole('button', { name: 'Plugins', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Automation tasks', exact: true }).count()).toBe(0)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  const original = prompts[0]!
  const revised = prompts[1] ?? 'Reply with the single word REVISED_REPLY and stop.'
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, original)
  await input.press('Enter')
  await expect.poll(() => existsSync(ready)).toBe(true)
  const question = page.locator('[data-chat-flow-kind="user"]').first()
  await question.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit question', exact: true })
  expect(await editor.inputValue()).toBe(original)
  expect(await page.getByRole('button', { name: 'Ask again', exact: true }).isDisabled()).toBe(true)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  const [sessionId] = await Promise.all([
    scaffold.whenTurnSettled(), page.getByRole('button', { name: 'Stop generating', exact: true }).click(),
  ])
  await writeComposerDraft(page, input, 'Unsaved composer draft')
  await question.getByRole('button', { name: 'Edit', exact: true }).click()
  await editor.fill(revised)
  await page.route('**/api/session/prompt', async (route) => {
    const request = route.request().postDataJSON() as { rpcId: string }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      type: 'server-response', rpcId: request.rpcId,
      result: { ok: false, error: { code: 'session/writer-held', message: 'Session is in use', details: {} } },
    }) })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Ask again', exact: true }).click()
  await page.getByText('Could not send the question. Your edits are retained; try again.', { exact: true }).waitFor()
  expect(await editor.inputValue()).toBe(revised)
  await Promise.all([
    scaffold.whenTurnSettled(), page.getByRole('button', { name: 'Ask again', exact: true }).click(),
  ])
  await page.getByText('REVISED_REPLY', { exact: true }).waitFor()
  expect(await editor.count()).toBe(0)
  expect(await input.textContent()).toBe('Unsaved composer draft')
  expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(2)
  const agent = scaffold.ctx.agents.get(sessionId)!
  const questions = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
    ? [event.data.content] : [])
  expect(questions).toEqual([
    [{ type: 'text', text: original }], [{ type: 'text', text: revised }],
  ])
  await page.reload({ waitUntil: 'load' })
  await page.getByText('REVISED_REPLY', { exact: true }).waitFor()
  expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(2)
  await page.locator('[data-chat-flow-kind="user"]').last().getByRole('button', { name: 'Edit', exact: true }).click()
  expect(await editor.inputValue()).toBe(revised)
  await mkdir('.artifacts', { recursive: true })
  const screenshots = await mkdtemp(join('.artifacts', 'question-edit-'))
  await page.screenshot({ path: join(screenshots, 'light.png') })
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Dark', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await page.screenshot({ path: join(screenshots, 'dark.png') })
  await page.setViewportSize({ width: 375, height: 812 })
  const bounds = await editor.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  await page.screenshot({ path: join(screenshots, 'narrow.png') })
  await editor.press('Escape')
  expect(await editor.count()).toBe(0)
  if (webSnapshotMode() === 'refresh') await recordFixture(scaffold, sessionId, FIXTURE)
})
