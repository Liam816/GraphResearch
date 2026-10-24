---
kind: upgrade-guide
description: "管理论文会话会写入第 3 版资料库索引，旧后端无法读取。"
---

# 论文多会话

[English](guide.md) | 中文

## 变更

一篇论文可以包含多个独立 Agent 会话。原有 `sessionId` 保留为首个会话，PDF、笔记和其他论文文件继续共享。创建、改名、置顶或归档会话时，会在 `library.json` 和 `paper.json` 中写入第 3 版索引及会话元数据。旧后端无法读取该索引。

原会话备份仍位于论文目录下的 `session.json`，新增会话分别备份到 `sessions/conversation-<encoded-session-id>/session.json`。已有的原生会话历史予以保留。

## 迁移

1. 升级前，停止使用该资料库的后端并备份整个资料库。不要让旧后端与新版后端同时访问同一目录。
2. 启动新版后端并刷新浏览器。连接旧后端时，会话管理保持禁用，并显示重启提示。
3. 打开论文，点击**新会话**。确认新聊天从空白开始、原会话仍可选择，且 PDF 和笔记仍可访问。
4. 确认 `library.json` 的 `version` 为 `3`，且论文具有 `conversations` 字段。若需回退到旧后端，先恢复完整备份；手动删除会话元数据会丢失会话归属信息。
