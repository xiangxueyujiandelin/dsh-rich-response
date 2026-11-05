/**
 * 接缝自检 —— 校验 client.js 用到的宿主 API 与源码实证一致
 *
 * 背景：2026-11-05 首次实现时，我把宿主接口猜错了三处
 *（key 写成 'assistant'、用编造的全局变量拿 MarkdownText、
 *   把 node.data 当字符串而非 blocks 数组），
 * 导致插件装上也不会生效。
 *
 * 同日又栽了一次：宿主用 <script> 加载插件 bundle（classic script），
 * 顶层 import 直接抛 "Cannot use import statement outside a module"，
 * 还把同批次 combo 脚本里的其他插件一起拖垮。
 *
 * 这个脚本把「已实证的宿主契约」固化成断言，
 * 以后改 client.js 时一旦跑偏立刻能发现。
 *
 * 运行：node tests/check-seam.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(root, 'src', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 剥掉注释后的纯代码。
 *
 * ⚠️ 2026-11-05 实测踩坑：断言正则直接匹配全文时，
 *    会被**注释里提到的代码片段**误匹配（注释里写了
 *    `createElement(MarkdownText, {...})`，结果断言匹配到的是注释本身）。
 *    所以所有针对「代码结构」的断言都基于这份剥离后的文本。
 */
const clientCode = client
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

let pass = 0
let fail = 0

