/** Browser actions for the paper's file explorer. */
import type { Locator } from 'playwright'

/**
 * Open a managed note from the paper explorer.
 * @param workbench - active research workspace.
 * @param kind - managed notebook filename.
 * @param edit - enter editing when requested.
 */
export async function openResearchNote(workbench: Locator, kind: 'ai' | 'learning', edit = false): Promise<void> {
  const files = workbench.locator('[data-paper-files]')
  const notes = files.getByRole('treeitem', { name: 'notes', exact: true })
  await notes.waitFor()
  if (await notes.getAttribute('aria-expanded') !== 'true') await notes.click()
  await files.getByRole('treeitem', { name: `${kind}.md`, exact: true }).click()
  if (edit && await files.getByRole('textbox').count() === 0) await files.getByRole('button', { name: 'Edit', exact: true }).click()
}
