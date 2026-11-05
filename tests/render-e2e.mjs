/**
 * 端到端渲染验证 —— 用宿主真实契约模拟渲染，检查不会出现「正文空白」
 *
 * 背景：2026-11-05 真实故障 —— 聊天区助手回复正文整片空白。
 * 根因：MarkdownText 少传 labels，宿主渲染代码块时执行
 *      `r.labels.code.copyLabel` 抛 TypeError，
 *      被宿主 SlotErrorBoundary 捕获 → 渲染空 div → 正文消失。
 *
 * 这个脚本用一个**按宿主真实实现写的假 MarkdownText** 来跑产物：
 *   - 缺 labels 时抛 TypeError（模拟宿主真实行为）
 *   - 缺 pathImages / fileMentions 时按宿主行为退化
 * 然后断言：渲染带代码块的回复不再抛错、且产出了内容。
 *
 * 运行：node tests/render-e2e.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientCode = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let pass = 0,
  fail = 0
function t(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

// ── 1. 加载产物，取出注册的渲染器 ──────────────────────────
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (r) => { captured = r } } },
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(clientCode, sandbox, { filename: 'lib/client.js' })

// ── 2. 假 React + 假 primitives ────────────────────────────
// 关键：假 MarkdownText **按宿主真实行为**实现 ——
// 遇到代码块就解引用 labels.code.copyLabel（宿主源码：oU 函数）。
const el = (type, props, ...children) => {
  const p = { ...(props ?? {}) }
  if (children.length) p.children = children.length === 1 ? children[0] : children
  return { type, props: p }
}

// 宿主真实行为摘录（web bundle 实测）：
//   function oU(e,t,r){ ... copyLabel: r.labels.code.copyLabel ... }
//   function p_(e){ ... e.labels.footnotes ... }
function fakeMarkdownText(props) {
  const { text = '', labels } = props
  // 宿主 vU 的逻辑：构造 options → 遍历 children → code block 用 labels.code
  const options = { labels, fileMentions: props.fileMentions, pathImages: props.pathImages }
  const hasCodeBlock = /```/.test(text)
  if (hasCodeBlock) {
    // ← 这里就是宿主会抛的地方
    const copyLabel = options.labels.code.copyLabel
    const copiedLabel = options.labels.code.copiedLabel
    const toolbar = options.labels.code.toolbarLabels
    if (copyLabel === undefined || copiedLabel === undefined || toolbar === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'code')")
    }
  }
  // 脚注也解引用 labels.footnotes
  if (/^\[\^/.test(text)) {
    void options.labels.footnotes
  }
  // ⚠️ 2026-11-05 DevTools 实测的宿主真实行为：
  //   MarkdownText 内部执行 `fileMentions?.resolve(...)` ——
  //   期望带 resolve 方法的对象，裸函数会抛 TypeError → slot entry crashed。
  if (props.fileMentions !== undefined && props.fileMentions !== null) {
    props.fileMentions.resolve('@probe')
  }
  return el('MarkdownText', props)
}

const seed = {
  react: {
    createElement: el,
    Fragment: 'Fragment',
    // ⚠️ 2026-11-05：插件用 useState 实现推理折叠行
    useState: (initial) => [initial, () => {}],
    Component: class {
      constructor(p) {
        this.props = p
        this.state = {}
      }
    },
  },
  '@deepseek-ai/dsh-client-ui-primitives': {
    MarkdownText: fakeMarkdownText,
    JsonBlock: (p) => el('JsonBlock', p),
    // ⚠️ 2026-11-05：推理块自己画（不声明 children → 拿不到 renderSlot）
    DisclosureRow: (p) => el('DisclosureRow', p),
    IconThinkOutlineRegular: (p) => el('IconThinkOutlineRegular', p),
  },
}

/** React 基类引用 —— 用来识别 class 组件（ErrorBoundary） */
const ReactComponent = seed.react.Component

const exports_ = captured.factory((s) => {
  if (seed[s]) return seed[s]
  throw new Error('missed module table: ' + s)
})

let reg = null
let spec = null
exports_.apply({
  slots: {
    inject: (k, cb) => {
      cb()
      return () => {}
    },
    register: (o, c) => {
      reg = c
      spec = o
      return () => {}
    },
  },
})

t('产物可执行并注册渲染器', typeof reg === 'function')

