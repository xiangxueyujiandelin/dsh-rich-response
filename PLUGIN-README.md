# dsh-rich-response

给 DeepSeek Harness 的回复加上颜色、色块背景和结构化卡片。

---

## 效果

**普通回复**（现状）：

```
丢了其实不是数据

区别在这里：
• 数据在 ref 里会读写，ttl>0 表示会话还活着。
• 入口没了：模型无法再用页面方式把它取回来。
• 那个 uuid 你也没法转。

实际影响与规避
大多数时候无关紧要……
```

**装了插件之后**：

```
╭──────────────────────────────────────╮
│ 结论                                  │  ← 紫边浅紫底
│ 丢失的是可定位坐标，不是数据本身。       │
╰──────────────────────────────────────╯

┌──────────┐ ┌──────────┐ ┌──────────┐
│ ● 数据在   │ │ ● 入口没了 │ │ ● uuid   │
│ ref 会读写 │ │ 页面方式取 │ │ 无法塞进 │
│ ttl>0 存活 │ │ 不回       │ │ 另一循环 │
└──────────┘ └──────────┘ └──────────┘

╭──────────────────────────────────────╮
│ 补充说明                                │  ← 蓝边浅蓝底
│ ttl>0 表示会话还活着…                    │
╰──────────────────────────────────────╯
```

---

## 安装

```bash
# 从 GitHub 装
dsh plugin --profile web add github:xiangxueyujiandelin/dsh-rich-response

# 本地开发（link 安装，改完刷新即见）
dsh plugin --profile web add .

# 验证是否挂上
dsh --profile web --dump-config | grep dsh-rich-response
```

**安装后需要重启 DSH 进程**（bundle 层只在启动时组装）。

---

## 开发

```bash
node scripts/build.mjs        # 编译到 lib/
node tests/parser-test.mjs    # 协议用例集（31 项）
node tests/semantic-test.mjs  # S 族区间检测（22 项）
node tests/verify-build.mjs   # 构建产物一致性（13 项）
node tests/check-seam.mjs     # 宿主接缝自检（87 项）
node tests/register-seam.mjs  # 注册期接缝 + 空白根因复现（10 项）
node tests/host-half-test.mjs # 宿主半区注入（15 项）
node tests/mutation-test.mjs  # 变异测试（16 变异，防自检假绿）
node tests/render-e2e.mjs     # 端到端渲染验证（40 项，防回复区空白）
```

合计 218 条断言 + 16 个变异。一次跑全套用 `npm run test:all`（会先重建 `lib/`）。

零构建依赖，clone 下来就能跑。

### 调试要点

| 改动 | 生效方式 |
|---|---|
| `src/parser.js` | 重新 build + 硬刷新（Ctrl+Shift+R） |
| `src/client.js` | 重新 build + 硬刷新 |
| `src/rich-response.css` | 重新 build + 硬刷新 |
| `package.json` / `cordis.patch.yml` | **必须重启 DSH 进程** |

### 排查「回复区空白」

宿主在 slot 外套了 `SlotErrorBoundary`：渲染器一旦抛错，它会渲染一个**空 div**，
现象是「助手回复正文整片空白，但侧栏/输入框/工具栏一切正常」。

排查顺序：

1. 打开 DevTools Console，看有没有 `slot entry crashed in 'conversation.chat.node'`
2. 跑 `node tests/register-seam.mjs` —— 注册期崩溃（空白最常见根因，含历史版复现）
3. 跑 `node tests/render-e2e.mjs` —— 它用按宿主行为写的假 `MarkdownText` 复现
4. 跑 `node tests/check-seam.mjs` —— 检查宿主契约是否跑偏
5. 跑 `node tests/mutation-test.mjs` —— 确认自检断言本身不是假绿

DevTools Network 里能看到 `/plugins/dsh-rich-response/client.js` 这个请求。

---

## 工作原理

### 三层模型

