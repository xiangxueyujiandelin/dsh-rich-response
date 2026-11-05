# DSH 宿主接缝 · 源码实证对照

> 2026-11-05 从 deepseek-ai/deepseek-harness 主分支源码逐文件确认
> 所有结论均来自真实源码，非推测
>
> **2026-11-05 补充**：本文件原先基于 GitHub 源码，
> 后又从**桌面版 app.asar 里提取真实产物**二次核对，
> 发现并修正了两处错误（locale 命名空间、MarkdownText 的 prop 清单）。
> 详见第十节。

---

## 零、插件 bundle 的加载格式（崩溃根因，最重要）

### 症状

装好插件后 DSH 启动崩溃，日志：

```
Error: web boot: 1 entry did not activate
dsh-rich-response: import failed (see console for the import error)

renderer console:
Uncaught SyntaxError: Cannot use import statement outside a module
```

### 根因

**宿主用 `<script>` 标签加载插件 bundle —— 是 classic script，不是 ES module。**

证据（`packages/client/modules/README.md` 与 `dsh-client-modules/lib/client.js` 源码）：

> "application combo 脚本只携带每个插件的 `client.js` 入口，并在启动时仅注册一次这些 factory"
> "A batch script is one classic script that registers every package in sequence"

所以顶层 `import` 语句直接是语法错误。

### 连带伤害（比本身更严重）

宿主会把多个插件的 client.js **拼成一个 combo 脚本**一起执行
（路由键 `/plugins/??...&rev=...`，3KiB 分批）。

**一个插件的语法错误，会让同一批次的所有插件一起挂掉。**
崩溃日志里两条报错就是证据：一条是 combo 批次 URL，一条是我们自己的单资源 URL。

### 正确格式

```js
window.__ModuleLoader__.load({
  id: 'dsh-rich-response',            // 必须等于 package.json 的 name
  factory: (require) => {
    const { createElement, Fragment } = require('react')
    const primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives')
    // ...
    return { name, inject: ['slots'], apply }
  },
})
```

对照已装插件 dshmarket / dsh-prompt-sortable / dsh-context
与社区插件 dsh-markstream，产物形态完全一致。

### factory 里的 require 能解析什么

宿主的模块表解析顺序（`dsh-client-modules/lib/client.js` → `makeRequire`）：

```
seed 表 → 已物化记录 → 启动图 row → 已注册 factory
```

seed 表 = `PLATFORM_MODULES`（在 web bundle 的 `YZ()` 函数里）：

```
react / react/jsx-runtime / react-dom / react-dom/client
@deepseek-ai/cordis / zod / @tanstack/react-virtual
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

**⚠️ 相对路径不支持** —— `'./parser.js'` 三处都不命中，会抛
`client-modules: require("./parser.js") missed the module table`。

→ 所以协议解析器必须**内联**进 factory 闭包。
→ `src/parser.js` 保留为独立可测副本，构建脚本内联 + 校验两份行为一致。

### client half 的导出形状

```js
return { name: '...', inject: ['slots'], apply }
```

- `inject` = 宿主**服务名**列表（`slots` / `locale` / `theme` …），不是包名
- `apply(ctx)` 里通过 `ctx.slots.inject(...)` 注册 slot

注意与 `package.json` 里的 `dsh.client.inject` **不是一回事**：
后者是**包级依赖边**（谁必须先加载），前者是运行时服务声明。

---

## 一、数据流全链路

```
SessionEvent (assistant/live-chunk, assistant/message)
  ↓
assistantDefinition (conversation-nodes/assistant.ts)
  ↓ 累积成 AssistantState { blocks, visibleByIndex, status, ... }
projectAssistant() → AssistantChatData
  ↓
buildViewNode() → chatNode(context, 'assistant-step', anchorSeq, data)
  ↓
ChatSnapshotBuilder 存入 snapshot.nodes
  ↓
ChatNodeSeat.tsx → renderSlot('conversation.chat.node', routedOwner, {...})
  ↓
slot 渲染器（我要替换的就是这一环）
  ↓
