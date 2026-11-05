/**
 * 变异测试 —— 验证接缝自检的断言真的能拦住回归
 *
 * 背景：2026-11-05 接缝自检出现两次「假绿」：
 *   1. 正则被注释里的文字误匹配 → 断言对象错了还在报绿
 *   2. getDerivedStateFromError 改名后仍是子串 → 断言全绿
 *
 * 这个脚本把每条关键断言对应的「反向变异」跑一遍，
 * 确认每次变异都能被抓到。**自检脚本自己也需要测试。**
 *
 * 运行：node tests/mutation-test.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureStdout } from './capture-stdout.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'src', 'client.js')
const original = readFileSync(clientPath, 'utf8')

/** 变异清单：每项 = 描述 + 变异函数 */
const MUTATIONS = [
  {
    name: '删掉 labels（← 本次空白故障的直接原因）',
    apply: (s) => s.replace(/\r?\n\s*labels: buildMarkdownLabels\(props\?\.t\),/, ''),
  },
  {
    name: "locale 改成 'conversation'（内建实际是 'chat'）",
    apply: (s) => s.replace("locale: 'chat'", "locale: 'conversation'"),
  },
  {
    name: '删掉 pathImages',
    apply: (s) => s.replace(/\r?\n\s*pathImages: props\?\.pathImages \?\? buildPathImages\(\),/, ''),
  },
  {
    name: '删掉 fileMentions',
    apply: (s) => s.replace(/\r?\n\s*fileMentions: props\?\.fileMentions,/, ''),
  },
  {
    name: 'ErrorBoundary 方法改名（子串陷阱）',
    apply: (s) => s.replace(/getDerivedStateFromError/g, 'getDerivedStateFromErrorDISABLED'),
  },
  {
    name: '删掉 AssistantNodeBoundary 类定义',
    apply: (s) =>
      s.replace(
        /    class AssistantNodeBoundary extends Component \{[\s\S]*?\n    \}\r?\n/,
        '',
      ),
  },
  {
    name: '删掉 TextBlockBoundary 类定义',
    apply: (s) =>
      s.replace(/    class TextBlockBoundary extends Component \{[\s\S]*?\n    \}\r?\n/, ''),
  },
  {
    name: "slot key 改成 'assistant'（匹配不上）",
    apply: (s) => s.replace("key: 'assistant-step'", "key: 'assistant'"),
  },
  {
    name: 'priority 改成 0（抢不到内建）',
    // ⚠️ 用全局替换：源码里 priority 出现多次，
    //    只替换第一处的话断言可能匹配到另一处仍是 -10 的位置 → 假绿。
    apply: (s) => s.replace(/priority:\s*-10/g, 'priority: 0'),
  },
  {
    // ⚠️ 2026-11-05 空白故障的**真正根因**：
    //   子 slot 声明权独占，重复声明 → 注册抛错 → 插件整个不生效 → 正文空白。
    //   这条变异必须被抓住。
    //
    //   锚点说明：源码里 `priority: -10,` 之后紧跟的是注释块，
    //   所以直接在这行后面插入 children —— 位置唯一，不受注释干扰。
    name: '加回 children 声明（会与内建抢 seat）',
    apply: (s) =>
      s.replace(
        /(\r?\n\s*)(priority: -10,)/,
        `$1$2
$1children: {
$1  'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
$1  'conversation.chat.message.images': { kind: 'single', scope: 'session' },
$1},`,
      ),
  },
  {
    name: '推理块改回依赖 props.renderSlot（没有 children 拿不到）',
    apply: (s) =>
      s.replace(
        /function ReasoningDisclosure\(\{ text, running, props \}\) \{/,
        'function ReasoningDisclosure({ text, running, props }) {\n      void props.renderSlot',
      ),
  },
  {
    name: '删掉 ReasoningDisclosure 组件',
    apply: (s) =>
      s.replace(/    function ReasoningDisclosure\([\s\S]*?\r?\n    \}\r?\n/, ''),
  },
  {
    name: '删掉 missingPrimitives 能力探测',
    apply: (s) => s.replace(/const gaps = missingPrimitives\(primitivesModule\)/, 'const gaps = []'),
  },
  {
    name: '去掉 level >= 2 的降级路径',
    apply: (s) => s.replace(/block\.level >= 2/, 'false'),
  },
  {
    // 反向门控：把已移除的自动改写加回来，check-seam 必须报警
    name: '把启发式增强调用加回来（应被纯被动渲染门控抓住）',
    apply: (s) =>
      s.replace(
        "const hasBlock = segments.some((s) => s.kind === 'block')",
        "const hasBlock = segments.some((s) => s.kind === 'block')\n      if (!hasBlock && !streaming) { const e = heuristicSegments(text); if (e) segments = e }",
      ),
  },
  {
    name: 'PointsGroup 改回读 block.items（应被抓住）',
    apply: (s) =>
      s.replace(
        'const items = parsePoints(block.raw)',
        'const items = block.items ?? parsePoints(block.raw)',
      ),
  },
]

function runSeam() {
  // 用 captureStdout：Windows DSH 沙箱禁止管道 stdio，直接 execFileSync 会 EPERM
  const r = captureStdout('node', [join(root, 'tests', 'check-seam.mjs')], { cwd: root, root })
  const out = r.stdout
  const m = out.match(/接缝自检：(\d+) 通过，(\d+) 失败/)
  return {
    pass: Number(m?.[1] ?? 0),
    // 没打印汇总行 → 自检本身崩了，按失败算（基线就红）
    fail: Number(m?.[2] ?? (r.status === 0 ? 0 : 1)),
    crashed: r.status !== 0 || Boolean(r.error),
  }
}

console.log('── 变异测试：每条关键断言都要能抓住对应的破坏 ──\n')

let caught = 0
let missed = 0

// 基线：未变异时必须全绿
const base = runSeam()
console.log(`基线（未变异）：${base.pass} 通过 / ${base.fail} 失败`)
if (base.fail !== 0) {
  console.log('  ⚠️ 基线就不绿，先修好基线再谈变异')
  process.exit(1)
}
console.log()

for (const m of MUTATIONS) {
  const mutated = m.apply(original)
  if (mutated === original) {
    console.log(`  跳过  ${m.name}`)
    console.log('        （变异未生效 —— 可能是源码形态变了，断言也要跟着改）')
    missed++
    continue
  }
  writeFileSync(clientPath, mutated, 'utf8')
  const r = runSeam()
  writeFileSync(clientPath, original, 'utf8')

  if (r.fail > 0) {
    console.log(`  ✅ 抓住  ${m.name}`)
    console.log(`          → ${r.fail} 条断言失败`)
    caught++
  } else {
    console.log(`  ❌ 漏过  ${m.name}`)
    console.log('          → 自检全绿，这条防线形同虚设')
    missed++
  }
}

console.log(`\n变异测试：${caught} 抓住，${missed} 漏过`)
process.exit(missed > 0 ? 1 : 0)
