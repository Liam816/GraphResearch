---
kind: upgrade-guide
description: "Paper translation writes new required Session audit events that older readers cannot recognize."
---

# Paper translation Session records

English | [中文](guide.zh.md)

## Change

Using PDF selection translation appends `research/translation-request` and `research/translation-result` to the paper Session. These records retain independent inference input and validated output without adding conversational messages. Existing Sessions remain readable. Older builds that do not recognize the new events refuse to open a Session after translation has been used; the Session format version remains unchanged because the event discriminators enforce safe refusal.

Translation results and their derived text index live under the paper directory. The [controller reference](../../../../packages/api/workspace-controller/README.md#paper-translation) describes storage and dictionary settings.

## Migration

1. Update frontend and backend together, rebuild the project, and restart the backend. Refresh the browser to load the new selection toolbar and Remote methods.
2. Select original PDF text and click **Translate**. Confirm that an explanation appears and `translations.json` is saved in the paper directory. Existing highlights and notebooks remain available.
3. Use a build that recognizes both audit events when reopening, restoring or exporting translated Sessions. Keep a complete backup before using an older build; restore that backup for rollback instead of deleting audit rows.
4. For hosts that should not query an external dictionary, set `researchDictionaryEndpoint: ""` on the `workspace-controller` config. Translation explanations and device speech remain available; dictionary phonetics show as unavailable.
