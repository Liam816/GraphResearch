---
kind: upgrade-guide
description: "Managing paper conversations writes research library index version 3, which older backends cannot read."
---

# Paper conversations

English | [中文](guide.zh.md)

## Change

A paper can have several independent Agent conversations. The original `sessionId` remains its first conversation; PDF, notes and other paper files remain shared. Creating, renaming, pinning or archiving conversations writes their metadata to `library.json` and `paper.json` using index version 3. Older backends cannot read this index.

The original conversation backup stays at `session.json` beneath the paper directory. Additional conversations have separate `sessions/conversation-<encoded-session-id>/session.json` backups. Existing native Session histories are retained.

## Migration

1. Stop backends using the library and back up the library before upgrading. Do not run older and updated backends against the same directory.
2. Start the updated backend and refresh the browser. An old backend leaves conversation management disabled and shows a restart notice.
3. Open a paper and choose **New conversation**. Confirm that the new chat starts empty, the original conversation remains selectable, and PDF and notes remain available.
4. Confirm that `library.json` has `version: 3` and the paper has `conversations`. To return to an older backend, restore the complete backup first; removing conversation metadata manually loses its ownership information.
