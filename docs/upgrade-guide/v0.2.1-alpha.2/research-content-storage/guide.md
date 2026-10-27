---
kind: upgrade-guide
description: "Research runtime files move into agent-lib, paper directories stop creating empty scaffolding, and new originals use acronym-based filenames."
---

# Research document and runtime storage

English | [中文](guide.zh.md)

## Change

The research library separates user documents from Harness state. `papers/<paper-name>/` starts empty; `topics/<topic-id>/` holds user summaries. The version-4 catalog moves from `library.json` to `agent-lib/library.json`. Entity metadata, Session backups, extracted-page caches and translation state move under `agent-lib/papers/<paper-id>/` and `agent-lib/topics/<topic-id>/`. Public directory names no longer locate runtime state.

Opening an older library automatically relocates known runtime files and removes obsolete empty directories and empty notebooks. Nonempty user documents and directories remain intact. Existing original filenames are retained. New imports use `paper_<abbreviation>.pdf`, matching Markdown and a bibliographic JSON containing no runtime state. Agent import and attachment tools require the acronym; manual UI imports derive a readable fallback from the title. Deleting user documents does not remove the paper or its conversations, and refresh does not recreate deleted successful Markdown outputs or empty notebooks.

Global Agent registration writes catalog version 5 with `libraryConversations` in `agent-lib/library.json`; libraries without global conversations remain version 4. Older backends refuse version 5. Keep the version and index intact to preserve ownership. Topic and paper histories remain separate.

## Migration

1. Stop every backend using this library and back up the complete directory and Harness home. Do not run older and updated backends against the same library.
2. Start the updated project and open the library. Keep `agent-lib` together with `papers` and `topics` when moving or backing up the library.
3. Update scripts to use `research_context` paths and `markdown.path`; do not construct `paper.pdf`, `paper.md` or public Session-backup paths. Agent downloads supply the paper’s core acronym as `abbreviation`.
4. Confirm `agent-lib/library.json` has `version: 4` or `version: 5`, the paper’s conversations remain available, and Related content lists user documents without Harness snapshots. A title-only paper has an empty document directory.

If relocation reports a conflict, stop the backend and preserve `agent-lib/.layout.json` and both reported copies. Resolve the conflicting runtime destination without overwriting either copy, then restart to resume. Other interrupted writes retain `agent-lib/.transaction.json`; preserve it when reporting a recovery failure. To use an older backend, restore the complete backup first; older releases cannot read the new storage layout.
