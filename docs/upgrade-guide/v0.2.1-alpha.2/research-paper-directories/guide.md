---
kind: upgrade-guide
description: "Research paper directories change from UUIDs to readable paper names, with versioned library indexes for readable folders and paper conversations."
---

# Research paper directory names

English | [中文](guide.zh.md)

## Change

Papers now live in `<library>/papers/<paper-name>/` instead of `<library>/papers/<paper-id>/`. The supplied title names a new directory; filename restrictions and duplicate-name suffixes can change its spelling. The library records that assigned name independently of the paper ID. Topic Agents use the existing `research_import_paper` tool to create child papers with an explicit title.

Opening an existing library automatically moves UUID directories; the [document/runtime storage layout](../research-content-storage/guide.md) writes the current version-4 index under `agent-lib`. Paper IDs, Session identities, original files, notebooks, extracted text, code and assets remain intact. Scripts or external links containing UUID paths need updating. The index also retains paper-conversation names, pins, archive state and continuation points. Older backends cannot read these upgraded indexes.

## Migration

1. Stop every backend using this library and keep a backup before starting the updated backend. Do not run older and updated backends against the same directory.
2. Start the updated project normally. Open the research library; no manual directory renaming is required.
3. Update external scripts and links to the paper’s current `directory` or `pdfPath` returned by `research_context`. Do not construct paths from paper IDs. The frontend and Agent tools resolve the assigned directory automatically.
4. Confirm that `agent-lib/library.json` has `version: 4`, each paper has a readable `folder`, and its PDF and notes open in the frontend. For multi-conversation papers, confirm that the Agent column can switch conversations and that the original conversation remains available. Backups live beneath `agent-lib/papers/<paper-id>/`.

If startup reports a directory migration conflict, stop the backend and preserve `.transaction.json` and both reported directories. Move the unrelated conflicting destination aside, then restart the updated backend to resume. Do not delete the journal or overwrite either directory. To return to an older backend, restore the complete backup first.
