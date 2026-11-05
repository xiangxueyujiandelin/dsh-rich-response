# dsh-rich-response

> 把 DeepSeek Harness 的回复从一大坨纯文本，变成可扫读、有语义色块的卡片。

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.1--rc.2-534AB7)](https://deepseek.com/harness/en)
[![License: MIT](https://img.shields.io/badge/License-MIT-1D9E75)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-7F77DD)](https://github.com/topics/dsh-plugin)

[中文](#中文) | [English](#english)

---

## 中文

### 这是什么

所有 AI 聊天界面都长一个样：黑字白底，层级只靠加粗和缩进撑着。这个插件给 DSH 的回复加上**语义化色块** —— 顶部一张结论卡，要点排成卡片组，对比变成表格，步骤变成编号流。

### 安装

```bash
dsh plugin --profile web add github:xiangxueyujiandelin/dsh-rich-response
```

装完**需要重启 DSH**（bundle 层在启动时组装）。

**桌面版**：也可以手动挂载 —— 不需要 CLI，不需要 pnpm。逐步骤见 [`docs/desktop-install.md`](docs/desktop-install.md)。

本地开发：

```bash
git clone https://github.com/xiangxueyujiandelin/dsh-rich-response
cd dsh-rich-response
dsh plugin --profile web add .
```

### 工作方式

插件教模型一套小型输出协议，再把返回的内容渲染成卡片：

```markdown
:::summary{title="结论"}
丢失的是**可定位坐标**，不是数据本身。
:::

:::points{cols="3"}
- **数据在** — ref 会读写，ttl>0 即会话存活
- **入口没了** — 页面方式取不回
- **uuid 不可转** — 无法塞进另一条对循环
:::
```

渲染成带底色和左边框的卡片，而不是一堆 `>` 引用符号。

两个块族：

| 族 | 语法 | 用途 |
|---|---|---|
| **语义块** | GitHub Alerts（`> [!NOTE]` / `[!TIP]` / `[!WARNING]` / `[!IMPORTANT]`） | 带色提示块。模型零学习成本 —— 这个语法在训练数据里到处都是 |
| **结构块** | `:::` 围栏 —— `summary` / `points` / `table` / `steps` / `columns` | 卡片、对比表、编号流、分栏 |

宿主半区会把这套协议作为一小节追加到系统提示词末尾（约 400 字），只提示「什么场景可用、什么场景别用」，不做任何启发式改写；客户端仍然只渲染模型真正写出来的围栏，普通回复一律走宿主原生 markdown。不想要这个提示，可以给插件条目加配置：

```yaml
- insert:
    - id: dsh-rich-response
      name: 'dsh-rich-response'
      config:
        enabled: false
```

### 设计原则：颜色 = 语义

插件**刻意不**给所有东西上色。只有模型明确标记的块才染色，正文保持干净。

- 只用语义色 —— 蓝块是补充，琥珀是警告，绿是结论
- 底色极低饱和，边框承担识别职责
- 着色面积约 11%，对比"全面染色"的 38%（后者读起来是噪音）

### 优雅降级

模型不配合是常态，不是异常。五级降级，全程不给用户看任何错误提示：

```
L0  解析成功          → 完整卡片
L1  可选字段缺失      → 用默认值补齐
L2  结构非法          → 静默退回普通 markdown
L3  围栏未闭合        → 按引用块渲染
L4  完全没有标记      → 普通 markdown（宿主默认）
```

`parseRich` 永不抛异常，3000 组 fuzz 用例强制保证这一点。

### 流式兼容

回复是逐 token 吐出来的，`:::` 围栏经常有一段时间没闭合。实测行为：

- 闭合前 → 0 个块，文本按普通 markdown 渲染
- 闭合后 → 1 个块，切换成卡片

不闪烁、不跳动。渲染层只需要一条规则：*markdown 照常渲染，遇到 level 0 的块才切卡片*。

### 开发

```bash
npm run test:all
```

八套测试共 222 项断言，**无需安装任何依赖**（Node 22+ 即可）：

| 套件 | 断言数 | 防什么 |
|---|---|---|
| `parser-test.mjs` | 31 | 协议解析与降级矩阵 |
| `semantic-test.mjs` | 22 | S 族语义块识别与字符区间（曾恒返回空） |
| `verify-build.mjs` | 13 | 构建产物与源码漂移 |
| `check-seam.mjs` | 89 | **宿主 API 契约跑偏**（见下） |
| `register-seam.mjs` | 10 | 注册期崩溃 / 会话切换生命周期 |
| `host-half-test.mjs` | 15 | 宿主半区协议注入（保守、可关闭、异常不外泄） |
| `mutation-test.mjs` | 16 变异 | **自检脚本本身假绿**（见下） |
| `render-e2e.mjs` | 42 | **回复区整片空白** + 卡片正文行内 markdown / 语义块 / 长文分栏退化 |

`check-seam.mjs` 的存在是因为第一版把三个宿主 API 猜错了，插件装上完全不会渲染；
第二版又因为用错了模块格式，DSH 直接启动失败；
第三版漏传 `MarkdownText` 的 `labels` prop，**聊天区助手回复正文整片空白**。
本项目用到的每个宿主 API 都已对照 DSH 真实产物确认，记录在 [`docs/host-seam-reference.md`](docs/host-seam-reference.md)。

其中一项断言会在 Node 的 `vm` 沙箱里按 **classic script 语义**执行产物 ——
和宿主加载插件的方式一致。这是「产物能不能被宿主执行」的回归防线。

**`mutation-test.mjs`** 是自检脚本的自我验证：它逐条破坏源码（删 `labels`、改 `locale`、
去掉 `ErrorBoundary`……），确认对应的断言真的会失败。
没有它，「断言全绿」可能只是因为断言写错了 —— 本项目已经栽过两次这种跟头。

**`render-e2e.mjs`** 用一个**按宿主真实行为写的假 `MarkdownText`** 跑产物：
遇到代码块就解引用 `labels.code.copyLabel`（与宿主源码一致），
从而能真实复现「正文整片空白」那种故障，而不是只检查字符串。

### 怎么挂进 DSH

DSH 里一切皆插件，UI 也是插件。本插件替换一个 keyed 渲染器：

```js
ctx.slots.register(
  { name: 'conversation.chat.node', key: 'assistant-step', priority: -10 },
  RichAssistantNodeView,
)
```

`priority: -10` 遮蔽内置渲染器（内置用默认 `0`）。其余部分 —— 推理折叠、工具调用分组、图片画廊、文件提及、turn-process 联动 —— 全部原样透传。

### 目录结构

```
├── src/
│   ├── client.js              渲染器（浏览器半区）
│   ├── index.js               宿主半区（注入富渲染协议，满足 bundle 契约）
│   ├── parser.js              协议解析器
│   ├── parser-reference.ts    协议解析器（TS 参考实现）
│   └── rich-response.css      样式
├── protocol/                  协议规范（中文）
├── docs/                      技术方案 + 已验证的宿主契约（中文）
├── skills/rich-response/      内容层 skill
├── scripts/build.mjs          零依赖构建
└── tests/                     八套测试
```

### 当前状态

协议与渲染器已实现并通过测试，**并已于 2026-11-05 在真实运行的 DSH 桌面版（0.2.2-rc.1）上验证**：客户端注册日志正常，五类结构块与 GitHub Alerts 均渲染为卡片，Console 无插件报错。宿主契约仍以读源码确认为准（见 `docs/host-seam-reference.md`）。

### 许可

MIT © lin（[xiangxueyujiandelin](https://github.com/xiangxueyujiandelin)）

---

## English

### What it does

Every AI chat UI looks the same: black text on white, hierarchy carried by bold and indentation alone. This plugin gives DSH replies **semantic color blocks** — a conclusion card up top, key points as a card row, comparisons as a table, procedures as a numbered flow.

### Install

```bash
dsh plugin --profile web add github:xiangxueyujiandelin/dsh-rich-response
```

Then **restart DSH** (bundle layers are assembled at startup).

**Desktop app:** the plugin can also be mounted manually — no CLI, no pnpm needed.
See [`docs/desktop-install.md`](docs/desktop-install.md) (Chinese) for the step-by-step.

For local development:

```bash
git clone https://github.com/xiangxueyujiandelin/dsh-rich-response
cd dsh-rich-response
dsh plugin --profile web add .
```

### How it works

The plugin teaches the model a small output protocol, then renders what comes back:

```markdown
:::summary{title="Conclusion"}
What was lost is the **locatable coordinate**, not the data itself.
:::

:::points{cols="3"}
- **Data is there** — the ref reads and writes; `ttl>0` means the session is alive
- **Entry point is gone** — it cannot be retrieved the page way anymore
- **uuid is not portable** — it cannot be embedded in another loop's id
:::
```

renders as a tinted conclusion card plus a three-card row, instead of a pile of `>` quote markers.

Two block families:

| Family | Syntax | Purpose |
|---|---|---|
| **Semantic** | GitHub Alerts (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!IMPORTANT]`) | Tinted callouts. Zero learning cost for the model — this syntax is everywhere in training data. |
| **Structural** | `:::` fences — `summary`, `points`, `table`, `steps`, `columns` | Cards, comparison tables, numbered flows, two-column layouts. |

The host half appends this protocol as a ~400-character section at the end of the system prompt: it only says *when* to use the blocks and when not to, and never rewrites anything. The client half still renders only fences the model actually writes; ordinary replies keep the host's native markdown. To opt out, add config to the plugin entry:

```yaml
- insert:
    - id: dsh-rich-response
      name: 'dsh-rich-response'
      config:
        enabled: false
```

### Design principle: color means meaning

The plugin deliberately does **not** tint everything. Only blocks the model explicitly marks get color; body text stays clean.

- Semantic colors only — a blue block means "supplementary", amber means "warning", green means "conclusion"
- Low-saturation backgrounds, saturated left borders
- ~11% colored area, versus ~38% for a "tint everything" approach that reads as noise

### Graceful degradation

The model not cooperating is the normal case, not an error. Five fallback levels, none of which ever shows the user an error:

```
L0  parsed cleanly          → full card
L1  optional field missing   → filled with default
L2  structure invalid        → rendered as plain markdown, silently
L3  fence not closed yet     → rendered as a quote block
L4  no markers at all        → plain markdown (host default)
```

`parseRich` never throws. A 3000-case fuzz test enforces this.

### Works with streaming

Assistant replies arrive token by token, so a `:::` fence is usually half-open for a while. Measured behaviour:

- before the closing fence → 0 blocks, the text renders as ordinary markdown
- after it closes → 1 block, switches to a card

No flicker, no layout jump. The renderer only needs one rule: *render markdown as usual, switch to a card when a level-0 block appears*.

### Development

```bash
npm run test:all
```

Eight suites, 222 assertions, **no dependencies to install** (Node 22+ is enough):

| Suite | Assertions | Guards against |
|---|---|---|
| `parser-test.mjs` | 31 | protocol parsing and the degradation matrix |
| `semantic-test.mjs` | 22 | semantic-block (GitHub Alerts) detection and character ranges |
| `verify-build.mjs` | 13 | build output drifting from source |
| `check-seam.mjs` | 89 | **host API contract drift** — see below |
| `register-seam.mjs` | 10 | registration-time crashes / session-switch lifecycle |
| `host-half-test.mjs` | 15 | host-half protocol injection (conservative, switchable, never throws) |
| `mutation-test.mjs` | 16 mutations | **the self-check silently passing** — see below |
| `render-e2e.mjs` | 42 | **a blank assistant reply area** + inline markdown and alerts in cards + long columns degrading to single column |

`check-seam.mjs` exists because the first implementation guessed three host APIs wrong and the plugin would not have rendered at all; the second one used the wrong module format and DSH failed to boot; the third one omitted `MarkdownText`'s `labels` prop and **the assistant reply area went completely blank**. Every host API used here was confirmed against the real DSH artifacts; `docs/host-seam-reference.md` (Chinese) records the findings.

One assertion executes the built artifact in a Node `vm` sandbox under **classic script semantics** — exactly how the host loads a plugin. That is the regression guard for "can the host even execute this artifact".

**`mutation-test.mjs`** verifies the self-check itself: it breaks the source one way at a time (drops `labels`, changes `locale`, removes the `ErrorBoundary`…) and confirms the matching assertion actually fails. Without it, "all assertions green" may only mean the assertion was wrong — this project has hit that twice.

**`render-e2e.mjs`** runs the artifact against a **fake `MarkdownText` that mimics the real host**: it dereferences `labels.code.copyLabel` on code blocks, exactly as the host does. That reproduces the "reply area goes blank" failure for real, instead of only matching strings.

### How it hooks into DSH

DSH treats everything as a plugin, including the UI. The plugin replaces one keyed renderer:

```js
ctx.slots.register(
  { name: 'conversation.chat.node', key: 'assistant-step', priority: -10 },
  RichAssistantNodeView,
)
```

`priority: -10` shadows the built-in renderer (which uses the default `0`). Everything else — reasoning collapse, tool-call grouping, image galleries, file mentions, turn-process linkage — is passed through untouched.

### Project layout

```
├── src/
│   ├── client.js              renderer (browser half)
│   ├── index.js               host half (empty, satisfies the bundle contract)
│   ├── parser.js              protocol parser
│   ├── parser-reference.ts    protocol parser (TS reference implementation)
│   └── rich-response.css      styles
├── protocol/                  protocol spec (Chinese)
├── docs/                      research + verified host contract (Chinese)
├── skills/rich-response/      the content-layer skill
├── scripts/build.mjs          zero-dependency build
└── tests/                     eight suites
```

### Status

Protocol and renderer are implemented and tested, and were **verified on a running DSH desktop instance (0.2.2-rc.1) on 2026-11-05**: the client registered its renderer, all five block types plus GitHub Alerts rendered as cards, and the console showed no plugin errors. The host contract is still confirmed by reading source — see `docs/host-seam-reference.md`.

### License

MIT © lin ([xiangxueyujiandelin](https://github.com/xiangxueyujiandelin))