AssistantNodeView → AssistantMarkdown → 遍历 blocks → MarkdownText
```

---

## 二、Slot 注册契约（conversation.chat.node）

**来源**：`packages/client/ui-chat/src/client/chat/register-node-renderers.ts`

### 关键发现：内置渲染器**没有** priority 字段

```ts
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node',
  key: 'assistant-step',
  locale: NS,
  children: {
    'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
    'conversation.chat.message.images': { kind: 'single', scope: 'session' },
  },
  inject: (sessionId): AssistantNodeInjected => ({ ... }),
}, AssistantNodeView))
```

内置全部用默认优先级（0）。**`dsh-markstream` 用 `priority: -10` 遮蔽** —— 数字越小越优先。

### ⚠️ 覆盖内建渲染器的三项契约（2026-11-05 实测修正）

| 字段 | 值 | 写错会怎样 |
|---|---|---|
| `children` | **不声明** | 子 slot 声明权**独占**：内建 assistant-step 已声明 `reasoning.body` / `message.images`，重复声明在**注册期**抛 `slot "X" is already declared` → entry 注册失败 → 宿主 SlotErrorBoundary 把每个 assistant-step 渲染成空 div → **正文整片空白**。不声明的代价是拿不到 `renderSlot`，推理/图片块要自己画（见 `ReasoningDisclosure` / `RichImageBlock`） |
| `locale` | `'chat'` | 内建 `const NS = "chat"`。写成 `'conversation'` 不崩，但 `t()` 返回裸 key |
| `priority` | `-10` | 内建是 0，数字越小越优先；不写负值则排在内建之后，渲染器不生效 |

> 历史教训：本节早期版本写过「必须原样复制 children」，方向完全反了，
> 并直接导致 2026-11-05 的整片空白故障。以本表为准。

### ⚠️ inject factory 的返回值 = dispose 回调（2026-11-05 DevTools 实测）

`ctx.slots.inject(name, factory)` 里，宿主把 **factory 的返回值**当作 dispose 回调，
在**切换会话**时调用，且之后**不再调用 factory**。

- 返回 `ctx.slots.register(...)` 的注销句柄 → 切换会话 = 自己注销自己 →
  本进程内插件永久失效（内建接管：卡片消失、新会话也没有、Console 沉默）。
- 正确做法：返回 noop `() => {}`。渲染器应对所有会话生效，不随会话切换注销。

取证特征：Console 里启动时有「渲染器已注册 / 首次渲染」两行，切换会话后**无任何新行**。

渲染时的 props 组装（`dsh-client-ui-renderer/lib/client.js` → `standardKit`）：

```
kit = 标准 props + renderFactorySlot
    + t（entry.locale 存在时）
    + renderSlot（entry.children 存在时）  ← 缺 children 就没有 renderSlot
    + SessionProvider（有 session 级子 slot 时）
```

`renderSlot` 是**按 entry 绑定**的（`boundRenderSlot(host, entry)`），
只能调用自己 entry 声明过的子 slot。

### 所有已注册的 key

| key | 渲染组件 | priority |
|---|---|---|
| `user` | `UserMessageNodeView` | 默认 |
| `steering` | `UserMessageNodeView`（复用） | 默认 |
| `context` | `ContextMessageNodeView` | 默认 |
| `turn-trigger` | `TurnTriggerNodeView` | 默认 |
| `system-prompt` | `SystemPromptNodeView` | 默认 |
| **`assistant-step`** | **`AssistantNodeView`** | **默认 ← 要替换这个** |
| `command` | `CommandNodeView` | 默认 |
| `manual-compaction` | `ManualCompactionNodeView` | 默认 |
| `compaction` | `CompactionNodeView` | 默认 |
| `model-retry` | `RetryNodeView` | 默认 |
| `turn-error` | `TurnErrorNodeView` | 默认 |
| `turn-max-tokens` | `TurnMaxTokensNodeView` | 默认 |
| `turn-process` | `TurnProcessNodeView` | 默认 |
| `turn-tail` | `TurnTailNodeView` | 默认 |
| `unknown` | `UnknownNodeView` | 默认 |

### 渲染器 props 结构

`ChatNodeSeat.tsx` 里：

```ts
const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
renderSlot('conversation.chat.node', routedOwner, {
  entryKey: routedNode.kind,
  hookContext,
  fallback: <JsonBlock ... />,
})
```

`owner` 来自 `ChatNodeOwnerProps`，含 `groupPart` / `cwd` / `openFile` / `inspectCall` / `forkAt` / `loadImage` / `turnProcess`。

**所以渲染器收到的是 `{ node, groupPart, cwd, openFile, ..., renderSlot, t, ... }`。**

`node` 的类型：`ChatNode<'assistant-step'>`，含 `kind` / `data` / `key` / `anchorSeq` / `location` / `visibility`。

---

## 三、AssistantChatData 结构

**来源**：`packages/client/ui-chat/src/client/contract/chat-nodes.ts`

```ts
export interface AssistantChatData {
  readonly status: 'running' | 'settled' | 'interrupted'
  readonly turn: number
  readonly step: number
  readonly blocks: readonly AssistantBlock[]
  readonly time: number
  readonly usage?: unknown
  readonly finalNode?: AssistantMessageNode
}
```

### AssistantBlock 的四种 kind

从 `assistant.ts` 的 `updateChunk` 与 `AssistantMarkdown.tsx` 的 switch 确认：

| kind | 字段 | 说明 |
|---|---|---|
| `text` | `{ kind: 'text', text: string }` | 正文 |
| `reasoning` | `{ kind: 'reasoning', text: string }` | 思考过程 |
| `image` | `{ kind: 'image', attachment }` | 图片，走图片画廊 slot |
| `tool-call` | `{ kind: 'tool-call', callId, name, argsRaw }` | 工具调用头，由 ChatView 分组渲染 |
| 其他 | `{ kind: xxx, block }` | 未知块，走 JsonBlock 兜底 |

---

## 四、MarkdownText 真实用法

**来源**：`packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx`

```tsx
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

