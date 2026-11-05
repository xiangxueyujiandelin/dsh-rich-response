# AI 回复富渲染技术方案

> 日期：2026-11-05　　作者：lin + WorkBuddy
> 状态：技术调研完成，**未动一行代码**，待选型后开工
> 目标：让 AI 回复不再是一坨纯文本 —— 换配色、加色块背景、彩色标注、分栏卡片

---

## 0. 结论速览

**技术上完全走得通。** 但「改 AI 软件的回复界面」不是一个技术问题，是**三个独立的层**，每层的可行性、可改范围、可移植性完全不同。

| | 结论 |
|---|---|
| DeepSeek Harness 能接插件吗 | ✅ 能，而且社区已有 4000+ 插件，官方文档写明「一切皆插件」 |
| 能改到「回复正文渲染」吗 | ✅ 能。已有插件完整替换了 assistant 的 markdown 渲染器 |
| 能给闭源 App（豆包/Kimi）改吗 | ❌ 不能。三层全封闭，只能自己做客户端或用网页版注入 |
| 最优路线 | 安卓端自研客户端（转行作品集）+ DSH 插件（开源履历 / 协议验证） |

---

## 1. 问题拆解：三层模型

「回复界面太枯燥」拆开看是三件事，技术手段完全不同：

```
┌─────────────────────────────────────────────┐
│  内容层 · 模型输出结构                         │
│  回复想要有卡片/色块，先得让模型按约定格式吐字  │  ← skill / prompt 模板
├─────────────────────────────────────────────┤
│  渲染层 · markdown → DOM                     │
│  把一条回复拆成卡片、色块、折叠段、左右分栏     │  ← slot 组件（可完全替换）
├─────────────────────────────────────────────┤
│  外壳层 · 主题与样式                          │
│  配色、圆角、玻璃拟态、代码块配色、字体         │  ← token 覆盖 + CSS
└─────────────────────────────────────────────┘
```

**关键认知：换主题 ≠ 回复变丰富。**

外壳层一天就能出活，社区现成插件一抓一大把，但那只是「换个皮肤」，正文还是那个纯文本。
用户说的「回复内容太枯燥」真正要动的是**渲染层** —— 这层在 DSH 里也是可插拔的，但在闭源 App 里是死的。

| 载体 | 内容层 | 渲染层 | 外壳层 |
|---|---|---|---|
| DeepSeek Harness | ✅ skill 注入 | ✅ slot 替换 | ✅ token/CSS |
| 闭源原生 App（豆包/Kimi/ChatGPT） | ❌ | ❌ | ❌ |
| 各家网页版 | ✅ | ✅ 注入 | ✅ 注入 |
| 自研客户端 | ✅ 全自主 | ✅ 全自主 | ✅ 全自主 |

---

## 2. 技术验证 A：DeepSeek Harness 插件路线

### 2.1 架构确认

DSH 是 Web UI + Cordis 微内核。模型、工具、会话、沙箱、**UI 全部是可插拔的 Cordis 插件**。
浏览器半边（client）与宿主半边（host）通过类型安全的 RPC 层桥接。

### 2.2 插件包结构（真实源码，非推测）

一个 UI 插件就三个核心文件：

```
package.json          # 声明这是客户端插件
cordis.patch.yml      # 声明挂载到宿主哪个 slot
client.js             # 浏览器半边：全部视觉逻辑
index.js              # 宿主半边：空的 apply()，只为满足 bundle 契约
```

`package.json` 关键字段（取自 `dsh-matrix-theme` v0.9.0 真实源码）：

```json
{
  "name": "dsh-matrix-theme",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "skin.json", "README.md", "LICENSE"],
  "dsh": {
    "engines": { "dsh": ">=0.2.1-rc.2" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-theme"]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-client-ui-theme": ">=0.2.1-rc.2"
  }
}
```

字段含义：

| 字段 | 作用 |
|---|---|
| `dsh.client.platform: "web"` | 标记这是浏览器半边插件 |
| `dsh.client.inject` | 依赖的宿主 UI 原语包，决定能拿到哪些 `ctx` 能力 |
| `dsh.bundle.patch` | 指向 `cordis.patch.yml`，声明挂载位置 |
| `exports["./client"]` | 浏览器半边入口，被 `window.ModuleLoader` 懒加载 |

