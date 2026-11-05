/**
 * 注册期接缝验证 —— 模拟宿主 slots 的「子 slot 声明权独占」规则
 *
 * 背景：2026-11-05 真实故障 —— 桌面版聊天区**所有**助手回复正文整片空白
 * （连 10 月 31 日的历史会话也空白）。
 *
 * 根因链：
 *   1. 14:25 的 bundle（原提交 ea58b16，仓库重建后已不存在）在 register 的 spec 里
 *      声明了 children
 *      （conversation.chat.reasoning.body / conversation.chat.message.images）。
 *   2. 宿主内建 assistant-step entry 已经声明了这两个子 slot，
 *      而声明权是独占的（web bundle 实测，slots.register）：
 *        if (e.children) for (const f of Object.keys(e.children)) {
 *          const h = this.records.get(f);
 *          if (h?.spec) throw new Error(`slot "${f}" is already declared ...`)
 *        }
 *   3. 于是我们的 entry 在注册期抛错 → 该 slot 没有任何可用渲染器 →
 *      宿主 SlotErrorBoundary 把每个 assistant-step 渲染成空 div → 整片空白。
 *   4. render-e2e 的 register 是「来者不拒」的假实现，抓不到这类注册期崩溃。
 *
 * 本脚本按宿主真实规则实现 slots 注册表，断言两件事：
 *   A. 冻结样本 tests/fixtures/legacy-bundle-with-children.js 在本模拟器下
 *      **注册期抛 already declared** —— 把根因钉死，防止将来有人「好心」把 children 加回来。
 *      样本是死文件，不依赖 git 历史（老写法 `git show ea58b16:lib/client.js`
 *      在仓库重建后永久失败，会让这两条断言静默跳过、套件假绿）。
 *   B. 当前 lib/ 产物**注册成功**，且渲染一条 settled 文本回复有正文。
 *
 * 运行：node tests/register-seam.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// ── 宿主 slots 注册表的忠实模拟 ─────────────────────────────
// 只实现与本插件相关的两条真实行为：
//   1. inject(name, factory)：factory 的返回值（entry）替换该 slot 的渲染器；
//      factory 抛错 → 该 slot 没有渲染器（宿主表现为空白 div）。
//   2. register(spec, view)：子 slot 声明权独占，重复声明即抛。
function makeHostSlots() {
  const records = new Map()
  // 内建 assistant-step entry 已声明的两个子 slot（宿主源码实测）
  const BUILTIN_CHILDREN = [
    'conversation.chat.reasoning.body',
    'conversation.chat.message.images',
  ]
  for (const f of BUILTIN_CHILDREN) {
    records.set(f, {
      spec: { kind: 'single', scope: 'session' },
      owner: 'conversation.chat.node',
      id: '<builtin assistant-step>',
    })
  }

  const state = {
    registered: null,
    registerError: null,
    slotName: null,
    factory: null,
  }

  return {
    state,
    /** 模拟宿主在需要时调用 inject 的 factory，返回 factory 的返回值 */
    drive: () => {
      try {
        return state.factory()
      } catch (err) {
        // 宿主：factory 抛错 → 该 slot 无渲染器 → 正文空白
        state.registerError = err
        return undefined
      }
    },
    api: {
      // 宿主真实行为：inject 只**登记** factory，不立即调用；
      // 并把 factory 的返回值当作 dispose 回调（切换会话时调用，实测）。
      inject: (name, factory) => {
        state.slotName = name
        state.factory = factory
        return () => {}
      },
      register: (spec, view) => {
        if (spec && spec.children) {
          for (const f of Object.keys(spec.children)) {
            const h = records.get(f)
            if (h && h.spec) {
              throw new Error(
                `slot "${f}" is already declared (by an entry in "${h.owner}" (${h.id}))`,
              )
            }
          }
          for (const f of Object.keys(spec.children)) {
            records.set(f, {
              spec: spec.children[f],
              owner: spec.name,
              id: 'dsh-rich-response',
            })
          }
        }
        state.registered = { spec, view }
        // 宿主返回注销句柄 —— 旧代码把它当 factory 返回值交出去，
        // 切换会话时被宿主调用 → 自己注销自己。
        return () => {
          state.registered = null
        }
      },
    },
  }
}

// ── 加载一份 bundle 并跑 apply() ────────────────────────────
const el = (type, props, ...children) => {
  const p = { ...(props ?? {}) }
  if (children.length) p.children = children.length === 1 ? children[0] : children
  return { type, props: p }
}