<MarkdownText
  key={i}
  text={block.text}          // ← 注意是 text，不是 content
  streaming={streaming}
  labels={labels}
  fileMentions={mentions}
  pathImages={pathImages}
  textInteractionSource={textInteractionSource}
/>
```

**关键**：prop 名是 **`text`**，不是 `content`。我最初写错了。

### labels 的构造

```tsx
const labels = useMemo(() => markdownLabels(t), [t])
```

`markdownLabels` 来自 `../markdown-labels.ts`，签名 `(t) => MarkdownLabels`。

### pathImages 的构造

```tsx
const pathImages = useMemo<MarkdownPathImages>(() => ({
  resolve: value => localPathMediaUrl(document.baseURI, value)
}), [])
```

### 遍历与 groupPart 分流

```tsx
for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i]
  if (block === undefined) continue
  if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
  if (groupPart === 'response' && block.kind === 'reasoning') continue
  switch (block.kind) {
    case 'text': rendered.push(<MarkdownText ... />); break
    case 'reasoning': rendered.push(<ProcessReasoning ...>); break
    case 'image': /* 连续图片合并成画廊 */ break
    case 'tool-call': break   // 由 ChatView 分组
    default: rendered.push(<JsonBlock ... />)
  }
}
```

**`groupPart` 语义**：
- `undefined` → 全渲染
- `'reasoning'` → 只渲染 reasoning 块
- `'response'` → 只渲染非 reasoning 块

---

## 五、我最初写错的三处（已确认）

| # | 我写的 | 真实 | 后果 |
|---|---|---|---|
| 1 | `globalThis.__DSH_PRIMITIVES__` | `import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'` | 拿不到渲染器，降级路径失效 |
| 2 | `key: 'assistant'` | `key: 'assistant-step'` | **slot 匹配不上，插件完全不生效** |
| 3 | `props.node.data.content`（字符串） | `node.data.blocks[]` 数组，每块 `{kind, text}` | 拿不到内容，永远走降级 |

额外错误：
- `MarkdownText` 的 prop 是 `text` 不是 `content`
- 内置渲染器**没有** priority 字段，我以为要给
- `props` 是一堆回调 + `node`，不是 `{node: {data: {content}}}`

---

## 六、桌面版安装机制（2026-11-05 实测）

用户环境：DSH 桌面版 **0.2.2-rc.1**，已装 `dshmarket` v1.70.2（插件市场）。

### 目录与角色

| 路径 | 角色 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` | profile 依赖声明 + `dsh.profile.bundles` 列表 |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | **插件挂载清单**（扁平 `- id:/name:`），最终生效的地方 |
| `~/.dsh/profiles/desktop/cordis.yml` | 空列表，`[]`。注释明确写 "Edit cordis.patch.yml, not this file" |
| `~/.dsh/profiles/desktop/node_modules/` | 已装插件实体目录（pnpm hoisted 模式） |
| `~/.dsh/profiles/node_modules/@deepseek-ai/` | 宿主核心包（大量是**断链**，指向已不存在的 npm 全局路径） |
| `D:\Program Files (x86)\DeepSeek Harness\resources\app.asar` | 桌面版打包产物（宿主包打进了 asar） |

### 两种 patch.yml 别搞混

- **插件自己的** `cordis.patch.yml` → **bundle 契约**，`insert:` 嵌套格式
  ```yaml
  insert:
    - id: dsh-market
      name: 'dshmarket'
  ```
- **profile 的** `cordis.patch.yml` → 挂载清单，扁平格式
  ```yaml
  - id: ui-rich-response
    name: dsh-rich-response
  ```

### 桌面版安装两步（无需 CLI）

```bash
# 1. 插件文件放进 profile 的 node_modules
cp -r <plugin> ~/.dsh/profiles/desktop/node_modules/dsh-rich-response

