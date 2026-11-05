/**
 * 验证构建产物 lib/parser.js 与测试用例中的实现行为一致
 * 防止「改了 src 忘了重新构建」导致产物与源码漂移
 *
 * 另外验证：**内联进 lib/client.js 的解析器副本**与 lib/parser.js 行为一致
 * —— 宿主模块表不支持相对 require，两份副本必须同步。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { parseRich } from '../lib/parser.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
function t(id, name, cond) {
  if (cond) { pass++; console.log(`  ok   ${id} ${name}`) }
  else { fail++; console.log(`  FAIL ${id} ${name}`) }
}
const blocks = (r) => r.filter(s => s.kind === 'block').map(s => s.block)

let r = parseRich(':::summary{title="结论"}\n内容\n:::')
t(1, 'summary → L0', blocks(r).length === 1 && blocks(r)[0].level === 0)
r = parseRich(':::summary\n内容\n:::')
t(2, '缺 title → L1', blocks(r).length === 1 && blocks(r)[0].level === 1)
r = parseRich(':::table\n| a | b |\n|---|---|\n| 1 | 2 |\n:::')
t(3, '缺 title 的 table → L1', blocks(r).length === 1 && blocks(r)[0].level === 1)
r = parseRich(':::table\n| a | b |\n坏行\n:::')
t(4, '非法 table → L2', blocks(r).length === 1 && blocks(r)[0].level === 2)
r = parseRich(':::summary{title="x"}\n内容')
t(5, '未闭合 → 无块', blocks(r).length === 0)
r = parseRich('```\n:::summary\n代码里\n:::\n```')
t(6, '代码块内不解析', blocks(r).length === 0)
r = parseRich(':::points\n- **A** — x\n:::summary\n嵌套\n:::\n:::')
t(7, '嵌套 → L2', blocks(r).length === 1 && blocks(r)[0].level === 2)
r = parseRich('普通段落\n\n第二段')
t(8, '连续行合并为 1 段', r.length === 1 && r[0].kind === 'markdown')

// fuzz 不抛异常
let threw = 0
const seeds = [':::', ':::x', ':::summary{', '```', '> [!NOTE]', '|---', ':::columns\n---\n---', '\n\n']
for (let i = 0; i < 3000; i++) {
  const s = seeds[i % seeds.length] + seeds[(i * 7) % seeds.length]
  try { parseRich(s) } catch { threw++ }
}
t(9, 'fuzz 3000 次不抛异常', threw === 0)

// 流式：闭合前无块，闭合后有块
let acc = ''
const states = []
for (const ch of ':::summary{title="结论"}\n内容\n:::') { acc += ch; states.push(parseRich(acc)) }
t(10, '流式闭合前无块', states.slice(0, -1).every(s => blocks(s).length === 0))
t(11, '流式闭合后为块', blocks(states[states.length - 1]).length === 1 && blocks(states[states.length - 1])[0].level === 0)

// ── 内联副本一致性 ────────────────────────────────────
// lib/client.js 里内联了一份 parser（宿主模块表不支持相对 require）。
// 两份副本必须行为一致，否则改了 src/parser.js 只重建了一半。
console.log('\n── 内联副本一致性 ──')

const clientCode = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// 最小 createElement —— 必须提到模块级，renderShape 在 try 块外也要用
const el = (t2, p, ...c) => {
  const props = { ...(p ?? {}) }
  if (c.length) props.children = c.length === 1 ? c[0] : c
  return { type: t2, props }
}

let inlined = null
try {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { captured = r } } },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(clientCode, sandbox, { filename: 'lib/client.js' })

  // 用假的 seed 表把 factory 跑起来，把内联解析器取出来
  const seed = {
    'react': {
      createElement: el,
      Fragment: 'Fragment',
      // ⚠️ 2026-11-05：插件用 useState 实现推理折叠行
      useState: (initial) => [initial, () => {}],
      // ⚠️ 2026-11-05：插件现在用 class ErrorBoundary 做错误隔离，
      //    需要 React 基类。宿主 react 一定有 Component。
      Component: class {
        constructor(props) {
          this.props = props
          this.state = {}
        }
      },
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
      MarkdownText: (p) => el('MarkdownText', p),
      JsonBlock: (p) => el('JsonBlock', p),
      // ⚠️ 2026-11-05：推理块自己画（不声明 children → 拿不到 renderSlot）
      DisclosureRow: (p) => el('DisclosureRow', p),
      IconThinkOutlineRegular: (p) => el('IconThinkOutlineRegular', p),
    },
  }
  const exports_ = captured.factory((s) => {
    if (seed[s]) return seed[s]
    throw new Error('missed module table: ' + s)
  })

  // 渲染一个含结构块的文本块，从渲染结果反推内联解析器行为
  let reg = null
  exports_.apply({
    slots: {
      inject: (k, cb) => { cb(); return () => {} },
      register: (o, c) => { reg = c; return () => {} },
    },
  })
  inlined = { reg }
} catch (e) {
  inlined = { error: e.message }
}

t(12, '产物可执行并注册渲染器', inlined && !inlined.error && typeof inlined.reg === 'function',
  inlined?.error ?? '')

// 用同一组输入，对比「独立副本」与「内联副本」的解析结果是否一致
// 内联副本无法直接调用，但可以通过渲染出的 DOM 结构反推：
// 有结构块 → 出现卡片 class；无结构块 → 只有 MarkdownText
function renderShape(inline, text) {
  // ⚠️ 注册的是 class 组件（ErrorBoundary），
  //    必须像 React 一样用 createElement 创建元素，不能直接当函数调用。
  const out = el(inline.reg, {
    node: { data: { status: 'settled', blocks: [{ kind: 'text', text }] } },
    groupPart: undefined,
    t: (k) => k,
    renderSlot: () => null,
  })
  const cls = []
  // 组件可能是 class（ErrorBoundary）、函数（RichTextBlock / BlockView / SummaryCard…），
  // 必须像 React 一样把组件执行一次再看它返回的树。
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n.type === 'function') {
      // class 组件：用 new 实例化再取 render()
      if (n.type.prototype && n.type.prototype.render) {
        const inst = new n.type(n.props)
        inst.props = n.props
        inst.state = {}
        walk(inst.render())
        return
      }
      walk(n.type(n.props))
      return
    }
    if (typeof n.type !== 'string') return
    if (n.props?.className) cls.push(String(n.props.className))
    walk(n.props?.children)
  }
  walk(out)
  return cls.join(' ')
}

const cases = [
  ['普通段落', 'hello world', false],
  ['summary', ':::summary{title="t"}\nbody\n:::', true],
  ['table', ':::table\n| a |\n|---|\n| 1 |\n:::', true],
  ['steps', ':::steps\n1. a\n:::', true],
  ['points', ':::points\n- **a** — b\n:::', true],
  ['未闭合', ':::summary{title="t"}\nbody', false],
  ['非法嵌套', ':::points\n- **a**\n:::summary\nx\n:::\n:::', false],
  ['代码块内', '```\n:::summary\nx\n:::\n```', false],
]

if (inlined && !inlined.error) {
  let mismatch = 0
  for (const [name, text, expectCard] of cases) {
    const shape = renderShape(inlined, text)
    const hasCard = /rr-(card|table|steps|points)/.test(shape)
    if (hasCard !== expectCard) mismatch++
  }
  t(13, '内联副本与独立副本解析行为一致', mismatch === 0,
    `${mismatch} 个用例不一致`)
} else {
  t(13, '内联副本与独立副本解析行为一致', false, '产物无法执行')
}

console.log(`\n构建产物验证：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
