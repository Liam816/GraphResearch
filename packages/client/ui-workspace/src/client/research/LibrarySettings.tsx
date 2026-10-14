/** Library selection uses one explicit open or migration operation and retains form input on failure. */
import { useState } from 'react'
import { Button, Input, Modal, Tooltip, IconEllipsisOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchSeats } from './contract.ts'
import css from './Research.module.css'

/** @param props - confirmed Host directory, localized copy and configuration command. @returns library settings trigger and form. */
export function ResearchLibrarySettings({ directory, t, configureDirectory }: Pick<ResearchSeats, 't' | 'configureDirectory'> & { directory: string | undefined }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<'open' | 'migrate'>('open')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true); setFailed(false)
    try { await configureDirectory({ directory: path.trim(), mode }); setOpen(false) }
    catch (_error: unknown) { setFailed(true) }
    finally { setBusy(false) }
  }
  return <>
    <Tooltip label={t('librarySettings')} side="bottom" portal>
      <Button size="sm" aria-label={t('librarySettings')} onClick={() => { setPath(directory ?? ''); setMode('open'); setFailed(false); setOpen(true) }}>
        <IconEllipsisOutlineRegular size={16} />
      </Button>
    </Tooltip>
    <Modal open={open} title={t('librarySettings')} closeLabel={t('close')} onClose={() => { if (!busy) setOpen(false) }}
      footer={<><Button disabled={busy} onClick={() => { setOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || path.trim() === ''} onClick={() => { void save() }}>{t(busy ? 'saving' : 'applyDirectory')}</Button></>}>
      <div className={css.form}>
        <label>{t('libraryDirectory')}<Input data-modal-autofocus aria-label={t('libraryDirectory')} value={path}
          onChange={(event) => { setPath(event.target.value) }} /></label>
        <label>{t('directoryMode')}<select aria-label={t('directoryMode')} value={mode}
          onChange={(event) => { setMode(event.target.value === 'migrate' ? 'migrate' : 'open') }}>
          <option value="open">{t('openLibrary')}</option><option value="migrate">{t('migrateLibrary')}</option>
        </select></label>
        <p className={css.hint}>{t(mode === 'open' ? 'openLibraryHint' : 'migrateLibraryHint')}</p>
        {failed && <p role="alert" className={css.notice}>{t('directoryChangeFailed')}</p>}
      </div>
    </Modal>
  </>
}
