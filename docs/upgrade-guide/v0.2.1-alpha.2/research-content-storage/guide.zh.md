---
kind: upgrade-guide
description: "科研运行文件移至 agent-lib，论文目录不再预建空目录，新原文使用基于核心缩写的文件名。"
---

# 科研文档与运行数据存储

[English](guide.md) | 中文

## 变更

科研资料库将用户文档与 Harness 状态分开。`papers/<paper-name>/` 初始为空，`topics/<topic-id>/` 保存用户的主题总结。版本 4 索引从 `library.json` 移至 `agent-lib/library.json`。实体元数据、会话备份、分页正文缓存和翻译状态移至 `agent-lib/papers/<paper-id>/` 与 `agent-lib/topics/<topic-id>/`。运行状态不再通过公开目录名定位。

打开旧资料库时会自动迁移已知运行文件，并移除过时的空目录和空笔记。非空用户文档与目录完整保留，已有原文文件名保留。新导入使用 `paper_<abbreviation>.pdf`、对应 Markdown 及不含运行状态的论文资料 JSON。Agent 导入和关联工具要求提供缩写，手动界面导入则从论文名生成可读的备用名称。删除用户文档不会删除论文或其会话，刷新不会重新创建已删除的成功 Markdown 输出或空笔记。

首次登记全局 Agent 会话后，`agent-lib/library.json` 写为版本 5 并保存 `libraryConversations`；未登记全局会话的资料库仍使用版本 4。旧后端拒绝版本 5。不要手动降低版本或删除全局索引，以免后续保存丢失会话归属。Topic 与论文会话保持独立。

## 迁移

1. 停止所有使用此资料库的后端，并备份整个目录与 Harness home。不要让旧版与更新后的后端同时使用同一资料库。
2. 启动更新后的项目并打开资料库。迁移或备份时，将 `agent-lib` 与 `papers`、`topics` 一并保留。
3. 更新脚本，使用 `research_context` 中的路径和 `markdown.path`，不要拼接 `paper.pdf`、`paper.md` 或公开会话备份路径。Agent 下载时通过 `abbreviation` 提供论文核心缩写。
4. 确认 `agent-lib/library.json` 的 `version` 为 `4` 或 `5`，论文会话仍可访问，关联内容中仅有用户文档，没有 Harness 快照。只填写名称的论文，其文档目录为空。

迁移报告冲突时，停止后端并保留 `agent-lib/.layout.json` 和报告的两份文件。在不覆盖任一副本的前提下处理冲突运行目标，再启动后端继续。其他中断写入保留 `agent-lib/.transaction.json`，报告恢复失败时应保留该文件。需要使用旧后端时，先恢复完整备份；旧版本无法读取新的存储布局。
