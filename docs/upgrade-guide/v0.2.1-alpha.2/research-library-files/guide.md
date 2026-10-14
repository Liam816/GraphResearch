---
kind: upgrade-guide
description: "Research PDFs and notebooks move into a configurable file-backed library."
---

# Research library files

English | [中文](guide.zh.md)

## Change

Research content now lives under a managed directory, initially `data` beneath the application launch directory. `researchDirectory` on the `workspace-controller` row changes the initial location. The directory selected in the research UI persists across restarts and takes precedence over that initial value.

Each paper has a stable directory containing its original PDF, separate `notes/ai.md` and `notes/learning.md`, metadata, extracted text, and code and asset directories. The Markdown files own notebook text. The old research storage domain retains the directory selection after importing its catalog and notebooks. Original imported PDF files remain in place.

Notebook changes now arrive through `workspace.researchFollow`; reconnecting replaces the baseline. Research entity Agents receive scoped reading and notebook tools. Existing Session persistence generations are unchanged.

## Migration

1. Back up the existing Harness home and original PDFs before the first upgraded launch.
2. Start the Web profile from the project root, or set `researchDirectory` to an absolute Host path in the `workspace-controller` configuration before launch. First use imports the existing catalog and notebooks into that directory. A missing original PDF does not discard its migrated notebooks; copy the PDF into the paper's `paper.pdf` location before reading it.
3. Check `library.json` and each paper's Markdown files. In the research sidebar, open **Paper library directory** to select another library or migrate the current library into an empty destination. Migration retains the source directory.
4. For custom clients, subscribe to `researchFollow` and retain drafts when a pushed notebook revision changes. Notebook writes still require `expectedRevision`; reread and merge after a conflict. After an interrupted save, refresh to complete its journal recovery before retrying.
5. Custom Host compositions must provide `agents`, `sessionController`, and `sessionPersistence` to `workspace-controller`. The shipped Web profile already supplies these services. Opening a copied library restores compatible entity Session snapshots only if native logs are absent; keep the Harness home backup for attachments and other framework state.
