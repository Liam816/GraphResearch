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

Each paper can own multiple independent Agent Sessions. Runtime responses advertise `capabilities.paperConversations`; this flag is absent in older Hosts and is not persisted. `researchCreateConversation` attaches a fresh, unseeded Session from the paper’s Topic Workspace; it rejects reused entity Sessions or existing chat histories. `researchUpdateConversation` manages names, pins and archive state; renames check `expectedTitle`, and archiving rejects active work. An absent `conversations` field projects the original `sessionId` as the first reading conversation. Library metadata uses index version 4. PDF, files and notebooks remain paper-owned; new conversations receive the same research tools and working directory without copying another transcript. Continuation points and first-question names belong to the current conversation. One conversation per paper may execute an Agent turn at a time; archived conversations must be restored before submitting prompts. Backups live under `agent-lib/papers/<paper-id>/`: the original uses `session.json`, and additional conversations use `sessions/conversation-<encoded-session-id>/session.json`. Library restoration recovers each missing native Session without replacing existing history.

The research library starts at `<launch-directory>/data`; `researchDirectory` configures its initial absolute Host path, and the persisted UI selection takes precedence thereafter. User documents live in `papers/<paper-name>/` and `topics/<topic-id>/`; a new paper directory is empty. `agent-lib/library.json` owns the version-4 catalog. Runtime metadata, Session snapshots, page-text caches, translation indexes and saved translations live under `agent-lib/papers/<paper-id>/` or `agent-lib/topics/<topic-id>/`, independently of public folder names. Notes are created only when text is written. Opening an older library relocates known runtime files and removes only obsolete empty scaffolding; existing documents and nonempty directories remain intact. [Storage migration](../../../docs/upgrade-guide/v0.2.1-alpha.2/research-content-storage/guide.md) describes recovery and downgrade requirements.

Paper directories use the supplied paper title, preserving Unicode and removing characters forbidden in filenames. A Topic Agent can create multiple child papers with `research_import_paper`, using the user’s name or choosing a recognizable title before saving files. Case-equivalent names get ` (2)`, ` (3)`, and later suffixes; paper IDs remain independent. The index records each assigned folder, so notebook writes, PDF attachment, Markdown extraction, and library copying resolve that location. Runtime snapshots resolve the stable paper ID instead. Version-1 UUID folders migrate automatically on library opening under the library lock; the recoverable move journal retain paper IDs, Sessions, notebooks and other files. Occupied migration destinations stop recovery without replacing either directory. [Upgrade steps](../../../docs/upgrade-guide/v0.2.1-alpha.2/research-paper-directories/guide.md) explain path changes and recovery.

`researchImportPaper` creates a paper from its title, optionally copying a local PDF or downloading an HTTP(S) source. An absent original has an empty `pdfPath`. `researchAttachPdf` supplies an existing paper’s PDF without changing its identity, Session or notes; identical retries are safe and a different existing PDF is rejected. Explicit attachment preserves the target even when another paper has the same bytes. Matching arXiv/DOI identities or PDF bytes reuse the existing paper and add its Topic association. Versioned arXiv identifiers retain their version. Entity Sessions remain independent. `researchReadPaper` returns bounded original text with page numbers and caches the result beneath the paper’s private runtime directory; image-only pages require OCR. `researchProgress` saves a continuation point, and `researchTopicNote` saves a revision-checked comparison summary. Agent import and attachment tools require an explicit core `abbreviation`, such as OpenVLA or RT2. Originals, converted text and a user-owned bibliographic record use `paper_<abbreviation>.pdf`, `.md` and `.json`. `researchAttachPdf.folder` chooses a paper-relative subfolder; the PDF, Markdown and bibliographic JSON stay together there. Reattaching a local original already inside the paper retains its parent folder when this option is omitted. Direct UI imports without an acronym derive a readable filename from the title. The bibliographic JSON contains source information, never Session or runtime state. General Agent filesystem tools may freely organize user documents within the paper directory.

An attached PDF automatically produces `paper_<abbreviation>.md` beside its original during creation, attachment, library opening, and catalog refresh. Extraction is serialized with library writes and completes before the command returns; each paper has a configurable deadline. Unprocessed originals are backfilled. Successful outputs with the same source digest are reused; deleting a generated Markdown file does not recreate it on refresh. Explicit conversion retry recreates a requested output. A different existing Markdown document is retained with `output-conflict`; move or rename it before retrying. Deleting the original detaches it while retaining the paper, conversations and other documents. `researchPdfTextBackend` defaults to `auto`: Poppler's `pdftotext -layout` when available, otherwise PDF.js with bundled character maps and standard fonts. Both preserve extracted text from every original page, including references and appendices, under `## Page N` headings. This is text extraction, without model rewriting or mathematical/table reconstruction.