`cordis.patch.yml` 极简，只要一行：

```yaml
insert:
  - id: ui-skin-matrix
    name: 'dsh-matrix-theme'
```

### 2.3 可用的 ctx API（已验证）

| 想要的效果 | API | 状态 |
|---|---|---|
| 覆盖全局主题 token | `ctx.theme.overrideTokens('my-skin', {...})` | ✅ 已验证 |
| 注册可切换主题 | `ctx.theme.register({id, colorScheme, tokens})` + `ctx.theme.setTheme(id)` | ✅ 已验证 |
| 特效 / 毛玻璃 | `ctx.effect` | ✅ 已验证 |
| **替换某个消息的渲染器** | `ctx.slots.register({name:'conversation.chat.node', key:'assistant', priority:-10}, Component)` | ✅ 已验证（有先例） |
| 往会话流插入自定义节点 | `ctx.uiConversation.events.register(definition)` | ✅ 官方文档有完整示例 |
| 挂载浮动面板 | `ctx.slots.inject('shell.overlay', ...)` | ✅ 已验证 |
| 注入系统提示词段落 | `ctx.systemPrompt.section()` | ✅ 官方文档列出 |

**主题 token 必须成对给 `{light, dark}`，只给一个值直接抛校验错误** —— 写的时候第一个坑。

完整 token 表（约 40 个）：`--dsw-alias-brand-primary/hover/active`、`--dsw-alias-bg-base/elevated/surface`、`--dsw-alias-text-primary/secondary/tertiary`、`--dsw-alias-border-default/strong`、`--dsw-alias-shadow-default`、`--dsw-alias-radius-base` 等。

### 2.4 宿主暴露的稳定 DOM 钩子

宿主在 `data-slot` / `data-row-key` 上暴露了稳定属性，社区插件普遍依赖这些做精细样式：

```
[data-slot="conversation.header"]   [data-composer-card]
[data-windows-titlebar]            [data-chat-flow-kind]
[data-row-key]                     [data-dockkit-*]
```

选择器匹配不上时是**无害空操作**，不会让宿主编译或运行失败 —— 这点 DSH 做得很规范。

### 2.5 渲染层已被社区验证（关键证据）

| 插件 | 做什么 | 怎么做的 |
|---|---|---|
| `dsh-markstream` | **完整替换** assistant-step 渲染器，改为 markstream-react 增量流式渲染 | 在 `conversation.chat.node` keyed slot 以 `priority: -10` 注册，遮蔽内置（内置 priority 0） |
| `dsh-markdown-bubble` | 把 **user / steering** 消息接入 markdown 管线 | 同上，遮蔽内置 user 座位 |
| `dsh-temp-chat` | 在会话流插自定义节点 + 浮动面板 | `ctx.uiConversation.events.register()` + `conversation.chat.node` keyed seat |

**这意味着：「让 DSH 的回复变成彩色卡片」不是探索性工作，是有成熟先例的复制+改造工作。**

### 2.6 安装与调试

```bash
# 装社区插件
dsh plugin --profile web add github:账号/插件名
dsh plugin --profile web add dshmarket      # 插件市场入口

# 本地开发（link 安装，改完刷新即见）
dsh plugin --profile web add .

# 验证是否挂上
dsh --profile web --dump-config | grep 插件名
```

调试要点：

- 改 `client.js` 内容 → 浏览器硬刷新（Ctrl+Shift+R）即生效
- 改 `package.json` 或 `cordis.patch.yml` → **必须重启 DSH 进程**（bundle 层只在启动时组装）
- DevTools Network 里能看到 `/plugins/<插件名>/client.js` 这个请求
- 配置持久化可写 `$DSH_HOME/settings.yaml`

### 2.7 DSH 的独有空档：过程可视化

DSH 所有东西都是 append-only session log —— 系统提示、推理过程、工具调用、上下文注入全部可追溯、可 resume/fork/replay。

**社区 4000+ 插件里，"把思考过程 / 工具调用 / 上下文膨胀渲染成彩色时间线"这个方向做得完整的很少。** 这是别家 AI 软件给不了的东西，也是一个天然的差异化切入点。

### 2.8 DSH 路线的风险