// ── 3. 把 React 树渲染成 HTML 字符串 ────────────────────────
// 真实的 React 会执行 class 组件的 render 与生命周期；
// 这里手写一个最小实现，足够验证「有没有崩」和「有没有内容」。
function renderNode(node, out) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach((n) => renderNode(n, out))
    return
  }
  if (typeof node !== 'object') return

  const { type, props } = node

  // class 组件（ErrorBoundary）—— 必须先于函数组件判断，
  // 否则会把 class 当普通函数调用 → "Class constructor cannot be invoked without 'new'"
  if (
    typeof type === 'function' &&
    type.prototype &&
    type.prototype instanceof ReactComponent
  ) {
    const inst = new type(props)
    inst.props = props
    inst.state = {}
    // 正常路径：直接 render
    try {
      renderNode(inst.render(), out)
    } catch (err) {
      // 模拟 getDerivedStateFromError：失败后渲染 fallback
      inst.state = { failed: true }
      renderNode(inst.render(), out)
    }
    return
  }

  // 函数组件
  if (typeof type === 'function') {
    renderNode(type(props), out)
    return
  }

  // host 元素
  if (typeof type === 'string') {
    const cls = props?.className
    if (cls) out.push(`[${type}.${String(cls).split(' ').join('.')}]`)
    else out.push(`[${type}]`)
    // MarkdownText 的正文放在 props.text 里（不是 children）
    if (typeof props?.text === 'string') out.push(props.text)
    renderNode(props?.children, out)
  }
}

function render(text, extra = {}) {
  const out = []
  // ⚠️ 宿主真实行为：渲染 props = inject(sessionId) 的返回值 + 标准 props。
  //   不合并 inject 就抓不到 fileMentions 形状这类接缝错误。
  const injected = typeof spec?.inject === 'function' ? spec.inject('session-probe') : {}
  // ⚠️ 注册的是 class 组件（ErrorBoundary），
  //    必须像 React 一样用 createElement 创建元素，不能直接当函数调用。
  const element = el(reg, {
    ...injected,
    node: {
      data: {
        status: 'settled',
        finalNode: { messageId: 'm1' },
        blocks: [{ kind: 'text', text }],
      },
    },
    groupPart: undefined,
    t: (k) => k,
    renderSlot: () => null,
    ...extra,
  })
  renderNode(element, out)
  return out.join('')
}

console.log('\n── 真实场景：含代码块的回复 ──')
let err = null
let html = ''
try {
  html = render('这是结论。\n\n```js\nconst a = 1\n```\n\n以上。')
} catch (e) {
  err = e
}
t(
  '含代码块的回复不抛异常（← 本次空白故障的现场）',
  err === null,
  err ? String(err.message) : '',
)
t(
  '含代码块的回复产出了正文内容',
  html.includes('这是结论') && html.includes('以上'),
  html.slice(0, 160),
)
t(
  '代码块确实渲染出来了',
  html.includes('MarkdownText'),
  html.slice(0, 160),
)

console.log('\n── 纯文本回复 ──')
err = null
html = ''
try {
  html = render('这是一段普通回复。')
} catch (e) {
  err = e
}
t('纯文本回复不抛异常', err === null, err ? String(err.message) : '')
t('纯文本回复产出了正文', html.includes('这是一段普通回复。'), html.slice(0, 120))

console.log('\n── 混合场景：普通段落 + 代码块 + 结构块 ──')
err = null
html = ''
try {
  html = render(
    ':::summary{title="结论"}\n核心结论在这里。\n:::\n\n细节：\n\n```py\nprint(1)\n```\n\n结束。',
  )
} catch (e) {
  err = e
}
t('混合内容不抛异常', err === null, err ? String(err.message) : '')
t('结构块渲染成卡片', /rr-card/.test(html), html.slice(0, 200))
t('普通段落与结尾都在', html.includes('细节') && html.includes('结束'), html.slice(0, 240))

console.log('\n── 卡片正文的行内 markdown（2026-11-05：反引号 / 加粗曾原样外露）──')
err = null
html = ''
try {
  html = render(
    ':::summary{title="**结论**"}\n正文含 `code` 与 **粗体**，详见 [文档](https://example.com)。\n:::',
  )
} catch (e) {
  err = e
}
t('summary 卡片不抛异常', err === null, err ? String(err.message) : '')
t(
  'summary 标题加粗渲染成 strong（不露 ** 标记）',
  html.includes('[strong]') && !html.includes('**结论**'),
  html.slice(0, 200),
)
t(
  'summary 正文交给宿主 MarkdownText，而不是纯文本 div',
  html.includes('[div.rr-card-body.rr-md]') && html.includes('[MarkdownText]'),
  html.slice(0, 240),
)

err = null
html = ''
try {
  html = render(':::table\n| 项 | 说明 |\n| --- | --- |\n| `a` | **b** |\n:::')
} catch (e) {
  err = e
}
t('table 卡片不抛异常', err === null, err ? String(err.message) : '')
t(
  '表格单元里的行内代码渲染成 rr-inline-code（不露反引号）',
  html.includes('[code.rr-inline-code]') && !html.includes('`a`'),
  html.slice(0, 240),
)
t(
  '表格单元里的加粗渲染成 strong（不露 ** 标记）',
  html.includes('[strong]') && !html.includes('**b**'),
  html.slice(0, 240),
)

err = null
html = ''
try {
  html = render(':::points\n- **A** — 见 **文档** 与 `x` 调用\n:::')
} catch (e) {
  err = e
}
t('points 卡片不抛异常', err === null, err ? String(err.message) : '')
t(
  '要点描述里的加粗 / 行内代码都渲染（不露标记）',
  html.includes('[strong]') &&
    html.includes('[code.rr-inline-code]') &&
    !html.includes('**文档**') &&
    !html.includes('`x`'),
  html.slice(0, 240),
)

