---
description: "Host and Client workspace control: mutate workspace navigation and follow its complete projection."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, and reorder Workspaces, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, and `pinned` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault()` returns the durable default Workspace; the Client service exposes it as `workspaces.initializeDefault(signal?)`. It takes no request: the Host owns the fixed `default-workspace` directory name, and the registry derives the initial title from that same segment, so one installation keeps one on-disk path and one stored title in every language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. OS filename restrictions apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup and is never renamed or relocated. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

`DEFAULT_WORKSPACE_DIRECTORY` and `workspaceDisplayTitle(title, localizedDefault)` are published from `./default-workspace` for browser consumers: a Workspace still carrying the automatic title reads as the reader's localized default name, and every other title reads verbatim. A Workspace the user renamed to exactly `default-workspace` — or a folder of that name adopted from the picker — is labeled as the default; nothing else depends on the distinction.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

-----

<a id="research-catalog"></a>
### Research catalog

The research library starts at `<launch-directory>/data`; `researchDirectory` configures its initial absolute Host path, and the UI's persisted directory selection takes precedence thereafter. `library.json` owns Topic and paper metadata. Each stable `papers/<paper-id>/` contains an optional `paper.pdf` and generated `paper.md`, `paper.json`, `notes/ai.md`, `notes/learning.md`, `extracted/`, `code/`, and `assets/`. Markdown files own notebook text; the index records revisions and content digests. Topics have `topics/<topic-id>/notes.md`. Existing research-domain records migrate on first use; the domain then retains only the selected directory. Missing legacy PDFs leave their notebooks available and can be supplied at the managed `paper.pdf` path.

`researchImportPaper` creates a paper from its title, optionally copying a local PDF or downloading an HTTP(S) source. An absent original has an empty `pdfPath`. `researchAttachPdf` supplies an existing paper’s PDF without changing its identity, Session or notes; identical retries are safe and a different existing PDF is rejected. Explicit attachment preserves the target even when another paper has the same bytes. Matching arXiv/DOI identities or PDF bytes reuse the existing paper and add its Topic association. Versioned arXiv identifiers retain their version. Entity Sessions remain independent. `researchReadPaper` returns bounded original text with page numbers and caches the result beneath the paper; image-only pages require OCR. `researchProgress` saves a continuation point, and `researchTopicNote` saves a revision-checked comparison summary.


An attached PDF automatically produces `papers/<paper-id>/paper.md` during creation, attachment, library opening, and catalog refresh. Extraction is serialized with library writes and completes before the command returns; each paper has a configurable deadline. Existing libraries are backfilled, missing successful outputs are regenerated, and successful outputs with the same source digest are reused. `researchPdfTextBackend` defaults to `auto`: Poppler's `pdftotext -layout` when available, otherwise PDF.js with bundled character maps and standard fonts. Both preserve extracted text from every original page, including references and appendices, under `## Page N` headings. This is text extraction, without model rewriting or mathematical/table reconstruction.

`researchMaxMarkdownBytes` bounds the complete UTF-8 document including page headings (default 8 MiB); `researchMarkdownTimeoutMs` bounds conversion (default 60 seconds). Over-limit documents fail instead of being truncated; PDFs without a text layer require OCR. Conversion uses the imported byte snapshot and atomically publishes the complete Markdown. Failure retains the PDF and notebooks, records `paper.markdown.status: failed` and a stable reason, and leaves any previous Markdown unconfirmed. The PDF panel reports the failure and exposes `researchExtractMarkdown` for explicit retry; ordinary refreshes do not repeatedly retry the same failed source. Successful metadata records the source digest, filename, page count, and extraction backend. Library migration retains the Markdown and status; these optional fields leave older unprocessed libraries readable.

`researchHighlight` adds or removes one stable text-selection identity. Additions validate colors, page numbers, and normalized rectangles; duplicate identical additions and absent removals are safe retries. Other selections remain intact across concurrent edits. Highlights are stored in the paper’s `paper.json` and library metadata, follow library migration, and arrive through the existing research snapshot stream. `researchMaxHighlightBytes` bounds the complete serialized annotation list per paper (default 4 MiB). A failed save retains the last confirmed catalog and may leave a recoverable journal; repeating the same change completes recovery without duplicating the marker. Existing unannotated libraries need no conversion. Catalog responses advertise `capabilities.pdfHighlights`; this runtime flag is not written into the library.

`researchFollow` sends a full baseline and replacement snapshots for committed or externally observed notebook changes; reconnecting starts a new baseline. Browser drafts remain separate from confirmed text. Writes serialize across cooperating processes, check `expectedRevision`, and publish Markdown plus metadata through a recoverable journal. A stale edit writes nothing. An I/O failure can leave a pending journal: refresh completes recovery before retrying; conflicting external changes during recovery are reported rather than overwritten. Invalid metadata, missing notebook files, and watcher failures remain visible while the browser retains its last confirmed data. Managed paths reject symbolic links.

`researchConfigure` opens another library or copies the current library into an empty directory and persists the selection after preparation. Migration retains the source. Research Sessions maintain `session.json` snapshots inside their entity directories using explicit reads of the existing persistence provider; native Session generations stay unchanged. Deployment limits are configurable through `researchMaxNoteBytes`, `researchMaxPdfBytes`, `researchDownloadTimeoutMs`, `researchMaxReadPages`, `researchMaxReadCharacters`, `researchLockTimeoutMs`, `researchWatchStabilityMs`, and `researchWatchPollMs`.

`researchMentions` returns canonical Session references for up to three selected papers. These references remain draft text until the user sends a prompt; the existing Session-reference service owns context capture and logging. The Session persistence format is unchanged.

Opening a copied library restores compatible `session.json` snapshots only when the native persistence provider has no matching Session, then repairs missing Workspace bindings. Existing native logs remain authoritative. Snapshots update after Session events; keep the Harness home when backing up attachments and other framework-owned state. Custom Host compositions must provide `agents`, `sessionController`, and `sessionPersistence` alongside the existing controller dependencies; the shipped Web profile supplies them.

<a id="model-experience"></a>
## Model Experience

### Research context and notebooks

#### What the model sees

Ordinary Workspace organization contributes no prompt or tools. Research entity Agents receive scoped `research_context`, `research_import_paper`, `research_attach_pdf`, `research_read_paper`, `research_write_note`, `research_update_progress`, and `research_write_topic_note` tools. Their required runtime context names the selected library, paper directory, original PDF, Markdown conversion status, notebook revisions, and continuation point. Existing prompt-context admission logs these facts; tool calls and results use normal Session tool events. Reading notebook text is explicit through `research_context`, which also returns saved highlight text, colors, and page-relative rectangles. Highlighting itself starts no model turn. Learning-note edits require an explicit user request.

#### Token effect

Research tools add schemas to each research Agent request. Required context adds paths, identifiers, revisions, and the saved continuation point; reading a notebook or PDF adds the requested content through tool results. PDF page and character limits bound each extraction.

#### KV Cache effect

Ordinary Workspace mutations do not alter requests. Research notebook revisions, directory changes, and continuation points replace the logged runtime context at request admission; tool schemas remain scoped to research entity Agents.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.
- Session snapshot recovery preserves recorded working-directory paths. Moving a library between machines requires those original directories to remain accessible; automatic Session path rewriting is not supported.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