| 风险 | 说明 |
|---|---|
| **预览期 API 破坏性变更** | 官方文档自己写了 "compatibility-breaking changes are expected"。DOM 钩子可能变 |
| 生态不成熟 | 插件多为个人作品，无稳定性保证 |
| 技术栈不匹配 | 纯 React/TS/Web，与现有安卓技能零复用 |
| 视野局限 | 只服务 DSH 一个宿主 |

---

## 3. 技术验证 B：安卓端自研客户端路线

### 3.1 核心优势：技能直接复用

这是安卓开发者的**主场优势**，不是从零学新东西：

- 聊天列表 / 消息气泡 / 流式增量渲染 → 你的日常
- Compose 自定义渲染 → 你的日常
- SSE 流式响应、取消、打断 → 你的日常
- Room 持久化会话、状态管理 → 你的日常
- 系统层（如果要做端侧推理）→ 你的**短板**，但这个项目不需要

转行记忆里确认的主攻路径是「A（端侧 AI / AI 原生 App，安卓手艺可复用）」，**这个项目正好是路径 A 的完整作品集样本**。

### 3.2 现成的渲染库（不用自己写 markdown 解析器）

| 库 | 架构 | 关键能力 |
|---|---|---|
| `mikepenz/multiplatform-markdown-renderer` | **纯 Compose** | GFM 表格、任务列表、**GitHub Alerts 原生支持**、每个 AST 节点可覆盖为自定义 `@Composable`、流式状态 `rememberStreamingMarkdownState()`、扩展 span（`RoundedCornerSpanPainter` → **直接做色块背景**）、KaTeX |
| `feiyin0719/ComposeMarkdown` | 纯 Compose | Flexmark 解析、异步解析、**Plugins API**（可自定义 Alerts） |
| `jeziellago/compose-markdown` | Compose 内嵌 TextView（Markwon） | CommonMark + HTML + 表格 + 任务列表 + `==highlight==`，兼容老项目 |

**首选 `multiplatform-markdown-renderer`**：纯 Compose（不是 View 套壳）、支持 GitHub Alerts、每个节点可替换、流式渲染开箱即用、Apache 2.0 许可。

### 3.3 关键杠杆：GitHub Alerts 已经是标准语法

GitHub 早就在用这套语法，`multiplatform-markdown-renderer` **原生支持**，等于白送：

```markdown
> [!NOTE]
> 这是一条补充说明，会渲染成蓝色块。

> [!TIP]
> 建议用法，绿色块。

> [!WARNING]
> 注意事项，黄色块。

> [!IMPORTANT]
> 关键信息，红色块。
```

**这直接解决了「模型输出结构」的难题** —— 不需要自定义 fence 语法、不需要改渲染器做正则匹配，用的是全网通用的既有标准。模型也更容易学会（训练数据里到处都是）。

进阶：`:::tip` 自定义 fence + 自己的 block renderer，可以做任意色卡。

### 3.4 安卓路线的工作量估算

| 模块 | 工作量 | 备注 |
|---|---|---|
| Markdown 渲染 + Alerts 着色 | **小** | 库直接支持，1-2 天 |
| 流式增量渲染 | **小** | `rememberStreamingMarkdownState()` |
| 会话列表 / 气泡布局 | **小** | 你的主场，1-2 天 |
| SSE 接入 + 取消/打断 | 中 | 需要自己接 API 层 |
| 会话持久化 | 中 | Room，你熟 |
| 多模型接入 / 配置页 | 中 | 大量重复劳动 |
| 主题系统（亮/暗 + 配色预设） | 中 | 用你的 `--dsw-alias-*` 同类思路做 token 层 |
| **合计** | **约 3-4 周** | 按你现在的投入节奏 |

---

## 4. 核心资产：渲染协议设计

不管走哪条路，这套协议是共用的。**先定协议，两条线并行验证。**

### 4.1 语义块（复用 GitHub Alerts 语法）

模型输出约定：

```markdown
正文段落……

> [!NOTE]
> 补充说明

> [!TIP]
> 实用建议

> [!WARNING]
> 风险提醒

> [!IMPORTANT]
> 关键结论
```

映射到视觉：

