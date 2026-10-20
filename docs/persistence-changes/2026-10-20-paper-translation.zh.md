---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-paper-translation

[English](2026-10-20-paper-translation.md) | 中文

## 概述

新增独立论文翻译请求和结果事件，记录准确模型输入及已定位原文的解释。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有 Session 记录保持不变并可继续读取。新判别值将辅助审计记录与对话消息区分，当前读取方保留记录而不增加模型对话历史。旧读取方遇到未知的必要事件时拒绝打开，避免丢弃模型可见输入。Session 写入版本保持不变。翻译文件和文字索引是论文目录下的新增文件。

<a id="verification"></a>
## 验证

论文翻译、PDF 选区及上下文定向测试通过，覆盖取消、无效响应、准确定位、选区缓存复用和笔记冲突。自带 Web 组合回放覆盖手动触发、五句上下文、持久化、笔记导出、Agent 草稿插入及刷新复用。TypeScript 与 Python SDK 投影快照保留两类审计事件以及原有主回复。

<a id="dev-note"></a>
## 开发备注

无。