function fakeMarkdownText(props) {
  const { text = '', labels } = props
  if (/```/.test(text)) {
    // 宿主真实行为：解引用 labels.code.copyLabel
    void labels.code.copyLabel
  }
  return el('MarkdownText', props)
}

const seed = {
  react: {
    createElement: el,
    Fragment: 'Fragment',
    useState: (i) => [i, () => {}],
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
    DisclosureRow: (p) => el('DisclosureRow', p),
    IconThinkOutlineRegular: (p) => el('IconThinkOutlineRegular', p),
  },
}

function loadBundle(code, filename) {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => (captured = r) } },
    console: { ...console, error: () => {} },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename })
  return captured.factory((s) => {
    if (seed[s]) return seed[s]
    throw new Error('missed module table: ' + s)
  })
}

function runRegistration(code, filename) {
  const exports_ = loadBundle(code, filename)
  const host = makeHostSlots()
  exports_.apply({ slots: host.api })
  // 宿主在解析 slot 时调用 factory
  host.state.dispose = host.drive()
  return host
}

// 最小渲染：只验证「注册到的渲染器能产出正文」
function renderText(view, text) {
  const out = []
  const ReactComponent = seed.react.Component
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string') return out.push(node)
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object') return
    const { type, props } = node
    if (typeof type === 'function' && type.prototype instanceof ReactComponent) {
      const inst = new type(props)
      inst.state = {}
      try {
        walk(inst.render())
      } catch {
        inst.state = { failed: true }
        walk(inst.render())
      }
      return
    }
    if (typeof type === 'function') return walk(type(props))
    if (typeof props?.text === 'string') out.push(props.text)
    walk(props?.children)
  }
  walk(
    el(view, {
      node: {
        data: {
          status: 'settled',
          finalNode: { messageId: 'm1' },
          blocks: [{ kind: 'text', text }],
        },
      },
      t: (k) => k,
    }),
  )
  return out.join('')
}

// ── A. 根因钉死：冻结样本必须复现注册期崩溃 ────────────────
// 样本是 tests/fixtures/ 下的死文件，不依赖 git 历史 —— 老写法要 `git show ea58b16`，
// 仓库重建后取不到，两条断言会被静默跳过，套件照样报绿（假绿比没有断言更危险）。
const LEGACY_FIXTURE = join(root, 'tests', 'fixtures', 'legacy-bundle-with-children.js')
console.log('\n── 根因复现：冻结样本（原 ea58b16 的最小等价复现）──')
const legacyCode = readFileSync(LEGACY_FIXTURE, 'utf8')
{
  const host = runRegistration(legacyCode, LEGACY_FIXTURE)
  const st = host.state
  t(
    '样本在注册期抛「already declared」（= 线上空白的根因）',
    st.registerError !== null && /already declared/.test(String(st.registerError?.message)),
    st.registerError ? String(st.registerError.message) : '居然注册成功了',
  )
  t(
    '样本崩溃后 slot 上没有渲染器（→ 宿主渲染空 div → 整片空白）',
    st.registered === null,
  )
}

// ── B. 当前产物：注册成功 + 有正文 ──────────────────────────
console.log('\n── 当前 lib/ 产物 ──')
const host = runRegistration(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), 'lib/client.js')
const cur = host.state
t(
  '当前产物注册期不抛错',
  cur.registerError === null,
  cur.registerError ? String(cur.registerError.message) : '',
)
t('当前产物真的注册上了渲染器', typeof cur.registered?.view === 'function')
t(
  'spec 不声明 children（声明权独占，内建已声明）',
  cur.registered?.spec?.children === undefined,
  JSON.stringify(cur.registered?.spec?.children ?? null),
)

// ── C. 会话切换生命周期（2026-11-05 实测故障）────────────────
// 宿主把 factory 返回值当 dispose 回调，切换会话时调用且不再调用 factory。
console.log('\n── 会话切换生命周期 ──')
t(
  'factory 返回 dispose 回调（函数）',
  typeof cur.dispose === 'function',
  typeof cur.dispose,
)
if (typeof cur.dispose === 'function') cur.dispose()
t(
  '调用 dispose（模拟切换会话）后渲染器仍在',
  typeof cur.registered?.view === 'function',
  '渲染器被注销了 → 切换会话后插件全局失效',
)
let secondThrow = null
try {
  host.drive()
} catch (e) {
  secondThrow = e
}
t(
  'factory 被再次调用时不向外抛',
  secondThrow === null,
  secondThrow ? String(secondThrow.message) : '',
)
t('二次调用后渲染器仍在', typeof cur.registered?.view === 'function')

const html = cur.registered ? renderText(cur.registered.view, '这是结论。\n\n```js\nconst a = 1\n```') : ''
t('注册到的渲染器能产出正文（不空白）', html.includes('这是结论'), html.slice(0, 120))

console.log(`\n注册期接缝验证：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