| 类型 | 背景 | 左边框 | 图标 |
|---|---|---|---|
| NOTE | 蓝灰浅底 | 蓝 | ⓘ |
| TIP | 绿浅底 | 绿 | ✓ |
| WARNING | 黄浅底 | 黄 | ⚠ |
| IMPORTANT | 红浅底 | 红 | ❗ |

### 4.2 扩展块（自定义 fence，能力更强）

```markdown
:::card{title="方案对比" tone="info"}
| 方案 | 成本 | 周期 |
|---|---|---|
| A | 低 | 1 周 |
| B | 高 | 4 周 |
:::

:::columns
左栏内容……

---
右栏内容……
:::
```

- `:::card{tone}` → 带标题栏的色块卡片，tone 可取 info/success/warn/danger/neutral
- `:::columns` → 左右分栏（手机上自动降级为堆叠）
- `:::timeline` → 时间线，**配合 DSH 的 session log 做过程可视化**

### 4.3 配色 token 层（照抄 DSH 的思路）

设计一套自己的语义 token，两端通用：

```
--rr-bg-base        页面底色
--rr-bg-elevated   浮层/卡片底
--rr-bg-surface    内容区底
--rr-text-primary/secondary/tertiary
--rr-brand-primary/hover/active
--rr-border-default/strong
--rr-alert-note-bg / -tip-bg / -warn-bg / -danger-bg
--rr-radius-base / --rr-shadow-default
```

**所有颜色必须成对提供亮暗两套**，这是 DSH 踩过的坑，直接抄。

---

## 5. 三条路线对比与推荐

### 5.1 对比

| 维度 | A. DSH 渲染插件 | B. 安卓端客户端 | C. 浏览器扩展注入 |
|---|---|---|---|
| 工作量 | 1-2 周 | 3-4 周 | 3-5 天 |
| 技术栈 | React/TS/Web | Kotlin/Compose（你的主场） | JS + DOM 选择器 |
| 技能复用 | 几乎为零 | **90%+** | 少 |
| 简历价值 | 中（开源作品） | **高（完整产品，能演示）** | 低（不好写进简历） |
| 影响范围 | 只 DSH | 自己的 App，**完全自主** | 所有网页版 AI |
| 生态风险 | 高（预览期 API 破坏性变更） | 无（自己掌控） | 高（DOM 结构一变就崩） |
| 能否持续演进 | 受制于上游 | **完全自主** | 受制于人 |
| 对转行的作用 | 证明能做 AI 前端 | **完整覆盖「端侧 AI App」路径** | 练手 |

### 5.2 推荐：B 为主，A 为辅

**主线（60% 精力）：安卓端 AI 客户端**
- 理由：转行目标是 AI 开发工程师，记忆里确认主攻路径 A（端侧 AI / AI 原生 App）
- 简历上能拿出一个「能跑、能演示、有设计、有完整交互」的 App，比「我美化了某开源项目的主题」重得多
- 正好补上你缺的「从 0 到 1 做完整产品」经历
- 技术栈 100% 是你已经会的语言，只有 markdown 渲染库和 AI 接口是新的

**副线（40% 精力）：DSH 渲染插件**
- 理由一：协议验证。DSH 上试 `:::card` 渲染，比在安卓上迭代快得多（硬刷新就见）
- 理由二：开源履历。GitHub topic `dsh-plugin` 有 700+ 仓库，社区活跃，star 是真金白银
- 理由三：技术栈互补。学 React/TS，补上 Web 前端这块短板，AI 岗面试问到全栈能接上话
- 理由四：**风险对冲**。DSH 在预览期，说不准哪天你要的 API 就没了；安卓端不受影响

**C 路线（浏览器扩展）不推荐做主线** —— DOM 选择器一改就崩，天花板低，简历不好写。适合当周末练手。

### 5.3 为什么不做「先 DSH 再安卓」的纯串行

协议设计（第 4 节）可以在 DSH 上快速迭代（改 client.js 刷新就见，一天能试 5 个版本）。
定完协议再在安卓端实现（用 Compose 实现同一套语义）。
串行会浪费 3-4 周；并行（协议在 DSH 上磨，安卓端同步搭骨架）能省两周。

---

## 6. 分阶段实施路线

