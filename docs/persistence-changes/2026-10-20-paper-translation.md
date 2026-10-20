---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-paper-translation

English | [中文](2026-10-20-paper-translation.zh.md)

## Summary

Adds independent paper-translation request and result events with exact model input and position-confirmed explanations.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-paper-translation
baseline: false
changes:
  - root: "event:research/translation-request"
    previous: null
    after: "66b61758b8461fa45f5d65f8186b42a2479793e9dcc6920c2bcac76171d6516e"
    decision: same-version
  - root: "event:research/translation-result"
    previous: null
    after: "e1937ad7cebbb7af09b7c53896033f0d6e03abf3ec52c1e7be996b4470b66e1a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records are unchanged and remain readable. The new discriminators distinguish auxiliary audit records from conversation messages; current readers retain them without adding model history. Older readers refuse these unknown required event types rather than dropping model-visible input. The Session writer version remains unchanged. Translation files and text indexes are additional paper-owned files.

<a id="verification"></a>
## Verification

Focused paper translation, PDF selection and context tests pass, including cancellation, malformed responses, exact source positions, occurrence cache reuse and notebook conflicts. The shipped Web replay covers manual triggering, five-sentence context, persistence, note export, Agent draft insertion and reload reuse. TypeScript and Python SDK projection fixtures retain both audit events and the original main response.

<a id="dev-note"></a>
## Dev Note

None.