console.log('\n── 分栏（columns）：短对照并排，长文自动退单列 ──')
err = null
html = ''
try {
  html = render(':::columns\n左：短条目\n\n---\n\n右：短条目\n:::')
} catch (e) {
  err = e
}
t('短 columns 不抛异常', err === null, err ? String(err.message) : '')
t(
  '短 columns 保持两栏',
  html.includes('rr-columns') && !html.includes('rr-columns-stacked'),
  html.slice(0, 200),
)

err = null
html = ''
try {
  html = render(
    `:::columns\n${'这是一段较长的正文，用来验证分栏遇到密集内容时会退化为单列。'.repeat(6)}\n\n---\n\n${'另一侧同样是较长的正文段落。'.repeat(6)}\n:::`,
  )
} catch (e) {
  err = e
}
t('长 columns 不抛异常', err === null, err ? String(err.message) : '')
t(
  '长 columns 自动退回单列（rr-columns-stacked）',
  html.includes('rr-columns-stacked'),
  html.slice(0, 240),
)

console.log('\n── S 族语义块（GitHub Alerts）──')
err = null
html = ''
try {
  html = render('前文。\n\n> [!WARNING]\n> 小心 `rm -rf`。\n\n后文。')
} catch (e) {
  err = e
}
t('语义块不抛异常', err === null, err ? String(err.message) : '')
t(
  'WARNING 渲染成 warn 色卡片',
  /rr-card/.test(html) && html.includes('rr-tone-warn'),
  html.slice(0, 320),
)
t('语义块标题用中文标签', html.includes('注意事项'), html.slice(0, 320))
t(
  '语义块前后的普通 markdown 都还在',
  html.includes('前文') && html.includes('后文'),
  html.slice(0, 320),
)

err = null
html = ''
try {
  html = render('> 普通引用，不是语义块。')
} catch (e) {
  err = e
}
t(
  '普通引用不误判成语义块',
  err === null && !html.includes('rr-alert'),
  html.slice(0, 200),
)

err = null
html = ''
try {
  html = render('> [!CAUTION]\n> 未定义的告警类型。')
} catch (e) {
  err = e
}
t(
  '未知语义类型降级为 NOTE 样式（info），不崩',
  err === null && html.includes('rr-tone-info') && html.includes('Caution'),
  err ? String(err.message) : html.slice(0, 240),
)

console.log('\n── 纯被动渲染：普通 markdown 不被自动改写成卡片 ──')
err = null
html = ''
try {
  html = render('先看对比：\n\n| 方案 | 优点 |\n| --- | --- |\n| A | 快 |\n\n- 甲\n- 乙\n- 丙')
} catch (e) {
  err = e
}
t('旧 markdown 不抛异常', err === null, err ? String(err.message) : '')
t('settled 时表格仍是宿主原生表格（无 rr-table）', !/rr-table/.test(html), html.slice(0, 240))
t('settled 时列表仍是宿主原生列表（无 rr-points）', !/rr-points/.test(html), html.slice(0, 240))
t('引导文字仍按 markdown 渲染', html.includes('先看对比'), html.slice(0, 240))
t('列表内容没丢', html.includes('甲') && html.includes('乙') && html.includes('丙'))

// 流式（running）时同样不增强
err = null
html = ''
const streamingText = '| A | B |\n| --- | --- |\n| 1 | 2 |'
try {
  html = render(streamingText, {
    node: { data: { status: 'running', blocks: [{ kind: 'text', text: streamingText }] } },
  })
} catch (e) {
  err = e
}
t('流式（running）时不出卡片', err === null && !/rr-table/.test(html), html.slice(0, 200))

console.log('\n── 降级路径：结构非法时静默降级，不给用户看错误 ──')
err = null
html = ''
try {
  html = render(':::points\n- **A** — x\n:::summary\n嵌套\n:::\n:::')
} catch (e) {
  err = e
}
t('结构非法时不抛异常', err === null, err ? String(err.message) : '')
t(
  '没有把错误提示渲染到界面上',
  !/渲染失败|解析失败|Error|出错/.test(html),
  html.slice(0, 200),
)

console.log('\n── 极端输入：空文本 / 超长 / 特殊字符 ──')
for (const [name, text] of [
  ['空文本', ''],
  ['纯空白', '   \n\n  '],
  ['只有代码块', '```\ncode\n```'],
  ['未闭合代码块', '```js\nconst a = 1'],
  ['嵌套反引号', '```\n```js\ninner\n```\n```'],
]) {
  let e2 = null
  try {
    render(text)
  } catch (e) {
    e2 = e
  }
  t(`${name} 不抛异常`, e2 === null, e2 ? String(e2.message) : '')
}

console.log(`\n端到端渲染验证：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