### 阶段 0 · 协议定稿（3-5 天）
- [ ] 定语义块语法（直接采用 GitHub Alerts，不自创）
- [ ] 定扩展块语法（`:::card` / `:::columns` / `:::timeline`）
- [ ] 定 token 表（亮暗成对）
- [ ] 产出：`协议规范.md`（一份文档，两端共用）

### 阶段 1 · DSH 侧验证（1-2 周）
- [ ] `npx @deepseek-ai/dsh web` 跑起来，摸清 slot 机制
- [ ] 抄 `dsh-markstream` 的骨架，做出第一个「替换 assistant 渲染器」插件
- [ ] 实现 Alerts → 色块映射
- [ ] 写 skill 让模型稳定输出 Alerts 语法
- [ ] 产出：一个能装的 DSH 插件 + GitHub 仓库

### 阶段 2 · 安卓端主体（3-4 周）
- [ ] 项目骨架（Compose + MVVM + Room）
- [ ] 接入 `multiplatform-markdown-renderer`，跑通 Alerts 原生渲染
- [ ] 实现自定义 `:::card` block renderer（Compose 侧）
- [ ] SSE 流式接入 + 取消/打断
- [ ] 会话列表 + 持久化
- [ ] 主题系统（token 层 + 亮暗切换）
- [ ] 产出：一个可安装的 APK + 演示录屏

### 阶段 3 · 差异化（1-2 周）
- [ ] DSH 过程可视化（思考过程 / 工具调用 / 上下文膨胀 → 彩色时间线）
- [ ] 安卓端同步该能力
- [ ] 产出：简历素材 + 演示视频 + 技术博客

### 阶段 4 · 求职包装（持续）
- [ ] 简历加项目条目（强调：自主设计 + 完整实现 + 可演示）
- [ ] 写一篇技术博客《我把 AI 回复做成了卡片流》—— 面试时可直接甩链接
- [ ] 投递追踪表更新

---

## 7. 风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| DSH API 预览期变更 | 高 | 只依赖已验证的 `ctx.slots` / `ctx.theme`；把协议和宿主解耦，换宿主只换适配层 |
| 安卓端工作量低估 | 中 | 阶段 2 拆到 2 周粒度，每周一验收 |
| 只有 UI 没内容，模型不按 Alerts 输出 | 中 | 阶段 0 就配 skill；渲染层做「无 Alerts 时自动降级」的智能识别（引用块 / 加粗段落启发式） |
| markdown 解析库踩坑 | 中 | 优先 `multiplatform-markdown-renderer`（纯 Compose、AST 可覆盖） |
| 装环境踩到硬规则 | — | **任何安装前先问**：Node、pnpm、Gradle 依赖、Android SDK 组件，一律先说明再动手 |
| 变成练手项目没落地 | 中 | 阶段 2 结束前必须有一个能装到手机上的 APK |

---

## 8. 待你决策

- [ ] **路线确认**：B 为主 A 为辅？
- [ ] **协议定稿**：语义块直接用 GitHub Alerts 标准，还是自己设计一套中文语义？
- [ ] **动手顺序**：先 DSH 验证协议，还是先搭安卓骨架？
- [ ] **DSH 安装**：`npx @deepseek-ai/dsh web` 需要装 Node + pnpm，**等你点头再装**

---

## 9. 参考资料

**DeepSeek Harness**
- 官网 https://deepseek.com/harness/en
- 源码 https://github.com/deepseek-ai/deepseek-harness
- 扩展手册 `docs/cookbook/extension-cookbook.md`
- 会话子系统 `docs/subsystems/conversation.md`
- 插件市场 https://dsh-market / dshpluginhub.ai / skillhub.cn
- 参考插件：`dsh-matrix-theme`、`dsh-markstream`、`dsh-markdown-bubble`、`dsh-cerrda-theme`、`dsh-qq2006`、`dsh-skin-im2005`、`dsh-custom-ui-theme`

**安卓渲染**
- `mikepenz/multiplatform-markdown-renderer`（首选，纯 Compose，支持 GitHub Alerts）
- `feiyin0719/ComposeMarkdown`（Flexmark + Plugins API）
- `jeziellago/compose-markdown`（Markwon 套壳，适合老项目）
- Cherry Studio 自定义 CSS 机制 —— 桌面端富渲染的参考实现