| 层 | 本插件做了什么 |
|---|---|
| **内容层** | 提供 skill（`skills/rich-response/SKILL.md`）教模型按协议输出 |
| **渲染层** | 注册 `conversation.chat.node` 的 `assistant-step` 座位，替换内置 markdown 渲染器 |
| **外壳层** | 自定义色板用 CSS 原生变量 + `prefers-color-scheme` 实现，亮暗成对 |

### 关键实现

**产物的加载格式**（宿主用 `<script>` 加载，是 classic script，**不是 ES module**）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-rich-response',
  factory: (require) => {
    const { createElement, Fragment } = require('react')
    const primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives')
    // ...
    return { name: 'dsh-rich-response', inject: ['slots'], apply }
  },
})
```

⚠️ 顶层 `import` 会让 DSH **启动失败**（`Cannot use import statement outside a module`），
而且宿主把多个插件的 bundle 拼成一个脚本一起执行 —— 一个写错，同批次全挂。

**替换渲染器**（参考 `dsh-markstream` 的做法）：

```js
ctx.slots.register(
  {
    name: 'conversation.chat.node',
    key: 'assistant-step',
    locale: 'chat',
    priority: -10,
    // 不要写 children —— 子 slot 的声明权是独占的
  },
  RichResponseView,
)
```

`key` 必须是 `'assistant-step'`（来自 `register-node-renderers.ts`），写成 `'assistant'` 匹配不上座位，插件完全不生效。

`priority: -10` 遮蔽内置渲染器（内置为 0）。停用插件即恢复宿主默认。

`locale` 必须是 `'chat'`。写成 `'conversation'` 匹配不上，拿不到 `t` 翻译函数。

**不要声明 `children`。** 子 slot 的声明权是独占的：内置 `assistant-step` entry 已经声明了
`conversation.chat.reasoning.body` 和 `conversation.chat.message.images`，再声明一次会在**注册期**抛

```
slot "conversation.chat.reasoning.body" is already declared (by an entry in "conversation.chat.node" (...))
```

于是这个 slot 没有任何可用渲染器，宿主 `SlotErrorBoundary` 把每条助手回复渲染成空 div ——
现象是「回复区整片空白，侧栏和输入框一切正常」（2026-11-05 真实事故，根因即此）。
代价是拿不到 `renderSlot`，所以推理块和图片块需要自己画。

`factory` 的返回值同样有约定：宿主把它当「切换会话时的 dispose 回调」，
**必须返回空函数 `() => {}`**。返回 `register` 的注销句柄，会让插件在切换一次会话后永久失效（实测踩过）。

**降级路径走宿主渲染器**，不自己实现 markdown 渲染：

```js
if (block.level >= 2) {
  return createElement('div', { className: 'rr-md' }, renderHostText(block.raw, false, props))
}
```

模型不配合是常态，不是异常。L2/L3 一律不给用户显示错误提示。

---

## 协议

标记语法、降级矩阵、API 契约见 [`protocol/rich-render-protocol-v1.md`](protocol/rich-render-protocol-v1.md)。

**S 族**直接复用 GitHub Alerts，模型零学习成本：

```markdown
> [!NOTE]
> 补充说明
```

**X 族**用 `:::` 围栏：`summary` / `points` / `table` / `steps` / `columns`。

---

## 目录

```
├── package.json              # dsh 插件契约声明
├── cordis.patch.yml          # 挂载声明
├── src/
│   ├── index.js              # 宿主半区（注入富渲染协议）
│   ├── client.js             # 客户端半区（渲染核心）
│   ├── parser.js             # 解析器（运行版）
│   ├── parser-reference.ts   # 解析器（TS 参考实现）
│   └── rich-response.css     # 样式
├── scripts/build.mjs         # 构建脚本
├── tests/                    # 8 套：parser / semantic / verify-build / check-seam
│                             #      register-seam / host-half / mutation / render-e2e
├── skills/rich-response/     # 内容层 skill
├── protocol/                   # 协议规范
└── docs/                      # 技术方案 + 宿主契约
```

---

## License

MIT