`researchMaxMarkdownBytes` bounds the complete UTF-8 document including page headings (default 8 MiB); `researchMarkdownTimeoutMs` bounds conversion (default 60 seconds). Over-limit documents fail instead of being truncated; PDFs without a text layer require OCR. Conversion uses the imported byte snapshot and atomically publishes the complete Markdown. Failure retains the PDF and notebooks, records `paper.markdown.status: failed` and a stable reason, and leaves any previous Markdown unconfirmed. The PDF panel reports the failure and exposes `researchExtractMarkdown` for explicit retry; ordinary refreshes do not repeatedly retry the same failed source. Successful metadata records the source digest, filename, page count, and extraction backend. Library migration retains the Markdown and status; these optional fields leave older unprocessed libraries readable.

`researchHighlight` adds or removes one stable text-selection identity. Additions validate colors, page numbers, and normalized rectangles; duplicate identical additions and absent removals are safe retries. Other selections remain intact across concurrent edits. Highlights are stored in private paper metadata and the library index, follow library migration, and arrive through the existing research snapshot stream. `researchMaxHighlightBytes` bounds the complete serialized annotation list per paper (default 4 MiB). A failed save retains the last confirmed catalog and may leave a recoverable journal; repeating the same change completes recovery without duplicating the marker. Existing unannotated libraries need no conversion. Catalog responses advertise `capabilities.pdfHighlights`; this runtime flag is not written into the library.

`researchRenameTopic` accepts a Topic id, new title, and the editor's `expectedTitle`. It trims and validates the title, rejects a missing Topic, and returns `research/topic-conflict` when another writer changed the name. Repeating an already-applied rename succeeds without another revision. The existing library transaction updates `agent-lib/library.json` and private Topic metadata; Topic identity, notes, Session, directory, and paper associations remain stable. Failed writes may retain a recoverable journal: refresh the library before retrying.

`researchDeleteTopic` confirms the exact Topic path and the complete set of exclusive paper IDs and paths before archiving or staging files. It rejects running related work and stale contents. A single `agent-lib/.transaction.json` stages the Topic and exclusive papers, publishes their removal and shared-paper detachment together, then deletes staged files and private runtime records. Reads resume interrupted staging or cleanup; occupied destinations stop recovery and preserve both copies. Shared papers and their conversations remain available. Native histories are archived rather than deleted; a shared Workspace is retained.

`researchDeletePaper` requires a paper id and the exact absolute directory confirmed by the user. The Host verifies current metadata, rejects linked or mismatched directories and active paper/Topic work, and archives the paper Session to block later prompts. A journal stages the verified directory under `agent-lib/.paper-deletions/`, publishes the remaining index, then permanently removes the staged files. Interrupted operations retain the journal and resume on the next library read; recovery never deletes a replacement at the original path. Failure may leave the Session archived or deletion partially applied: refresh before retrying. Native Session generations are retained.

`researchListFiles` lists direct children inside one paper; `researchReadFile` returns complete UTF-8 text or an image under `researchMaxNoteBytes`, with explicit binary and oversized outcomes. Paths are paper-relative and reject traversal and symbolic links. `researchSaveFile` edits existing Markdown only and requires its SHA-256 `expectedVersion`; a conflict writes nothing. I/O failures retain browser drafts and require reloading the file before retrying. Managed notebook changes also publish through the research catalog stream.

`researchFollow` sends a full baseline and replacement snapshots for committed or externally observed notebook changes; reconnecting starts a new baseline. Browser drafts remain separate from confirmed text. Writes serialize across cooperating processes, check `expectedRevision`, and publish Markdown plus metadata through a recoverable journal. A stale edit writes nothing. An I/O failure can leave a pending journal: refresh completes recovery before retrying; conflicting external changes during recovery are reported rather than overwritten. Deleted notebooks become empty with an advanced revision and are not recreated by unrelated saves. Invalid metadata and watcher failures remain visible while the browser retains its last confirmed data. Managed paths reject symbolic links.

`researchConfigure` opens another library or copies the current library into an empty directory and persists the selection after preparation. Migration retains the source. Research Sessions maintain `session.json` snapshots under `agent-lib` using explicit reads of the existing persistence provider; native Session generations stay unchanged. Deployment limits are configurable through `researchMaxNoteBytes`, `researchMaxPdfBytes`, `researchDownloadTimeoutMs`, `researchMaxReadPages`, `researchMaxReadCharacters`, `researchLockTimeoutMs`, `researchWatchStabilityMs`, and `researchWatchPollMs`.

`researchMentions` returns canonical Session references for up to three selected papers. These references remain draft text until the user sends a prompt; the existing Session-reference service owns context capture and logging. The Session persistence format is unchanged.