# 2a. profile/package.json 的 dependencies 加一项
"dsh-rich-response": "0.1.0"

# 2b. profile/package.json 的 dsh.profile.bundles 加一项
"dsh-rich-response"

# 2c. profile/cordis.patch.yml 追加挂载
- id: ui-rich-response
  name: dsh-rich-response
```

**不需要 pnpm** —— hoisted 模式下 `node_modules` 里是实体目录，手动复制即可。
（`dependencies` 里写版本号而非 `file:` 路径，避免 pnpm 去解析本地依赖。）

改完**重启桌面版**。

---

## 七、客户端模块机制（来源 packages/client/modules/README.md）

### 宿主提供构建产物

> "The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch"

→ **`exports["./client"]` 必须指向已构建的 `lib/client.js`。**
→ 宿主**不打包**你的源码，它直接服务 `exports["./client"]` 指向的文件。

> ⚠️ **2026-11-05 修正**：早期这里写着「不需要自己打成 `__ModuleLoader__` 格式」——
> **这是错的**，而且就是本次崩溃的直接原因。
> 宿主服务的就是你的 `lib/client.js` 原文，用 `<script>` 执行。
> 所以你的产物**必须自己就是** `__ModuleLoader__.load({ id, factory })` 形态。
> 社区插件用 tsdown/rolldown 生成这个形态；我们用零依赖的构建脚本手写生成，效果等价。

### externals 在 baseline 里

> "The shell seeds a frozen module table (`PLATFORM_MODULES`); every dynamic bundle resolves its externals against exactly that baseline. `dsh.client.external` adds only exact non-baseline requests"

→ `@deepseek-ai/dsh-client-ui-primitives` **在 baseline 里**，直接 import 即可。
→ `dsh.client.inject` 是**包与包之间的依赖边**，不是给 primitives 用的。
   （对照 dshmarket：它只声明 `ui-locale` / `ui-settings` / `ui-theme`，没有 primitives。）

### 运行时模块表

> "The shell installs that returned system as its Loader's `internal`"

插件 bundle 以 `window.__ModuleLoader__.load({id, factory})` 形式被加载，
factory 收到的 `require` 由宿主的模块表解析 —— 所以 bare specifier 能解析到
宿主内部模块，即使 node_modules 里没有实体。

### 兼容性陷阱（来源 dshmarket 源码注释）

> "The primitives module is host-injected (external at build time), so on an older host the module resolves but these named exports are undefined — rendering would throw and blank the whole settings dialog."

→ 必须拿到**整个命名空间对象**才能探测 named export 是否存在
（ESM 里是 `import * as primitives`；module-loader 格式里 `require()` 返回的就是命名空间）。
→ 缺失时**放弃接管渲染**，保持宿主默认 —— 聊天区白屏的代价远大于插件不生效。

---

## 八、我最初写错的四处（已确认）

| # | 我写的 | 真实 | 后果 |
|---|---|---|---|
| 1 | `globalThis.__DSH_PRIMITIVES__` | `require('@deepseek-ai/dsh-client-ui-primitives')` | 拿不到渲染器，降级路径失效 |
| 2 | `key: 'assistant'` | `key: 'assistant-step'` | **slot 匹配不上，插件完全不生效** |
| 3 | `props.node.data.content`（字符串） | `node.data.blocks[]` 数组，每块 `{kind, text}` | 拿不到内容，永远走降级 |
| 4 | 顶层 `import` | `window.__ModuleLoader__.load({id, factory})` | **启动即崩溃，且拖垮同批次所有插件** |

额外错误：
- `MarkdownText` 的 prop 是 `text` 不是 `content`
- 内置渲染器**没有** priority 字段，我以为要给
- `props` 是一堆回调 + `node`，不是 `{node: {data: {content}}}`
- `dsh.client.inject` 里声明 `ui-primitives` 是多余的
- **相对路径 `require('./parser.js')` 不被支持** → 解析器必须内联

---

## 九、修正后的实现策略

### 方案：替换 assistant-step 座位，但保留内置渲染器的全部外围逻辑

内置 `AssistantNodeView` 做了很多事（reasoning 折叠、图片画廊、tool-call 分组、
文件提及、上下文菜单、turn-process 联动）。**不要重写它。**

本插件只做一件事：**接管 text 块的处理**。

```js
window.__ModuleLoader__.load({
  id: 'dsh-rich-response',
  factory: (require) => {
    const { createElement, Fragment } = require('react')
    const primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives')
    const { JsonBlock, MarkdownText } = primitivesModule

    const REQUIRED_PRIMITIVES = ['MarkdownText', 'JsonBlock']

    function apply(ctx) {
      const gaps = missingPrimitives(primitivesModule)
      if (gaps.length > 0) return   // 放弃接管，保持默认渲染
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.node',
            key: 'assistant-step',
            locale: 'conversation',
            priority: -10,
            children: {                       // ⚠️ 必须与内建一致
              'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
              'conversation.chat.message.images': { kind: 'single', scope: 'session' },
            },
          },
          RichAssistantNodeView,
        ),
      )
    }

    return { name: 'dsh-rich-response', inject: ['slots'], apply }
  },
})
```

### 已验证 / 待验证

| 项 | 状态 |
|---|---|
| `priority: -10` 遮蔽内置（内置为 0） | ✅ 宿主 slots 源码实证「lowest renders」 |
| `exports["./client"]` → `lib/client.js` | ✅ 已按 dshmarket 对齐 |
| `ui-primitives` 在 baseline 里可直接 require | ✅ 已按官方文档 + dshmarket 实证 |
| 命名空间对象 + 能力探测 | ✅ 已实现 |
| **module-loader 形态，classic script 可执行** | ✅ vm 沙箱验证 + 接缝自检有回归防线 |
| **`children` / `locale` 声明完整** | ✅ 已按内建源码逐字对齐（locale 已修正为 `chat`） |
| **渲染树结构正确**（四种卡片 + 分流 + 流式） | ✅ vm 沙箱端到端验证 |
| **MarkdownText prop 清单完整** | ✅ 已按 web bundle 实证补齐（含 `labels`） |
| **错误隔离**（三层 ErrorBoundary） | ✅ 端到端测试验证降级生效 |
| **实际渲染效果** | ❌ **未在运行的 DSH 上验证（需重启桌面版）** |
| **reasoning / 图片 / tool-call 是否完好** | ❌ 未在真机验证 |
| **流式是否闪烁** | ❌ 未在真机验证 |

---

## 十、第三次翻车：「回复区整片空白」（2026-11-05 实测）

### 症状

聊天区**助手回复正文整片空白** —— 用户气泡、工具栏（复制/点赞/分享）、
输入框、侧栏一切正常，唯独 AI 回复内容不见。

10 月 31 日的老会话也一样空白 → 不是数据问题，是渲染层问题。

### 排查路径（值得记住的方法）

桌面版把宿主打进了 `app.asar`（203MB）。**真实产物可以直接提取出来扒**：

```bash
# 1. 解析 asar 索引（header 是 JSON）
node -e "
const fs=require('fs');
const header=JSON.parse(fs.readFileSync('asar-header.json','utf8'));
// 递归 walk 找文件
"

