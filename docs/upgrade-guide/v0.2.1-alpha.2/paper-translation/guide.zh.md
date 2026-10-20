---
kind: upgrade-guide
description: "论文翻译会写入旧读取方无法识别的必要 Session 审计事件。"
---

# 论文翻译 Session 记录

[English](guide.md) | 中文

## 变更

使用 PDF 划词翻译时，会向论文 Session 追加 `research/translation-request` 和 `research/translation-result`，记录独立模型输入和已验证输出，不增加对话消息。已有 Session 仍然可读。尚不识别新事件的旧版程序会拒绝打开已经使用翻译功能的 Session；事件判别值可以确保安全拒绝，因此 Session 格式版本保持不变。

翻译结果和可重建文字索引保存在论文目录下。[控制器参考](../../../../packages/api/workspace-controller/README.zh.md#paper-translation)说明存储与词典设置。

## 迁移

1. 同时更新前后端，重新构建项目并重启后端，刷新浏览器加载新的划词工具条和 Remote 方法。
2. 在 PDF 原文中选中文字并点击**翻译**，确认解释正常显示，论文目录内已保存 `translations.json`，原有高亮和笔记仍可使用。
3. 重新打开、恢复或导出已翻译 Session 时，使用识别这两种审计事件的版本。使用旧版前保留完整备份；回退时恢复备份，不要删除审计行。
4. 如 Host 不应查询外部词典，可在 `workspace-controller` 配置中设置 `researchDictionaryEndpoint: ""`。翻译解释和设备朗读仍可使用，词典音标明确显示暂无。