function t(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('── 加载格式契约（宿主用 <script> 加载，不是 ES module）──')

// 崩溃根因：顶层 import → "Cannot use import statement outside a module"
t(
  '产物无顶层 import 语句',
  !/^\s*import\s/m.test(client),
  '宿主以 classic script 加载，顶层 import 会语法报错',
)
t(
  '产物无顶层 export 语句',
  !/^\s*export\s/m.test(client),
  'classic script 里 export 也是语法错误',
)
t(
  '是 module-loader 形态',
  /window\.__ModuleLoader__\.load\(\{/.test(client),
)
t(
  '注册 id 与 package.json 的 name 一致',
  new RegExp(`id: '${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(client),
  `id 必须等于包名 ${pkg.name}`,
)
t(
  'factory 接收宿主注入的 require',
  /factory:\s*\(require\)\s*=>/.test(client),
  '宿主模块表通过 factory(require) 传依赖',
)

// 依赖只能从宿主 seed 表解析：react / primitives 在 PLATFORM_MODULES 里
t(
  "用 require('react') 取 React",
  /require\('react'\)/.test(client),
)
t(
  "用 require('@deepseek-ai/dsh-client-ui-primitives') 取 primitives",
  /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.test(client),
)
t(
  '没有相对路径 require（宿主模块表不支持）',
  !/require\(\s*['"]\.\//.test(client),
  "相对路径会抛「missed the module table」",
)
t(
  '解析器已内联（不依赖相对 require）',
  client.includes('/* __INJECT_PARSER__ */'),
  '构建脚本会把 parser.js 内联进 factory',
)

console.log('\n── client half 导出契约（对照 dshmarket / ui-chat / dsh-markstream）──')

t(
  '导出了 name',
  /name:\s*'dsh-rich-response'/.test(client),
)
t(
  '导出了 inject（服务声明）',
  /inject:\s*\[\s*'slots'\s*\]/.test(client),
  '需要 ctx.slots 才能注册渲染器',
)
t(
  '导出了 apply',
  /apply,/.test(client) && /function apply\(ctx\)/.test(client),
)

console.log('\n── slot 注册契约（来源 register-node-renderers.ts）──')

// key 必须是 'assistant-step'，写错则 slot 匹配不上
t(
  "slot key 是 'assistant-step'",
  /key:\s*'assistant-step'/.test(client),
  "找到的是别的 key",
)
t(
  "没有残留错误的 key 'assistant'",
  !/key:\s*'assistant'/.test(client),
  '应为 assistant-step',
)

// 必须用 priority 遮蔽内置（内置为 0）
// ⚠️ 2026-11-05 修正：原断言只匹配 /priority:\s*-10/ 的**字面量**，
//    改成 priority: 0 也照样通过 —— 变异测试抓到了这个漏网。
//    现在改为解析出所有实际数值并断言**每一个**都小于 0
//    （只查第一个也会漏：源码里 priority 出现多次时可能匹配到另一处）。
const priorityValues = [...clientCode.matchAll(/priority:\s*(-?\d+)/g)].map((m) =>
  Number(m[1]),
)
t(
  '设置了负 priority 遮蔽内置渲染器',
  priorityValues.length > 0 && priorityValues.every((v) => v < 0),
  `内置渲染器未指定 priority（默认 0），需负值才能排在前面；实际：${JSON.stringify(priorityValues)}`,
)

// slot name 必须完全一致
t(
  "slot name 是 'conversation.chat.node'",
  /name:\s*'conversation\.chat\.node'/.test(client),
)

// 必须通过 ctx.slots.inject 包裹注册
t(
  '用 ctx.slots.inject 包裹注册',
  /ctx\.slots\.inject\(\s*'conversation\.chat\.node'/.test(client),
)

// ⚠️⚠️ 2026-11-05 空白故障的**真正根因**（最高优先级，别删）
//   宿主 slots 源码（web bundle，register 方法）：
//     if (e.children) for (const f of Object.keys(e.children)) {
//       const h = this.records.get(f);
//       if (h?.spec) throw new Error(`slot "${f}" is already declared ...`)
//     }
//   → 子 slot 的**声明权是独占的**。
//   内建 assistant-step entry 已经声明了 reasoning.body 与 message.images，
//   我们再声明 → 注册时抛错 → 整个插件注册失败 → 渲染器从未接管 →
//   **助手回复正文整片空白**。
//
//   社区插件 dsh-markstream 的做法：不声明 children，推理块自己画。
t(
  '没有声明 children（不与内建抢子 slot 声明权）',
  !/children:\s*\{/.test(clientCode),
  '重复声明 reasoning.body / message.images 会让注册抛错 → 插件完全不生效',
)
t(
  '没有残留 reasoning.body 的子 slot 声明',
  !/'conversation\.chat\.reasoning\.body':\s*\{/.test(clientCode),
  '该子 slot 的声明权属于内建 assistant-step entry',
)
t(
  '没有残留 message.images 的子 slot 声明',
  !/'conversation\.chat\.message\.images':\s*\{/.test(clientCode),
  '该子 slot 的声明权属于内建 assistant-step entry',
)
// 不声明 children ⇒ 拿不到 renderSlot ⇒ 推理/图片必须自己渲染
t(
  '推理块自己渲染（用 DisclosureRow），不依赖 renderSlot',
  /DisclosureRow/.test(client) && /function ReasoningDisclosure/.test(client),
  '没有 children 就没有 renderSlot，推理块必须自己画',
)
t(
  '推理块不调用 props.renderSlot',
  !/props\.renderSlot/.test(clientCode),
  'renderSlot 只在 entry.children 存在时注入，我们没有 children',
)
t(
  '图片块有降级渲染（不依赖 renderSlot）',
  /function RichImageBlock/.test(client),
)
// ⚠️ 2026-11-05：「装了但看不出效果」排查教训 —— 放弃接管的分支若不留日志，
//   运行时从外部完全不可见。三条分支都必须有声。
t(
  'ctx.slots 缺失分支有日志（不静默放弃）',
  /ctx\.slots 缺失/.test(client),
)
t(
  '注册 factory 抛错分支有日志',
  /slot 注册抛错/.test(client),
)
t(
  '注册成功有正向信标日志',
  /渲染器已注册/.test(client),
)
// ⚠️ 2026-11-05 实测：宿主把 inject factory 的返回值当 dispose 回调，
//   切换会话时调用。返回 register 的注销句柄 = 切换时自我注销 → 全局失效。
t(
  'inject factory 返回 noop dispose（不自我注销）',
  /return \(\) => \{\}/.test(clientCode),
  '返回 register 句柄会在切换会话时被宿主调用 → 插件全局失效',
)
// ⚠️ 2026-11-05 DevTools 实测：宿主 MarkdownText 执行 fileMentions?.resolve(...)
t(
  'inject 的 fileMentions 带 resolve 方法（鸭型兼容）',
  /fileMentions\.resolve\s*=/.test(clientCode),
  '裸函数会让宿主抛 TypeError → slot entry crashed',
)
t(
  'required primitives 含 DisclosureRow 与 IconThinkOutlineRegular',
  /REQUIRED_PRIMITIVES[\s\S]{0,400}DisclosureRow/.test(client) &&
    /REQUIRED_PRIMITIVES[\s\S]{0,400}IconThinkOutlineRegular/.test(client),
  '缺了这两个就画不出推理折叠行',
)

// locale 命名空间必须与内建**逐字一致**
// ⚠️ 2026-11-05 实测修正：原先这里断言 'conversation'，那是错的 ——
//   宿主内建用的是 NS = "chat"（dsh-client-ui-chat 注册的字典在 'chat' 命名空间）。
//   写错不崩（locale face.bind 对未知命名空间只回退到返回 key 本身），
//   但所有 UI 文案会变成裸 key。
t(
  "声明了 locale 命名空间 'chat'（与内建 NS 一致）",
  /locale:\s*'chat'/.test(clientCode),
  "宿主内建 const NS = 'chat'；写成 'conversation' 会让 t() 返回裸 key",
)
t(
  "没有残留错误的 locale 命名空间 'conversation'",
  !/locale:\s*'conversation'/.test(clientCode),
  "应为 'chat'",
)

console.log('\n── 数据结构契约（来源 contract/chat-nodes.ts）──')

// 必须读 node.data.blocks 数组
t(
  '读取 node.data.blocks（数组）',
  /data\.blocks/.test(client) && /Array\.isArray\(\s*data\.blocks\s*\)/.test(client),
  '必须先判数组再遍历',
)

// status 三态
t(
  "识别 status 的 running / settled / interrupted",
  /'running'/.test(client) && /'settled'/.test(client) && /'interrupted'/.test(client),
)

// groupPart 分流
t(
  "处理 groupPart === 'reasoning' / 'response'",
  /groupPart\s*===\s*'reasoning'/.test(client) && /groupPart\s*===\s*'response'/.test(client),
  '缺分流会导致推理内容与回复内容重复显示',
)

// blocks 的四种 kind
for (const kind of ['text', 'reasoning', 'image', 'tool-call']) {
  t(`处理 block.kind === '${kind}'`, client.includes(`'${kind}'`))
}

console.log('\n── MarkdownText 契约（来源 AssistantMarkdown.tsx）──')

// 必须从宿主包取 primitives，不能用编造的全局变量
t(
  "从 '@deepseek-ai/dsh-client-ui-primitives' 取 primitives",
  /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.test(client),
  'MarkdownText 是真实导出，必须从宿主模块表取',
)
t(
  '没有编造的全局变量 __DSH_PRIMITIVES__',
  !client.includes('__DSH_PRIMITIVES__'),
  '宿主没有这个全局变量',
)

// prop 名是 text 不是 content
// ⚠️ 2026-11-05 修正：原正则 `createElement\(\s*MarkdownText\s*,\s*\{[\s\S]*?\n\s*\}`
//    会被**注释里的文字**误匹配（注释中提到了 createElement(MarkdownText, {...})），
//    导致断言结果不可信 —— 自检脚本自己也得有测试。
//    现在基于上面剥离注释后的 clientCode 匹配真实代码。
const mdCall = clientCode.match(
  /createElement\(\s*MarkdownText\s*,\s*\{[\s\S]*?\r?\n\s*\}\)/,
)
t(
  'MarkdownText 用 text 传参',
  mdCall !== null && /\btext\b/.test(mdCall[0]),
  'prop 名是 text，不是 content',
)
t(
  '没有把 MarkdownText 的 text prop 写成 content',
  mdCall !== null && !/\bcontent\b/.test(mdCall[0]),
)

// ⚠️⚠️ 2026-11-05 空白故障的根因断言（最高优先级，别删）
//   宿主 MarkdownText 的真实签名（web bundle 实证）：
//     memo(function({text, streaming, labels, fileMentions, pathImages, ...}))
//   渲染代码块时执行 `r.labels.code.copyLabel`，labels 为 undefined 直接抛
//   TypeError → 被宿主 SlotErrorBoundary 捕获 → 渲染空 div → **正文整片空白**。
t(
  'MarkdownText 传了 labels（缺了会崩掉整条回复）',
  mdCall !== null && /\blabels\s*:/.test(mdCall[0]),
  '缺 labels → r.labels.code.copyLabel 抛 TypeError → 正文空白',
)
t(
  '实现了 buildMarkdownLabels（构造 labels 的地方）',
  /function buildMarkdownLabels\(/.test(client),
)
t(
  'labels 构造有兜底，绝不会返回 undefined',
  /function buildMarkdownLabels\([\s\S]*?return\s*\{[\s\S]*?code:\s*\{/.test(client),
  'labels 必须恒为对象，不能是 undefined',
)
t(
  'MarkdownText 传了 pathImages（图片渲染需要）',
  mdCall !== null && /\bpathImages\s*:/.test(mdCall[0]),
)
t(
  'MarkdownText 传了 fileMentions（@路径 提及需要）',
  mdCall !== null && /\bfileMentions\s*:/.test(mdCall[0]),
)

// ── 纯被动渲染门控（2026-11-05：按用户要求去掉自动改写）────────
// 插件只允许渲染模型明确输出的 ::: 协议块，不得：
//   - 对普通 markdown 做启发式识别（历史记录 / 列表 / 表格自动变卡片）
//   - 从 block.items 读预抽取条目（那是启发式才有的数据源）
// 否则会回归成「正常回答被硬塞进三列白卡片、行内代码反引号外露」。
t(
  '渲染层不调用 heuristicSegments（不做自动改写）',
  !/heuristicSegments\s*\(/.test(clientCode),
  '启发式增强已移除，不允许把普通列表 / 表格自动转成卡片',
)
t(
  '渲染层没有「无块时二次增强」分支',
  !/if\s*\(\s*!hasBlock\s*&&\s*!streaming\s*\)/.test(clientCode),
)
t('PointsGroup / StepsFlow 不读 block.items', !/block\.items/.test(clientCode))

// ── 卡片正文的 markdown 与语义块接通（2026-11-05）─────────────
// 曾有两个真问题：
//   1. 卡片正文直接塞 block.raw 纯文本 → **加粗** / `行内代码` 原样外露
//   2. parser 导出了 detectSemantic 却没人调用 → GitHub Alerts 永远不生效
t(
  '卡片正文经 renderBody 走宿主 MarkdownText（不直接塞纯文本）',
  /function renderBody\(/.test(clientCode) &&
    /className: 'rr-card-body rr-md' \}, renderBody\(/.test(clientCode),
  'SummaryCard 正文必须交给宿主渲染，否则行内 markdown 全部外露',
)
t(
  '行内标记自己渲染（renderInline + rr-inline-code）',
  /function renderInline\(/.test(clientCode) && /rr-inline-code/.test(clientCode),
  '标题 / 要点 / 表格单元里的加粗与行内代码不能当纯文本显示',
)
t(
  'renderInline 用到标题与要点上（不是写了没用）',
  /renderInline\(block\.attrs\.title/.test(clientCode) &&
    /renderInline\(it\.title\)/.test(clientCode),
)
t(
  'MarkdownWithAlerts 真的调用 detectSemantic（语义块不是死代码）',
  /function MarkdownWithAlerts[\s\S]{0,600}?detectSemantic\s*\(/.test(clientCode),
  'parser 识别了 > [!NOTE]，渲染层不调用就等于永不生效',
)
t(
  '语义块有 tone 映射（note/tip/warning/important）',
  /SEMANTIC_CARD_TONE\s*=\s*\{[\s\S]{0,200}?note:\s*'info'[\s\S]{0,120}?warning:\s*'warn'/.test(
    clientCode,
  ),
)
t(
  '未知语义类型降级为 NOTE 样式并告警',
  /unknown:\s*'info'/.test(clientCode) && /console\.warn\(/.test(clientCode),
  '协议只认 NOTE/TIP/WARNING/IMPORTANT，未知类型不能崩',
)

// ── 错误隔离防线 ──────────────────────────────────────────────
// 宿主在 slot 外套 SlotErrorBoundary，渲染器抛错 → 渲染空 div → 正文空白。
// 必须有自己的 ErrorBoundary 兜住，并降级到宿主原生渲染。
//
// ⚠️ 2026-11-05 修正：这组断言最初写成「统计 getDerivedStateFromError 出现次数」，
//    结果把方法名改个名就全绿 —— 典型的假通过。
//    现在改为锚定**真实的 class 定义**（class X extends Component + 该方法），
//    改名或删类都会被抓到。
const boundaryClasses = [
  'TextBlockBoundary',
  'BlockViewBoundary',
  'AssistantNodeBoundary',
]
for (const cls of boundaryClasses) {
  // ⚠️ 必须带词边界：`getDerivedStateFromError` 若改名成
  //    `getDerivedStateFromErrorDISABLED` 仍是它的子串，
  //    不加边界就会假绿（2026-11-05 实测踩到）。
  const re = new RegExp(
    `class\\s+${cls}\\s+extends\\s+Component[\\s\\S]{0,600}?getDerivedStateFromError\\s*\\(`,
  )
  t(
    `${cls} 是真正的 ErrorBoundary（class extends Component + getDerivedStateFromError）`,
    re.test(clientCode),
    '没有 getDerivedStateFromError 就拦不住子组件渲染错误',
  )
}
t(
  'ErrorBoundary 数量 >= 3（块级 / 结构块 / 整节点）',
  boundaryClasses.filter((c) =>
    new RegExp(`class\\s+${c}\\s+extends\\s+Component`).test(clientCode),
  ).length >= 3,
)
t(
  'ErrorBoundary 降级到宿主原生渲染（renderHostText）',
  /renderHostText/.test(client),
)
t(
  '注册的是最外层边界（AssistantNodeBoundary）',
  /AssistantNodeBoundary,/.test(clientCode),
  '注册点必须指向带边界的组件',
)

// package.json 必须声明 inject 依赖
const injectDeps = pkg.dsh?.client?.inject ?? []
t(
  'package.json 的 dsh.client.inject 声明了 ui-theme',
  injectDeps.includes('@deepseek-ai/dsh-client-ui-theme'),
  `当前 inject: ${JSON.stringify(injectDeps)}`,
)
t(
  'inject 里没有多声明 ui-primitives',
  !injectDeps.includes('@deepseek-ai/dsh-client-ui-primitives'),
  'primitives 在宿主 PLATFORM_MODULES baseline 里，不需要声明 inject',
)
t(
  'peerDependencies 声明了 ui-theme',
  Object.keys(pkg.peerDependencies ?? {}).includes('@deepseek-ai/dsh-client-ui-theme'),
)

// 宿主产物规范（来源 packages/client/modules/README.md）
t(
  "exports['./client'] 指向 lib/client.js",
  pkg.exports?.['./client'] === './lib/client.js',
  `实际: ${pkg.exports?.['./client']}`,
)
t(
  'exports["./client"] 指向的文件确实存在',
  existsSync(join(root, 'lib', 'client.js')),
)
t(
  'exports 暴露了 package.json',
  !!pkg.exports?.['./package.json'],
)

console.log('\n── 宿主兼容性防御（来源 dshmarket 源码注释）──')

t(
  '实现了 missingPrimitives 能力探测',
  /function missingPrimitives\(/.test(client),
)
t(
  'apply() 里做了能力探测并在缺失时放弃接管',
  /missingPrimitives\(primitivesModule\)/.test(client) && /return\s*\n\s*\}/.test(client),
  '宿主版本过老时不能白屏',
)

console.log('\n── 协议契约（见 protocol/rich-render-protocol-v1.md）──')

// 降级路径：level >= 2 必须退回 markdown
t(
  'level >= 2 走降级路径',
  /block\.level\s*>=\s*2/.test(client),
  '协议 §7 要求结构非法时静默降级',
)

// 无结构块时走宿主原生路径
t(
  '无结构块时直接用宿主 MarkdownText',
  /hasBlock/.test(client) && /renderHostText\(text,\s*streaming/.test(client),
  '零开销路径，行为与未装插件一致',
)

// 不得把错误提示显示给用户
// ⚠️ 2026-11-05 修正：原断言用 /渲染失败/ 匹配全文，
//    结果把 console.error 的**开发者日志文案**也当成「给用户看错误提示」而误报。
//    协议 §7.1 的本意是：降级路径不能把错误横幅渲染到 UI 上。
//    现在改成检查真实代码（剥注释）里没有把错误文案塞进 createElement 的文本/children。
const uiErrorRender =
  /createElement\([^)]*,\s*\{[^}]*\}\s*,\s*['"`][^'"`]*(失败|错误|异常|Error)/.test(
    clientCode,
  ) ||
  /(children|label|title)\s*:\s*['"`][^'"`]*(渲染失败|解析失败|出错了|Error:)/.test(
    clientCode,
  )
t(
  '没有把错误提示渲染到界面上',
  !uiErrorRender,
  '协议 §7.1：L2/L3 降级时不允许给用户看错误提示',
)
// 降级日志走 console.error（开发者可见），这是允许且必要的
t(
  '降级路径有 console.error 记录（便于排查）',
  /console\.error/.test(client),
)

console.log('\n── 构建产物一致性 ──')

const built = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
t(
  '产物是 module-loader 形态',
  built.includes('window.__ModuleLoader__.load('),
)
t(
  '产物无顶层 import 语句',
  !/^\s*import\s/m.test(built),
  '宿主 classic script，顶层 import 会崩',
)
t(
  '产物保留了宿主包 require',
  built.includes("require('@deepseek-ai/dsh-client-ui-primitives')"),
  '构建脚本不应替换宿主 require',
)
t(
  '产物含 CSS 注入块',
  built.includes('__INJECT_CSS__') && built.includes('__RR_CSS__'),
)
t(
  '产物不含编造的全局变量',
  !built.includes('__DSH_PRIMITIVES__'),
)

// 关键回归防线：产物必须在 classic script 语义下能执行
// （vm.runInContext 对 import 语句会抛 SyntaxError，与宿主行为一致）
let execOk = true
let execErr = ''
try {
  const sandbox = {
    window: { __ModuleLoader__: { load: () => {} } },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(built, sandbox, { filename: 'lib/client.js' })
} catch (e) {
  execOk = false
  execErr = e.message
}
t(
  '产物在 classic script 语义下可执行（崩溃回归防线）',
  execOk,
  execErr,
)

console.log('\n── cordis.patch.yml 格式契约（宿主 loader 强校验）──')

const patchRaw = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

// 宿主报错原文：
//   "must be a top-level YAML array of loader patch entries"
// 顶层写成 map（insert: 直接挂在根）会被拒绝 —— 插件整个不加载。
// 正确形态：顶层是数组，每项是 { insert: [...] }
t(
  'patch.yml 顶层是数组（不是 map）',
  /^\s*-\s/m.test(patchRaw) && !/^insert\s*:/m.test(patchRaw),
  '顶层必须以 "- " 开头；不能直接写 insert:',
)
t(
  'patch.yml 含 insert 动作',
  /^\s*-\s+insert\s*:/m.test(patchRaw),
  '每个顶层数组元素应为一个 insert 动作',
)

// 用 js-yaml 真解析一遍，确认结构（不依赖正则的猜测）
let patchDoc = null
let patchErr = ''
try {
  // 优先用宿主 profile 里已装插件自带的 js-yaml；找不到就不做结构断言
  const yamlPath = [
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop',
      'node_modules', 'dshmarket', 'node_modules', 'js-yaml'),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop',
      'node_modules', 'js-yaml'),
  ].find((p) => existsSync(p))
  if (yamlPath) {
    // 用 createRequire 同步加载，绕开 ESM 对 Windows 绝对路径/Directory import 的限制
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const yaml = req(yamlPath)
    patchDoc = yaml.load(patchRaw)
  } else {
    patchErr = 'js-yaml 不可用，跳过结构解析'
  }
} catch (e) {
  patchErr = e.message
}

if (patchDoc) {
  t(
    'patch.yml 解析结果是数组',
    Array.isArray(patchDoc),
    `实际类型：${typeof patchDoc}（${JSON.stringify(patchDoc)?.slice(0, 80)}）`,
  )
  const entries = Array.isArray(patchDoc)
    ? patchDoc.flatMap((d) => (Array.isArray(d?.insert) ? d.insert : []))
    : []
  t(
    'insert 动作里至少有一条目',
    entries.length > 0,
    `解析出 ${entries.length} 条`,
  )
  t(
    '条目 id 是 dsh-rich-response',
    entries.some((e) => e?.id === 'dsh-rich-response'),
    `ids: ${entries.map((e) => e.id).join(', ')}`,
  )
  t(
    "条目 name 与 package.json 的 name 一致",
    entries.some((e) => e?.name === pkg.name),
    `package.json name=${pkg.name}，patch name=${entries.map((e) => e.name).join(', ')}`,
  )
} else if (patchErr) {
  console.log(`  --   跳过 patch.yml 结构解析：${patchErr}`)
}

// package.json 必须声明 bundle.patch 指向该文件
t(
  'package.json 的 dsh.bundle.patch 指向 cordis.patch.yml',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  `实际：${pkg.dsh?.bundle?.patch}`,
)

console.log(`\n接缝自检：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
