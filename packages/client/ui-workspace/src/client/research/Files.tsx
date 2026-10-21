/** Paper-local explorer with lazy directory reads and independently retained file drafts. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Button, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, ReferenceIconRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchDirectoryListing, ResearchPaper } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ResearchWorkbenchProps } from './contract.ts'
import { DEFAULT_FILE_SPLIT, type PaperView } from './store.ts'
import { ResearchNotes } from './Notes.tsx'
import { PaperFilePreview } from './FilePreview.tsx'
import { PaperFileDivider } from './FileDivider.tsx'
import css from './Files.module.css'

/** Shared commands and existing PDF factory supplied by the workbench. */
export type PaperFilesProps = Pick<ResearchWorkbenchProps, 't' | 'viewActions' | 'listFiles' | 'readFile' | 'saveFile' | 'saveNote' | 'refresh' | 'renderFactorySlot'> & {
  paper: ResearchPaper
  view: PaperView
  revision: string
}

function Branch({ path, level, ...props }: PaperFilesProps & { path: string; level: number }) {
  const { t, paper, view, viewActions: actions, listFiles, revision } = props
  const [listing, setListing] = useState<ResearchDirectoryListing>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void listFiles({ paperId: paper.id, path }).then((value) => {
      if (active) { setListing(value); setFailed(false) }
    }).catch((_error: unknown) => { if (active) setFailed(true) })
    return () => { active = false }
  }, [paper.id, path, listFiles, revision, attempt])
  return <div role={path === '' ? 'tree' : 'group'} aria-label={path === '' ? t('paperFiles') : undefined}>
    {failed && <div className={css.notice} role="alert">{t('filesFailed')} <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>}
    {listing === undefined && !failed && <div className={css.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={18} /></div>}
    {listing?.entries.length === 0 && <p className={css.emptyFolder}>{t('emptyFolder')}</p>}
    {listing?.entries.map((entry) => {
      const folder = entry.kind === 'directory'
      const expanded = view.files?.expanded[entry.path] === true
      const selected = view.files?.selected === entry.path
      const dirty = view.files?.drafts[entry.path] !== undefined || (entry.path === 'notes/ai.md' ? view.drafts.ai !== undefined : entry.path === 'notes/learning.md' && view.drafts.learning !== undefined)
      return <div key={entry.path} role="none">
        <button type="button" role="treeitem" aria-level={level} aria-expanded={folder ? expanded : undefined}
          aria-label={entry.name} aria-description={dirty ? t('unsaved') : undefined} aria-selected={selected} aria-disabled={entry.kind === 'other'} data-file-path={entry.path} data-directory={folder || undefined}
          tabIndex={-1} title={entry.path} className={css.fileRow} style={{ '--file-level': level } as CSSProperties}
          onClick={() => {
            if (folder) actions.fileExpand(paper.id, entry.path, !expanded)
            else if (entry.kind === 'file') actions.fileSelect(paper.id, entry.path)
          }}>
          <span className={css.chevron}>{folder && (expanded
            ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />)}</span>
          {folder ? <ReferenceIconRegular kind="folder" size={16} /> : <FileTypeIcon path={entry.name} size={16} />}
          <span className={css.fileName}>{entry.name}</span>{dirty && <span className={css.dirty} aria-label={t('unsaved')}>•</span>}
        </button>
        {folder && expanded && <Branch {...props} paper={paper} view={view} t={t} viewActions={actions}
          listFiles={listFiles} revision={revision} path={entry.path} level={level + 1} />}
      </div>
    })}
  </div>
}

/**
 * Browse the paper directory and preview its selected file.
 * @param props - paper directory, persisted file preferences, and preview commands.
 * @returns the explorer and selected file.
 */
export function PaperFiles(props: PaperFilesProps) {
  const { paper, view, t } = props
  const [collapsed, setCollapsed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const path = view.files?.selected ?? ''
  const revision = `${props.revision}:${refresh}`
  useEffect(() => {
    const onFocus = (): void => { setRefresh(value => value + 1) }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[role="treeitem"]') : null
    const rows = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const index = current === null ? -1 : rows.indexOf(current)
      rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (current !== null && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault()
      const folder = current.dataset['directory'] === 'true'
      if (folder && ((event.key === 'ArrowRight') !== (current.getAttribute('aria-expanded') === 'true'))) current.click()
      else if (event.key === 'ArrowRight') rows[rows.indexOf(current) + 1]?.focus()
      else {
        const parent = current.dataset['filePath']?.split('/').slice(0, -1).join('/')
        rows.find(row => row.dataset['filePath'] === parent)?.focus()
      }
    }
  }
  const note = path === 'notes/ai.md' || path === 'notes/learning.md'
  return <div className={css.root} data-paper-files>
    <div className={css.layout} data-explorer-collapsed={collapsed} style={{
      '--files-rows': view.files?.split?.rows ?? DEFAULT_FILE_SPLIT.rows,
      '--files-columns': view.files?.split?.columns ?? DEFAULT_FILE_SPLIT.columns,
    } as CSSProperties}>
      <aside className={css.explorer} aria-label={t('paperFiles')}>
        <div className={css.explorerHeader}>
          <button type="button" className={css.rootFolder} title={paper.directory} aria-expanded={!collapsed} onClick={() => { setCollapsed(!collapsed) }}>
            {collapsed ? <IconChevronRightOutlineRegular size={12} /> : <IconChevronDownOutlineRegular size={12} />}<ReferenceIconRegular kind="folder" size={16} /><span>{paper.title}</span>
          </button>
          <Tooltip label={t('refreshFiles')} portal><Button size="sm" variant="ghost" aria-label={t('refreshFiles')} onClick={() => { setRefresh(value => value + 1) }}><IconRefreshOutlineRegular size={14} /></Button></Tooltip>
        </div>
        <div ref={tree} className={css.fileTree} hidden={collapsed} tabIndex={0} onKeyDown={onKeyDown} aria-label={t('browseFiles')}
          onFocus={(event) => { if (event.target === event.currentTarget) (Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')).find(row => row.dataset['filePath'] === path) ?? event.currentTarget.querySelector<HTMLButtonElement>('[role="treeitem"]'))?.focus() }}>
          <Branch {...props} path="" level={1} revision={revision} />
        </div>
      </aside>
      <PaperFileDivider paperId={paper.id} split={view.files?.split} collapsed={collapsed} actions={props.viewActions} t={t} />
      <div className={css.viewer}>
        {path === '' ? <div className={css.empty}><ReferenceIconRegular kind="folder" size={28} /><p>{t('selectFile')}</p><small>{t('selectFileHint')}</small></div>
          : <><div className={css.fileTab} title={path}><FileTypeIcon path={path} size={16} /><span>{path}</span></div>
            {note ? <ResearchNotes key={path} file paper={paper} view={view} t={t} actions={props.viewActions}
              saveNote={props.saveNote} refresh={props.refresh} />
              : <PaperFilePreview key={path} {...props} path={path} revision={revision} />}</>}
      </div>
    </div>
  </div>
}
