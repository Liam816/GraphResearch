---
kind: upgrade-guide
description: "论文 PDF 和笔记迁移到可配置的文件资料库。"
---

# 论文资料库文件

[English](guide.md) | 中文

## 变更

科研内容保存在统一资料目录中，初始位置为应用启动目录下的 `data`。`workspace-controller` 的 `researchDirectory` 配置可以更改初始位置。在科研界面中选择的目录会跨重启保存，并优先于初始配置。

每篇论文使用稳定的子目录，包含 PDF 原文、独立的 `notes/ai.md` 和 `notes/learning.md`、元数据、提取正文，以及代码和资源目录。Markdown 文件保存笔记正文。旧科研 storage domain 导入目录和笔记后，仅保留资料目录选择。原始导入 PDF 文件保留。

笔记变化通过 `workspace.researchFollow` 推送；重连替换基线。科研实体的 Agent 获得作用域内的论文阅读和笔记工具。已有 Session 持久化代次保持不变。

## 迁移

1. 首次使用新版本前，备份原有 Harness home 和 PDF 原文。
2. 从项目根目录启动 Web profile，或在启动前将 `workspace-controller` 的 `researchDirectory` 配置为后端机器上的绝对路径。首次使用会将已有目录和笔记导入该位置。缺失的 PDF 原文不会丢弃迁移后的笔记；阅读前将 PDF 复制到该论文的 `paper.pdf` 位置。
3. 检查 `library.json` 和各篇论文的 Markdown 文件。在科研侧栏打开“论文资料目录”，选择其他资料库，或将当前资料迁移到一个空目录。迁移保留原目录。
4. 自定义客户端需要订阅 `researchFollow`，并在推送的笔记版本变化时保留编辑草稿。笔记写入仍要求 `expectedRevision`；冲突后重新读取并合并。保存中断后，先刷新以完成事务日志恢复，再重试。
5. 自定义 Host 组合需要向 `workspace-controller` 提供 `agents`、`sessionController` 和 `sessionPersistence`。项目自带的 Web profile 已提供这些服务。打开复制的资料库时，仅在原生日志不存在的情况下恢复兼容的实体 Session 快照；附件和其他框架状态仍需保留 Harness home 备份。
