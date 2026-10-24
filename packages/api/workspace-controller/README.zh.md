---
description: "Host 与 Client 工作区控制：修改工作区导航并跟随其完整投影。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 服务和生成的 Client `ctx.remote.workspace` namespace。它的 Remote 方法负责创建、重命名、移除和重排 Workspace，在 Workspace 内重排 Session，归档与取消归档 Session，以及跟随完整的 Workspace 投影。当 Client 必须修改或跟随 Workspace 导航时，请通过 API 网关使用它。本包同时拥有 `ctx.directoryPickerController` 与生成的 `ctx.remote.directoryPicker` namespace，因为它承载的选目录 seam 是抽象的，自身从不作为 Loader entry。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器会串行执行正确性取决于当前注册表状态的变更，并为预期失败抛出带有稳定错误码的 `RemoteError`。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order`、`archived` 和 `pinned` 增量。归档与置顶集合都是会话 id 数组，置顶数组把最近置顶的 id 放在前面。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。不带 `stopActivity` 的 `archiveSession` 会以 `workspace/session-active` 拒绝仍有工作在跑的会话，其 details 按族（`turn`、`subagent`、`job`、`schedule`）列出这些工作及各项的 id 与名称；带 `stopActivity: true` 时注册表的提供方先停止这些工作，归档集合持久化后即返回响应，停止在后台收敛。

Client 入口提供 `ClientWorkspaceModel` 和 `createWorkspaceStateStream()`。该模型拥有 Workspace 行、registry 顺序、归档与置顶会话身份、一元变更回显，以及流与一元调用的竞态处理。较新的 Host 行按 `updatedAt` 获胜；已提交的流顺序优先于较旧的一元响应；已经移除的 Workspace id 不会被延迟数据复活。置顶快照仅在会话身份或顺序变化时更新。该包公开与框架无关的快照和订阅，把导航策略与 React 钩子留给 UI owner。`WorkspaceController.archiveSession(sessionId, { stopActivity })` 抛出携带 Host `rpcError` 的 `WorkspaceArchiveError`，界面因此能区分"仍有工作在跑"的拒绝与会话缺失或载体故障，并提议停止这些工作。

<a id="first-use-workspace"></a>
### 首次使用工作区

`workspace.initializeDefault()` 返回持久化的默认工作区；Client service 通过 `workspaces.initializeDefault(signal?)` 提供该操作。它不接受请求参数：固定目录名 `default-workspace` 由 Host 拥有，注册表也以同一路径片段作为初始标题，因此任何语言下同一安装环境都只有一个磁盘路径和一个存储标题。Host 将目录放在其账户的 `<Documents>/deepseek-harness` 下，远程 Web Host 也遵循此规则。操作系统的文件名限制同样适用。Linux 系统查询要求存在 `xdg-user-dir` 且启用了 Documents 目录；不具备该条件的 Host 必须配置 `documentsDirectory` 或使用文件夹选择器。