Opening a copied library restores compatible `session.json` snapshots only when the native persistence provider has no matching Session, then repairs missing Workspace bindings. Existing native logs remain authoritative. Snapshots update after Session events; keep the Harness home when backing up attachments and other framework-owned state. Custom Host compositions must provide `agents`, `sessionController`, and `sessionPersistence` alongside the existing controller dependencies; the shipped Web profile supplies them.

<a id="paper-translation"></a>
#### Paper translation

`researchTranslate` accepts an explicit PDF selection identified by nonempty PDF.js text-item ordinals and UTF-16 offsets. The Host verifies the selected occurrence against the managed PDF, reconstructs common two-column reading order, and selects the containing sentences plus up to two sentences on either side within the same body, heading, caption or reference block. Cross-page body sentences can continue. Repeated margin text is excluded; limited context is reported. Image-only originals require OCR. Complex layouts can require reselection; this is heuristic layout reconstruction.

`agent-lib/papers/<paper-id>/cache/text-index.json` is rebuildable and tied to the original SHA-256. `agent-lib/papers/<paper-id>/translations.json` owns validated results keyed by PDF bytes, occurrence, original context, paper title, model route, prompt and dictionary endpoint. Requests use the paper Agent’s selected model through an independent prepared call, without a conversation turn or tools. Exact prepared input is flushed in `research/translation-request` before dispatch; validated output is flushed in `research/translation-result` before the result file is published. Failed or canceled requests retain the original, notebooks and any previous results. Notebook changes require `researchSaveTranslation`, which appends a cited Markdown entry once and checks the current learning-note revision. A conflict preserves existing text and permits an explicit retry.

`researchTranslationTimeoutMs`, `researchTranslationMaxContextCharacters`, `researchTranslationMaxOutputTokens`, `researchTranslationMaxResponseBytes`, `researchTranslationMaxStoredBytes` and `researchTranslationMaxIndexBytes` bound each operation and complete retained value. Defaults are 60 seconds, 16,000 context characters, 2,048 output tokens, 256 KiB response bytes, 8 MiB history and 32 MiB text index. The optional [dictionary endpoint](https://dictionaryapi.dev/) supplies English phonetics, never generated by the model; `researchDictionaryEndpoint` defaults to its English entries URL and accepts an empty string to disable lookup. `researchDictionaryTimeoutMs` defaults to four seconds. Missing dictionary entries or lookup failures leave the explanation available with phonetics explicitly unavailable. Device speech is owned by the reader. [Session compatibility](../../../docs/upgrade-guide/v0.2.1-alpha.2/paper-translation/guide.md) describes the new audit records.

<a id="model-experience"></a>
## Model Experience

### Research context and notebooks

#### What the model sees

Ordinary Workspace organization contributes no prompt or tools. Research entity Agents receive scoped `research_context`, `research_import_paper`, `research_attach_pdf`, `research_read_paper`, `research_write_note`, `research_update_progress`, and `research_write_topic_note` tools. Their required runtime context names the selected library, paper directory, original PDF, Markdown conversion status, notebook revisions, and continuation point. Existing prompt-context admission logs these facts; tool calls and results use normal Session tool events. Reading notebook text is explicit through `research_context`, which also returns saved highlight text, colors, and page-relative rectangles. Highlighting itself starts no model turn. Learning-note edits require an explicit user request.

#### Token effect

Research tools add schemas to each research Agent request. Required context adds paths, identifiers, revisions, and the saved continuation point; reading a notebook or PDF adds the requested content through tool results. PDF page and character limits bound each extraction.

#### KV Cache effect

Ordinary Workspace mutations do not alter requests. Research notebook revisions, directory changes, and continuation points replace the logged runtime context at request admission; tool schemas remain scoped to research entity Agents.

### Paper translation

#### What the model sees

An auxiliary request contains the paper title, exact selected text, containing sentence(s), up to two preceding and following original sentences, original page numbers and a limited-context flag. The fixed [translation prompt](src/research-translation.ts) requires a Chinese JSON explanation separating general meanings from contextual interpretation and excludes invented phonetics or paper claims. The [recorded request](../../../snapshots/web/research-translation/session.v4.jsonl) pins these instructions verbatim. The paper’s prior conversation and tools are absent. Main conversation messages remain unchanged; both auxiliary request and result are durable Session audit events.

#### Token effect

Each uncached selection consumes one independent model request within the configured input/output budgets. Saved matching results reuse the paper file without another model call. Phonetic lookup consumes no model tokens. Saving to learning notes makes the saved Markdown available to later explicit notebook reads.

#### KV Cache effect

Independent requests repeat the fixed instruction prefix. Their paper excerpts vary by occurrence; provider caching remains provider-owned. Auxiliary results enter main conversation context only through a reader-sent prompt or a subsequent notebook read.

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