# 2. 提取目标文件
#    asar 的 dataStart = 8 + headerStringPickleSize
node -e "
const n=header.files.dsh.files.node_modules.files['@deepseek-ai']
       .files['dsh-client-ui-chat'].files.lib.files['client.js'];
const buf=Buffer.alloc(n.size);
fs.readSync(fd,buf,0,n.size,5748652+Number(n.offset));
"
```

关键产物：

| 文件 | 用途 |
|---|---|
| `dsh-client-ui-chat/lib/client.js`（689KB） | 内建 `AssistantNodeView` / `AssistantMarkdown` 真实实现 |
| `dsh-client-ui-renderer/lib/client.js` | `standardKit` / `boundRenderSlot` / `SlotErrorBoundary` |
| `dsh-client-locale/lib/client.js` | locale face 的 `bind` 语义 |
| `dsh-web-frontend/dist/assets/index-*.js`（970KB） | **primitives 全在这里**（`MarkdownText` 等），是压缩后的 web bundle |

### 根因链（三步，每步都有源码锚点）

**第一步：宿主 `MarkdownText` 的真实签名**

web bundle 里的实现（压缩后）：

```js
F4 = k.memo(function({
  text: t, streaming: r = !1, labels: i, fileMentions: n,
  pathImages: s, variant: l = "body", omitHtml: u = !1,
  textInteractionSource: f = !1
}) { ... })
```

→ **一共 7 个 prop**。本插件原先只传了 3 个（`text` / `streaming` / `textInteractionSource`），
**漏了 `labels`**。

**第二步：渲染代码块时无条件解引用 `labels.code`**

```js
function oU(e, t, r) {
  ...
  return p.jsx(Qy, {
    code: `${e.value}\n`, lang: n, streaming: r.streaming,
    copyLabel: r.labels.code.copyLabel,        // ← 这里
    copiedLabel: r.labels.code.copiedLabel,
    toolbarLabels: r.labels.code.toolbarLabels
  }, t)
}
```

→ `labels` 为 undefined → `TypeError: Cannot read properties of undefined (reading 'code')`。

（另有一处 `p_()` 里读 `e.labels.footnotes`，有脚注时同样会崩。）

**第三步：宿主的 SlotErrorBoundary 把异常变成空 div**

`dsh-client-ui-renderer/lib/client.js`：

```js
var SlotErrorBoundary = class extends react.Component {
  state = { failed: false };
  static getDerivedStateFromError(error) {
    if (error instanceof SlotAssemblyError) throw error;
    return { failed: true };
  }
  render() {
    const Anchor = this.props.anchor ?? "div";
    if (this.state.failed) return jsx(Anchor, { "data-slot-error": this.props.slotKey });
    return this.props.children;
  }
};
```

→ 异常被捕获后渲染 `<div data-slot-error="conversation.chat.node"></div>`
→ **正文整片空白，而 UI 其余部分完全正常**。

这解释了整个症状：为什么只有回复正文没了、为什么没有报错弹窗、为什么老会话也空白。

### 修复

1. **补齐 `MarkdownText` 全部 prop**：`labels` / `fileMentions` / `pathImages`
   - `labels` 按宿主 `markdownLabels(t)` 的结构自建，且**永远返回对象，绝不为 undefined**
   - `pathImages` 等价实现宿主 `localPathMediaUrl` → `fileMediaUrl` 的规则
     （这两个函数在 chat 包内部，插件拿不到）
2. **三层 ErrorBoundary 兜底**（详见下节）
3. **修正 locale 命名空间**：`'conversation'` → `'chat'`（见下节）

### ⚠️ 为什么必须用 ErrorBoundary 而不是 try/catch

**React 的渲染错误发生在子组件渲染阶段，不在 `createElement` 调用时。**

```js
try {
  createElement(MarkdownText, { text })   // ← 只是构造元素描述对象
} catch { /* 抓不到任何东西 */ }
// 真正的 TypeError 发生在 React 渲染 MarkdownText 时
```

只有 class 组件的 `getDerivedStateFromError` 能拦住。本插件现在有三层：

| 边界 | 位置 | 失败时降级到 |
|---|---|---|
| `TextBlockBoundary` | 每个 text 块 | 宿主原生 markdown |
| `BlockViewBoundary` | 每个结构块 | 宿主原生 markdown |
| `AssistantNodeBoundary` | 整个 assistant-step | 宿主原生渲染 |

**铁律：渲染器内部绝不向外抛异常。**
否则宿主的 `SlotErrorBoundary` 就会接手，整条回复消失。

---

## 十一、第二轮实证修正（对照 app.asar 真实产物）

前面几节基于 GitHub 源码的结论，有两处**与桌面版真实产物不符**，本节更正。

### 11.1 locale 命名空间是 `chat`，不是 `conversation`

`dsh-client-ui-chat/lib/client.js` 实测：

```js
/** Chat-owned locale namespace and dictionaries. */
const NS = "chat";
// ...
ctx.slots.register({
  name: "conversation.chat.node",
  key: "assistant-step",
  locale: NS,        // ← "chat"
  ...
})
```

→ 本插件原先写 `locale: 'conversation'` 是**错的**。

写错**不会崩**（`locale face.bind(ns)` 对未知命名空间只是回退到返回 key 本身，
见 `dsh-client-locale/lib/client.js` 的 `bind(ns)`），
但所有 UI 文案会变成裸 key（如 `message.unknownBlock`）。

### 11.2 内建还注入了这些 prop

```js
inject: (sessionId) => ({
  hooks: { presentation },
  resolveFilePath: sessionFilePath(ctx, sessionId),
  fileMentions: (owner, getFileTriggerProps) =>
    ctx.get("chatFileMentions")?.forClosing(owner, sessionId, getFileTriggerProps)
})
```

→ 覆盖内建渲染器时，**inject 也要重复声明**，否则 `fileMentions` 拿不到，
`@路径` 提及无法点开。

### 11.3 `priority` 的方向（宿主原文）

`dsh-client-ui-web` bundle 里的 slots 源码：

```js
const s = f => `at priority ${n}... — register at a different priority to shadow it (lowest renders)`;
```

→ **数字越小越优先**，`priority: -10` 方向正确。

排序实现：

```js
u.sort((f, h) => (f.options.priority ?? 0) - (h.options.priority ?? 0))
```

→ `entriesOfSlot` 取每个 key 的**第一条** → 我们的 `-10` 排在内建（0）之前 → 确实抢到了。

### 11.4 `standardKit` 决定渲染器拿到哪些 props

`dsh-client-ui-renderer/lib/client.js`：

```js
function standardKit(host, entry, scope, rootBinding, scopeBinding) {
  const standard = standardProps(scope, rootBinding, scopeBinding);
  const kit = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) };
  if (entry.locale !== void 0) {
    const face = host.locale;
    if (face === void 0) throw new SlotAssemblyError(...);
    kit["t"] = localeSeat(face, entry.locale);
  }
  ...
  if (entry.children !== void 0) {
    kit["renderSlot"] = boundRenderSlot(host, entry);
    ...
  }
  return { kit, standard, actions: store?.actions };
}
```

→ **`entry.children` 有值才有 `renderSlot`**；`entry.locale` 有值才有 `t`。
→ `boundRenderSlot` 是**按 entry 绑定**的，只能调用自己声明过的子 slot。

---

## 十二、测试体系（2026-11-05 扩充）

| 套件 | 断言数 | 防什么 |
|---|---|---|
| `parser-test.mjs` | 24 | 协议解析与降级矩阵 |
| `verify-build.mjs` | 13 | 产物与源码漂移 |
| `check-seam.mjs` | 68 | 宿主 API 契约跑偏 |
| `mutation-test.mjs` | 13 变异 | **自检脚本假绿** |
| `render-e2e.mjs` | 16 | **回复区整片空白** |

### 12.1 变异测试：自检脚本自己也得有测试

本轮 `check-seam.mjs` 出现过**两次假绿**：

1. **正则被注释误匹配**
   断言 `/createElement\(MarkdownText,\s*\{[\s\S]*?\n\s*\}\)/` 匹配到了
   *注释里提到的* `createElement(MarkdownText, {...})` —— 断言对象根本不是代码。
   → 修法：先剥掉所有注释再匹配。

2. **子串陷阱**
   断言统计 `getDerivedStateFromError` 出现次数 ≥3，
   把方法改名成 `getDerivedStateFromErrorDISABLED` 后**仍然是子串，照样全绿**。
   → 修法：加词边界 `\s*\(`，并锚定真实的 `class X extends Component` 定义。

3. **只查第一个匹配**
   断言 `priority:\s*(-?\d+)` 匹配到的是源码里**另一处** `priority: -10`，
   把注册处改成 `priority: 0` 也照样通过。
   → 修法：`matchAll` 收集全部，要求**每一个**都为负。

`mutation-test.mjs` 就是把这些坑固化成可执行的反向验证。

### 12.2 端到端渲染测试：用「按宿主行为写的假 MarkdownText」

`render-e2e.mjs` 里的假 `MarkdownText` 是照宿主源码写的：

```js
if (hasCodeBlock) {
  const copyLabel = options.labels.code.copyLabel   // 与宿主 oU() 一致
  ...
  if (copyLabel === undefined) throw new TypeError("Cannot read properties of undefined (reading 'code')")
}
```

→ 删掉 `labels` 时这个测试**真的会失败**（已实测：16 项 → 7 项通过、9 项失败），
而不是只做字符串匹配。

### 12.3 沙箱验证法的延伸

原有的 `vm.runInContext` 验证法（classic script 语义）继续有效，
本轮又扩展出两种用法：

- **假 seed 表**：用假的 `react` / `primitives` 跑起 factory，取出注册的组件
- **最小 React 渲染器**：手写 `renderNode` 执行函数组件与 class 组件，
  把渲染树转成字符串，检查「有没有内容」

⚠️ 写这类桩时踩到的坑：class 组件必须**先于**函数组件判断，
否则 `type(props)` 会抛 `Class constructor cannot be invoked without 'new'`。

## 十三、启发式增强：把旧记录渲染成卡片（2026-11-05）

> ⚠️ **已废弃（同日当晚）**：用户实测该效果生硬 —— 正常回答被硬塞进三列白卡片，
> 卡片内是纯文本渲染，行内代码的反引号直接外露。已按用户要求去掉启发式自动改写：
> `heuristicSegments` 及其辅助函数、`block.items` 预抽取全部移除。
> 随后（同日 20:xx）用户反馈「插件不能自动生效就没意义」，因此恢复了**保守版**宿主半区
> 协议注入：只告诉模型四类块存在及适用/不适用场景，不做任何启发式改写；注入可用
> `config.enabled: false` 关闭。插件仍是纯被动渲染器 —— 只有模型输出合规 `:::` 围栏时才出卡片。
> 本章以下内容仅作历史记录保留，不代表当前实现。

### 为什么需要（历史背景）

渲染是**协议驱动**的：只有模型输出了 `:::` 围栏，`parseRich` 才解析出结构块、
渲染器才画卡片。插件上线**之前**生成的历史回复里没有围栏，于是永远走
`renderHostText` 普通 markdown 路径 —— 这不是 bug，是协议消息与历史消息的本质差别。

`heuristicSegments(text)`（在 `src/parser.js`，随 build 内联进 bundle）在
「`parseRich` 没解析出任何块」时兜底，从纯 markdown 里认出表格 / 紧凑列表，
合成与协议块**同形**的结构（`{type, attrs, raw, level:0, items?}`），交给同一套卡片渲染器。

### 两道门（缺一不可，check-seam + mutation 都盯着）

`RichTextBlock` 里的触发条件：

```js
if (!hasBlock && !streaming) {
  const enhanced = heuristicSegments(text)
  if (enhanced && enhanced.some((s) => s.kind === 'block')) { segments = enhanced; hasBlock = true }
}
```

| 门 | 少了会怎样 |
|---|---|
| `!hasBlock` | 会去增强**协议消息**，与模型主动输出的围栏重复/冲突 |
| `!streaming` | 流式过程中半截表格/列表被反复识别 → **卡片闪烁** |

历史消息都是 `settled`（`streaming = data.status === 'running'` 为 false），所以照常被增强。

### 识别规则（适中档，用户选定）

- markdown 表格（表头含 `|` + 分隔行带 `|` 或 `:`）→ `table` 卡
  - 要求分隔行带 `|`/`:` 是为了排除「一行文本 + 一条 `---` 分隔线」被误判成表格
- ≥2 项的**紧凑**列表（连续、同缩进、无空行/续行）→ 无序 `points` / 有序 `steps`
  - 松散列表（项间空行）、带续行的列表**不转** —— 转换会丢续行内容，宁可不转
- 散文 / 标题 / 代码块内部 / 单项列表 一律不动
- `heuristicSegments` 自身永不抛（任何意外 → `null` → 调用方走宿主原生 markdown）

### items 预抽取（渲染层改动）

plain 列表条目（`- 苹果`）没有粗体小标题，协议的 `parsePoints` 抽不出来
（它的正则要求 `**bold**`）。所以启发式块自带 `items` 字段，渲染层改成：

```js
const items = block.items ?? parsePoints(block.raw)   // PointsGroup
const items = block.items ?? parseSteps(block.raw)    // StepsFlow
```

协议块没有 `items` → 回退原解析，行为不变。

### 测试覆盖

- `tests/heuristic-test.mjs`（34 项）：识别 / 不误判 / 不丢内容 / 交错 / fuzz / 性能
- `tests/check-seam.mjs`：5 条门控断言（两道门、try 包裹、两处 `block.items ??`）
- `tests/mutation-test.mjs`：4 条反向变异，证明上述断言非空转（共 18 抓住 / 0 漏过）
- `tests/render-e2e.mjs`：settled 纯 markdown 含表格+列表 → 出 `rr-table`/`rr-points`；
  `running` 时同一文本**不**增强


