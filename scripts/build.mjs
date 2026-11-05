/**
 * 构建脚本 —— 把 src/ 编译到 lib/
 *
 * 产物 lib/client.js 必须是**宿主可直接执行的 classic script**：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * 不能用顶层 import —— 宿主用 <script> 标签加载（不是 ES module），
 * 顶层 import 会抛 "Cannot use import statement outside a module"，
 * 而且会把同一批次 combo 脚本里的其他插件一起拖垮。
 *
 * 为什么不引 rollup/esbuild：
 *   - 我们的产物形态很简单：一个 factory 闭包 + 三段 require
 *   - 少一个依赖 = 少一个安装环节（用户环境改动需先征得同意）
 *   - 保持零构建依赖，clone 下来就能跑
 *
 * 本脚本做三件事：
 *   1. 复制 index.js / parser.js（宿主半区与独立可测副本）
 *   2. 复制 client.js（源码已是 module-loader 形态）
 *   3. 把 parser.js 与 CSS 内联进 client.js
 *
 * 用法：node scripts/build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const lib = join(root, 'lib')

if (!existsSync(src)) {
  console.error('找不到 src/ 目录')
  process.exit(1)
}

mkdirSync(lib, { recursive: true })

// 1. 复制宿主半区文件
// 用 copyFileSync 而非 cpSync —— cpSync 在中文路径 + Windows 上有 unlink 兼容问题
for (const file of ['index.js', 'parser.js']) {
  const from = join(src, file)
  if (existsSync(from)) {
    copyFileSync(from, join(lib, file))
    console.log(`  copy  ${file}`)
  }
}

// 2. 客户端半区：client.js 已经是 module-loader 形态，直接复制
const clientSrc = join(src, 'client.js')
if (!existsSync(clientSrc)) {
  console.error('找不到 src/client.js')
  process.exit(1)
}
copyFileSync(clientSrc, join(lib, 'client.js'))
console.log('  copy  client.js')

// 3. 内联协议解析器
//
// 宿主的模块表 require 解析顺序是：seed 表 → 已物化记录 → 启动图 row → 已注册 factory。
// 相对路径 './parser.js' 三者都不命中，会抛「missed the module table」。
// 所以解析器代码必须内联进 factory 闭包。
//
// 内联方式：把 parser.js 里的 `export ` 关键字去掉，其余原样保留。
// 顶层 `export const` / `export function` → 闭包内的普通声明。
const parserSource = readFileSync(join(src, 'parser.js'), 'utf8')
const parserInline = parserSource
  .replace(/^export\s+(const|function|let|var|class)\s/gm, '$1 ')
  .replace(/^export\s*\{[^}]*\}\s*$/gm, '')
  .trim()

if (/^\s*export\s/m.test(parserInline)) {
  console.error('parser.js 仍有未处理的 export 声明，无法内联')
  process.exit(1)
}

// 4. 内联 CSS
const cssPath = join(src, 'rich-response.css')
if (existsSync(cssPath)) {
  const css = readFileSync(cssPath, 'utf8')
  const clientPath = join(lib, 'client.js')
  let client = readFileSync(clientPath, 'utf8')

  // 去掉可能存在的旧内联块（重建时保证幂等）
  client = client.replace(/\/\* __INJECT_CSS__ \*\/[\s\S]*?\/\* __END_CSS__ \*\//g, '')

  const injection = `
/* __INJECT_CSS__ */
const __RR_CSS__ = ${JSON.stringify(css)}
if (typeof document !== 'undefined') {
  const __rr_style_id__ = 'dsh-rich-response-style'
  if (!document.getElementById(__rr_style_id__)) {
    const el = document.createElement('style')
    el.id = __rr_style_id__
    el.textContent = __RR_CSS__
    document.head.appendChild(el)
  }
}
/* __END_CSS__ */
`

  const marker = '/* __INJECT_PARSER__ */'
  if (!client.includes(marker)) {
    console.error(`client.js 缺少 ${marker} 标记`)
    process.exit(1)
  }

  // parser 与 CSS 一起塞进标记处 —— 都在 factory 闭包内，惰性执行
  client = client.replace(marker, `${parserInline}\n${injection}`)

  writeFileSync(clientPath, client, 'utf8')
  console.log('  inject parser + css → lib/client.js')
}

// 5. 自检：产物形态必须符合宿主契约
const built = readFileSync(join(lib, 'client.js'), 'utf8')

// ⚠️ 断言「代码结构」时必须剥注释 —— 注释里引用的反例代码
//   （如 props.renderSlot(...)、locale: 'conversation'）会被子串/正则误匹配，
//   把断言变成永远为真的空断言（2026-11-05 实测踩过）。
const builtCode = built
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const checks = [
  ['是 module-loader 形态', built.includes('window.__ModuleLoader__.load(')],
  ['id 与 package.json 一致', built.includes("id: 'dsh-rich-response'")],
  ['用 factory(require) 取依赖', built.includes('factory: (require) =>')],
  ['require 了 react', built.includes("require('react')")],
  ['require 了 primitives', built.includes("require('@deepseek-ai/dsh-client-ui-primitives')")],
  ['无顶层 import 语句', !/^import\s/m.test(built)],
  ['无顶层 export 语句', !/^export\s/m.test(built)],
  ['内联了解析器', built.includes('function parseRich(')],
  ['内联了 CSS', built.includes('__INJECT_CSS__') && built.includes('__RR_CSS__')],
  ['注册了 assistant-step', built.includes("key: 'assistant-step'")],
  ['带 priority 遮蔽内建', built.includes('priority: -10')],
  // ── 2026-11-05 整片空白故障的根因防线 ──
  // 子 slot 声明权独占：内建 assistant-step 已声明 reasoning.body /
  // message.images，插件再声明 → 注册期抛 already declared → entry 注册失败
  // → 宿主 SlotErrorBoundary 把每个 assistant-step 渲染成空 div → 正文空白。
  ['没有声明 children（不与内建抢 seat）', !/children:\s*\{/.test(builtCode)],
  ['不调用 props.renderSlot（不声明 children 就拿不到它）', !/props\.renderSlot\(/.test(builtCode)],
  // MarkdownText 缺 labels → 渲染代码块抛 TypeError → 正文空白
  ['MarkdownText 传了 labels', /labels:\s*buildMarkdownLabels\(/.test(built)],
  ['实现了 buildMarkdownLabels', built.includes('function buildMarkdownLabels(')],
  ["locale 命名空间是 chat", /locale:\s*'chat'/.test(built)],
  ['有 ErrorBoundary 兜底', (built.match(/getDerivedStateFromError/g) ?? []).length >= 3],
  ['推理块自己渲染（DisclosureRow）', built.includes('function ReasoningDisclosure')],
]

let failed = 0
for (const [name, ok] of checks) {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    console.error(`  FAIL  ${name}`)
    failed++
  }
}

if (failed > 0) {
  console.error(`\n构建自检失败：${failed} 项不通过`)
  process.exit(1)
}

console.log('\n构建完成 → lib/')
