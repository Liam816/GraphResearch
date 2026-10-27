---
description: "dsh Web 客户端的侧边栏外壳插件：品牌行、New Session 操作、折叠控件、可感知滚动的区域席位与底部固定的 Settings 席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

侧边栏显示研究目录标题，通过展开态品牌返回全局 Agent，将导航折叠为 56px 轨道，并将 Settings 固定在底部。Topic 与论文导航由 `sidebar.workspaces` 的占位者负责。部署可以替换品牌标记与名称，同时保留周围的导航控件。空闲滚动条保持隐藏，不移动浏览器列表行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

侧边栏是导航外壳：用户看到品牌、启动新会话、折叠轨道并到达 Settings。功能插件填充它的席位——ui-workspace 填充 `sidebar.workspaces`，ui-settings 在 `sidebar.settings` 注册触发行与设置面板。

### 品牌与 New Session

GraphResearch 隐藏独立的「新会话」按钮，以及「插件」「自动化任务」导航行。折叠栏和 macOS 页头同样隐藏这些入口，侧栏展示科研目录、折叠按钮和设置。

展开态品牌将 `sidebar.brand.mark` 与 `sidebar.brand.name` 渲染为两个独立的 single slot；收起后隐藏品牌及其全局 Agent 返回操作。点击品牌通过科研导航所有者打开全局 Agent，不新建会话。独立的面板图标负责展开或收起侧栏。没有占位者时，外壳使用鱼形标记和本地化的**研究目录**标题，不显示构建版本或提交哈希徽标。紧凑的标题行下方紧接研究目录控件。[科研工作区](../ui-workspace/README.zh.md)负责会话恢复与新建。

### 全局面板入口

插件在 root 作用域的 `sidebar.panellist` list 中注册图标组件，提供 `id`、可选 `order`，以及字符串或 locale-aware 的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件；选择不存在的主面板条目会抛错，并保留当前选中态。标签提供普通可见文字、无障碍名称和折叠提示。每一行通过 `usePanelInfo` 读取自己的选中态；DOM 焦点移到搜索框或目录选择器时，显示的面板及其列表项选中态不变。没有注册项时，列表及其间距均不渲染。产品随附的组合不注册示例面板。

### 折叠行为

侧栏及会话头部的开关从命令目录读取当前有效快捷键，用于悬停、键盘聚焦提示和 `aria-keyshortcuts`。未绑定的命令只显示操作名称。

侧栏收起时，顶部展开按钮承载可选、不可交互的 `sidebar.toggle.badge` slot。占用方提供状态和提示内容，不增加操作，也不改变按钮的导航行为。

实时收起时，展开内容在当前宽度淡出，上方控件共用同一段透明度渐变，并向左平移进入 56px 轨道，由布局的栏滑动结束整段动画。页面初始即为收起状态时会静态渲染轨道；减少动态效果模式会禁用两段过渡。固定在底部的 `sidebar.settings` 控件共用相同的透明度渐变时序，但不发生横向位移。

在 Windows Electron 中，`html[data-windows-titlebar]` 将侧栏开关固定在顶栏左上角。收起后隐藏全局 Agent Logo 与侧栏内容，保留侧栏开关。顶栏控件从窗口拖拽区域中排除，提示在顶栏下方打开。侧栏预留 `--dsh-windows-menu-start: 84px`，保留顶栏菜单的间距。

### macOS 桌面

在 `html[data-platform='darwin']` 下，展开列的 52px 顶部条避开红绿灯并承载收起按钮。顶部条与 Logo 行的空余区域仍可拖动窗口；品牌按钮仅将自身可点击区域排除，并返回全局 Agent。收起时整列隐藏，`HeaderLeadingControls` 通过框架的 `shell.leading` 席位在红绿灯旁仅提供侧栏展开按钮，全局 Agent Logo 保持隐藏。[Desktop 参考](../../../apps/desktop/README.zh.md)负责窗口集成。

### 滚动条

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把滚动条间接层重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（ui-workspace），所以显示滑块不会引起重排。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

外壳是纯组合：`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 与 `useWorkspaces` 钩子、已声明的品牌、`sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的导航回调。面板入口及其可选标题使用相同的组合方式。面板元数据由列表注册和 locale 变化派生；选中态属于布局存储。

### slot 纪律

声明感知的 `slots.inject()` 让替换包无论先于还是后于侧边栏激活都能生效。页脚承载 `sidebar.settings` 席位：侧边栏只渲染固定在底部的布局 slot，并共享其栏状态（`wide`）。`/client` 导出接口只包含插件主体（`apply`/`inject`）及约定类型；SidebarRoot、行组件与树派生仍由 slot 注册封装在包内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖填充外壳席位的各个界面与组合模型。

- [ui-workspace](../ui-workspace/README.zh.md)——渲染到 `sidebar.workspaces` 的 Workspace 与 Session 浏览器。
- [ui-settings](../ui-settings/README.zh.md)——在 `sidebar.settings` 注册触发行与设置面板的设置领域底座。
- [ui-layout](../ui-layout/README.zh.md)——折叠所使用轨道与栏状态的布局 owner。
- [ui-theme](../ui-theme/README.zh.md)——外壳所重新绑定的滚动条 token 间接层。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——席位背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义外壳拥有什么、其占位方拥有什么；它们是当前包约束。

- **Session 状态点渲染由 ui-workspace 持有**：本外壳没有可用的 done/error 通知数据源。
- **Workspace 浏览行为由组合持有**：分组、排序、搜索与行状态都属于 ui-workspace，不属于此外壳。
- **「New task completed」未读标记是本地查看状态**：完成时间 > 上次查看时间这一事实永远不会到达宿主。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