[Workspace 注册表](../../workspace/workspace/README.zh.md#first-use-workspace)负责资格判断、目录创建和持久化初始化。已有默认工作区直接返回，不再查询 Documents，也不会被重命名或迁移。不满足首次使用条件时返回 `undefined`，启动流程可将目录选择留给用户。查询和创建失败遵循标准 Remote 错误处理。初始化不创建 Session，也不发送消息。

`./default-workspace` 为浏览器消费方导出 `DEFAULT_WORKSPACE_DIRECTORY` 与 `workspaceDisplayTitle(title, localizedDefault)`：仍保留自动标题的工作区按读者语言显示默认名称，其他标题一律原样显示。被用户重命名为 `default-workspace` 的工作区，或从选择器采用的同名文件夹，也会按默认工作区显示；除显示之外没有其他行为依赖该判断。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `documentsDirectory` | 系统 Documents 目录 | 完全限定的 Host 目录覆盖值 |
| `documentsLookupTimeoutMs` | `10000` | 操作系统目录查询的正数最大时长，单位为毫秒 |

Documents 查询占用注册表变更队列，因此其他 Workspace 变更（包括登记已选目录）最多可能等待 `documentsLookupTimeoutMs`。取消可以停止查询；解析成功后，取消不会回滚创建或登记。

-----

<a id="research-catalog"></a>
### 研究目录

每篇论文可拥有多个独立 Agent 会话（Session）。运行时响应通过 `capabilities.paperConversations` 标明支持；旧后端不提供此标志，标志也不会持久化。`researchCreateConversation` 关联论文 Topic 工作区内全新、未继承历史的会话，拒绝其他实体已使用的会话或已有聊天记录。`researchUpdateConversation` 管理名称、置顶和归档；改名校验 `expectedTitle`，归档拒绝仍在运行的任务。未保存 `conversations` 的论文将原 `sessionId` 视为首个阅读会话。管理会话后，论文库索引写为版本 3。PDF、文件和笔记由论文共享，新会话获取相同的科研工具和工作目录，不复制旧聊天。续读点和首问生成的名称归当前会话所有。同一论文同时只执行一个 Agent 会话的任务；已归档会话须先恢复才能提问。原备份仍为 `session.json`，新增会话分别保存到 `sessions/conversation-<encoded-session-id>/session.json`。恢复论文库时，每个缺失的原生会话均可从备份恢复，已有历史不会被覆盖。 [会话迁移说明](../../../docs/upgrade-guide/v0.2.1-alpha.2/paper-conversations/guide.zh.md)。

论文资料库初始位置为 `<启动目录>/data`；`researchDirectory` 配置初始后端绝对路径，之后以界面持久化的目录选择为准。`library.json` 管理 Topic 和论文元数据。稳定的 `papers/<paper-id>/` 子目录包含可选的 `paper.pdf` 和生成的 `paper.md`、`paper.json`、`notes/ai.md`、`notes/learning.md`、`extracted/`、`code/` 和 `assets/`。Markdown 文件保存笔记正文，索引记录版本与内容摘要。Topic 使用 `topics/<topic-id>/notes.md`。首次使用会迁移已有科研 domain 记录，此后 domain 仅保留选中的资料目录。缺失的旧 PDF 不影响笔记读取，可补充到对应的 `paper.pdf` 位置。

`researchImportPaper` 可仅凭标题创建论文，也可同时复制本地 PDF 或下载 HTTP(S) 来源。未添加原文时 `pdfPath` 为空。`researchAttachPdf` 为现有论文补充 PDF，保留论文身份、Session 和笔记；相同内容可安全重试，不同的已有 PDF 拒绝覆盖。显式补充 PDF 时，即使另一论文具有相同内容，也保留目标实体。匹配的 arXiv/DOI 身份或相同 PDF 字节复用现有论文并增加 Topic 关联。带版本的 arXiv 标识保留版本。各实体使用独立 Session。`researchReadPaper` 返回有页码的有限原文，并在论文目录下缓存结果；纯图片页面需要 OCR。`researchProgress` 保存续读位置，`researchTopicNote` 保存有版本检查的对比总结。


关联 PDF 后，会在创建论文、关联原文、打开资料库和刷新目录时自动生成 `papers/<paper-id>/paper.md`。转换与资料库写入串行执行，命令在转换结束后返回，每篇论文都有可配置的时限。已有资料库会补转换；已成功转换但缺失的文件会重新生成；原文摘要相同且文件仍存在时直接复用。`researchPdfTextBackend` 默认为 `auto`：优先使用 Poppler 的 `pdftotext -layout`，不可用时使用带字符映射和标准字体资源的 PDF.js。两者都提取全部原始页面，包括参考文献和附录，以 `## Page N` 标记页码。这是文字提取，不进行模型改写或公式、表格重建。

`researchMaxMarkdownBytes` 限制完整 UTF-8 文档的大小，包括页码标题，默认 8 MiB；`researchMarkdownTimeoutMs` 限制转换时长，默认 60 秒。超限时报告失败，不截断正文；没有文字层的 PDF 需要 OCR。转换读取导入时的字节快照，完整 Markdown 通过原子写入发布。失败时保留 PDF 和笔记，记录 `paper.markdown.status: failed` 和稳定的原因代码，已有 Markdown 不再被视为确认成功的正文。PDF 面板会显示失败原因，并通过 `researchExtractMarkdown` 提供显式重试；普通刷新不会反复重试同一失败原文。成功元数据记录原文摘要、文件名、页数和提取后端。资料库迁移保留 Markdown 和状态；这些字段可选，旧的未转换资料库仍可读取。

`researchHighlight` 新增或删除一个稳定的文字选区标识。新增时验证颜色、页码和归一化矩形；相同的重复新增和不存在的删除可安全重试，并发编辑保留其他选区。高亮保存于论文的 `paper.json` 和资料库元数据，随资料库迁移，通过已有的科研快照流更新。`researchMaxHighlightBytes` 限制每篇论文完整高亮列表的序列化大小，默认为 4 MiB。保存失败时保留已确认目录，可能留下可恢复的事务日志；重复相同操作可完成恢复而不重复创建高亮。尚无高亮的资料库无需转换。目录响应通过 `capabilities.pdfHighlights` 声明支持高亮；此运行时标志不写入资料库。

`researchRenameTopic` 接收 Topic 标识、新名称及编辑框的 `expectedTitle`。它去除首尾空白并校验名称，拒绝不存在的 Topic；其他写入者已改名时返回 `research/topic-conflict`。重复已成功应用的改名不会再次增加修订号。现有资料库事务更新 `library.json` 和 `topic.json`；Topic 标识、笔记、Session、目录和论文关联保持稳定。写入失败时可能保留可恢复日志，重试前应先刷新资料库。

`researchDeletePaper` 要求论文标识及用户确认的准确绝对目录。Host 校验当前元数据，拒绝链接、路径不匹配及仍有论文或 Topic 任务运行的请求，并归档论文 Session，阻止后续提问。事务日志先将已验证目录暂存到 `.paper-deletions/`，发布移除论文后的索引，再永久删除暂存文件。操作中断时保留日志，下次读取资料库继续恢复；恢复不会删除原路径下新建的同名目录。失败后 Session 可能已归档，删除也可能已部分执行，重试前需刷新确认。原生 Session 代际文件保留。

`researchListFiles` 列出论文目录的直接子项；`researchReadFile` 在 `researchMaxNoteBytes` 限制内返回完整 UTF-8 文本或图片，并明确报告二进制文件与超限文件。路径相对论文目录，拒绝目录越界和符号链接。`researchSaveFile` 只编辑已有 Markdown，并要求 SHA-256 `expectedVersion`；版本冲突不写文件。I/O 失败保留浏览器草稿，重试前应重新读取文件确认状态。托管笔记修改也通过研究目录流发布。

`researchFollow` 推送完整基线，以及已提交或外部观察到的笔记变更快照；重连启动新基线。浏览器草稿与已确认正文分别保留。协作进程间串行写入，检查 `expectedRevision`，并通过可恢复的事务日志发布 Markdown 与元数据。过期编辑不会写入文件。I/O 失败可能留下未完成的事务日志；重试前刷新以完成恢复，恢复期间发生冲突的外部修改会明确报告而不被覆盖。元数据无效、笔记文件缺失或监听失败时，浏览器保留已确认内容并显示问题。受管理路径拒绝符号链接。

`researchConfigure` 打开另一资料库，或将当前资料复制到空目录，并在准备完成后持久化目录选择。迁移保留原目录。科研 Session 通过显式读取已有持久化提供方，在各实体目录内维护 `session.json` 快照；原有 Session 代次保持不变。部署限制可通过 `researchMaxNoteBytes`、`researchMaxPdfBytes`、`researchDownloadTimeoutMs`、`researchMaxReadPages`、`researchMaxReadCharacters`、`researchLockTimeoutMs`、`researchWatchStabilityMs` 和 `researchWatchPollMs` 配置。

`researchMentions` 为最多三篇所选论文返回规范 Session 引用。用户发送提示词之前，引用仅保留在草稿中；上下文捕获和日志记录由已有 Session-reference 服务负责。Session 持久化格式保持不变。

打开复制的资料库时，仅在原生持久化提供方没有对应 Session 的情况下恢复兼容的 `session.json` 快照，并修复缺失的 Workspace 关联。已有原生日志仍是依据。快照在 Session 事件后更新；备份附件和其他框架状态时仍需保留 Harness home。自定义 Host 组合除已有控制器依赖外，还必须提供 `agents`、`sessionController` 和 `sessionPersistence`；项目自带的 Web profile 已包含这些服务。

<a id="paper-translation"></a>
#### 论文划词翻译

`researchTranslate` 接收用户明确选择的 PDF 原文，以非空 PDF.js 文字项序号和 UTF-16 偏移定位。Host 将选区与托管原文核对，重建常见双栏阅读顺序，在同一正文、标题、图注或参考文献块内提取所在完整句子以及前后各至多两句。正文句子可跨页连接。重复的页边文字会被排除，上下文不足时明确提示。图片原文需要 OCR；复杂排版可能需要重新选择，这是基于规则的阅读顺序重建。

`cache/text-index.json` 可从原文重建，并关联原文 SHA-256。`translations.json` 保存已验证结果，缓存区分 PDF 内容、选区位置、原文上下文、论文名、模型路线、提示词和词典地址。独立模型请求使用论文 Agent 选定的模型，不启动会话轮次或提供工具。调用前将完整已准备输入写入并刷新 `research/translation-request`；验证结果后写入并刷新 `research/translation-result`，再发布结果文件。失败或取消时保留原文、笔记及已有结果。只有 `researchSaveTranslation` 才会将带页码引用的 Markdown 加入学习笔记，同一结果只追加一次，并检查当前笔记版本。冲突时保留已有内容，允许用户重试。

`researchTranslationTimeoutMs`、`researchTranslationMaxContextCharacters`、`researchTranslationMaxOutputTokens`、`researchTranslationMaxResponseBytes`、`researchTranslationMaxStoredBytes` 和 `researchTranslationMaxIndexBytes` 限制单次处理及完整保存结果，默认分别为 60 秒、16,000 个上下文字符、2,048 个输出 token、256 KiB 响应、8 MiB 历史记录和 32 MiB 文字索引。可选的[词典接口](https://dictionaryapi.dev/)提供英语音标，模型不生成音标；`researchDictionaryEndpoint` 默认使用其英语词条地址，设为空字符串可关闭查询。`researchDictionaryTimeoutMs` 默认为四秒。词条缺失或查询失败时，解释仍然可用，并明确显示暂无音标。设备朗读由阅读器负责。[Session 兼容性说明](../../../docs/upgrade-guide/v0.2.1-alpha.2/paper-translation/guide.zh.md)介绍新增审计记录。

<a id="model-experience"></a>
## 模型体验

### 科研上下文与笔记

#### 模型看到的内容

普通 Workspace 组织不贡献提示词或工具。科研实体的 Agent 获得作用域内的 `research_context`、`research_import_paper`、`research_attach_pdf`、`research_read_paper`、`research_write_note`、`research_update_progress` 和 `research_write_topic_note` 工具。必要的运行上下文包含资料库、论文目录、PDF 原文、Markdown 转换状态、笔记版本和续读位置。这些信息通过已有提示词上下文准入记录；工具调用和结果使用标准 Session 工具事件。笔记正文通过 `research_context` 显式读取，同时返回已保存高亮的文字、颜色和页面相对矩形。高亮操作本身不启动模型回合。修改学习笔记要求用户明确提出。

#### Token 影响

科研工具在科研 Agent 请求中增加 schema。必要上下文包含路径、身份标识、版本和续读位置；读取笔记或 PDF 时，通过工具结果加入所请求的正文。PDF 页数和字符数限制约束每次提取的内容量。

#### KV Cache 影响

普通 Workspace 变更不会改变请求。科研笔记版本、目录变化和续读位置在请求准入时替换已记录的运行上下文；工具 schema 仅属于科研实体的 Agent 作用域。

### 论文划词翻译

#### 模型会看到什么

辅助请求包含论文名、准确选区、所在完整句子、前后各至多两句原文、原始页码和上下文不足标记。固定的[翻译提示词](src/research-translation.ts)要求输出中文 JSON 解释，区分基本词义与语境解释，并禁止编造音标和论文结论。[记录的请求](../../../snapshots/web/research-translation/session.v4.jsonl)逐字固定这些指令。请求不携带论文之前的对话或工具。主会话消息保持原样；辅助请求和结果均作为 Session 审计事件持久化。

#### Token 影响

每个未命中缓存的选区消耗一次独立模型请求，受输入与输出预算限制。匹配的已保存结果直接复用论文文件，无需再次请求模型。音标查询不消耗模型 token。保存到学习笔记后，Markdown 可供之后显式读取笔记时使用。

#### KV Cache 影响

独立请求复用固定指令前缀，原文随选区位置变化，供应商缓存由供应商负责。辅助结果通过用户发送的提问或之后的笔记读取进入主会话上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。
- 进程内删除标记只会在 Client 模型生命周期内阻止延迟数据复活已移除的 Workspace。
- Session 快照恢复保留记录中的工作目录路径。跨机器迁移资料库时，原工作目录需要仍可访问；当前不支持自动改写 Session 路径。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
