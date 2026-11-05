/**
 * 宿主半区（index.js）验证 —— 保守协议注入
 *
 * 背景：插件客户端半区是纯被动渲染器，只有模型写出合规 `:::` 围栏才渲染卡片。
 * 2026-11-05 18:10 曾把宿主半区的协议注入整个删掉，结果模型根本不知道这套
 * 标记存在，插件等于没装。现在恢复注入，但只注入「什么场景可用/不可用」的
 * 协议，不做任何启发式改写。
 *
 * 断言：
 *   1. 仍导出宿主要求的 name / inject / apply
 *   2. 宿主给什么 ctx 都不抛错（绝不能连累客户端渲染）
 *   3. 有 systemPrompt 服务时注册且只注册一节协议
 *   4. section 参数（name / order / text / interpolate）正确，text 含四类围栏
 *   5. config.enabled === false 时完全不注入
 *   6. section 抛错不外泄
 *   7. ctx.inject(['systemPrompt']) 路径、回调未触发也不抛错
 *   8. order 锚点与兜底
 *   9. 构建产物 lib/index.js 行为与源码一致
 *
 * 运行：node tests/host-half-test.mjs（需先 npm run build）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const srcUrl = pathToFileURL(join(root, 'src', 'index.js')).href
const libUrl = pathToFileURL(join(root, 'lib', 'index.js')).href

const mod = await import(srcUrl)

// 1. 导出面
t(
  '导出 name / inject / apply',
  mod.name === 'dsh-rich-response' && Array.isArray(mod.inject) && typeof mod.apply === 'function'
)

// 2. 各种异常 ctx 都不抛错
let threw = null
try {
  mod.apply({})
  mod.apply(undefined)
  mod.apply(null)
  mod.apply({ systemPrompt: {} })
  mod.apply({ systemPrompt: { section: () => { throw new Error('section boom') } } })
  mod.apply(null, null)
} catch (e) {
  threw = e
}
t('任意 ctx 都不抛错（含 section 自身抛错）', threw === null, threw ? String(threw.message) : '')

// 3. 有服务时注册且只注册一次
const calls = []
mod.apply({
  systemPrompt: {
    section: (section) => {
      calls.push(section)
      return () => {}
    },
  },
})
t('systemPrompt.section 注册一次', calls.length === 1, `实际 ${calls.length} 次`)

const sec = calls[0] ?? {}
t(
  'section 形状正确（name / order / interpolate）',
  sec.name === 'dsh-rich-response:protocol' &&
    Number.isFinite(sec.order) &&
    sec.interpolate === false,
  JSON.stringify(sec)
)

// 4. text 覆盖四类围栏（静态字符串，避免依赖宿主动态文本解析）
let textOk = false
let text = typeof sec.text === 'string' ? sec.text : ''
textOk =
  text.includes(':::summary{') &&
  text.includes(':::points{') &&
  text.includes(':::table{') &&
  text.includes(':::steps{')
t('section.text 含四类围栏', textOk)

t(
  '协议声明默认普通 markdown、同类最多 2 个、不嵌代码块',
  typeof text === 'string' &&
    text.includes('默认') &&
    text.includes('最多 2 个') &&
    text.includes('代码块') &&
    text.includes('[!NOTE]')
)

// 5. enabled:false
const offCalls = []
mod.apply(
  {
    systemPrompt: {
      section: (section) => {
        offCalls.push(section)
      },
    },
  },
  { enabled: false }
)
t('config.enabled === false 时零注入', offCalls.length === 0, `实际 ${offCalls.length} 次`)

// 6. section 抛错不外泄
let threw2 = null
try {
  mod.apply({ systemPrompt: { section: () => { throw new Error('boom') } } })
} catch (e) {
  threw2 = e
}
t('section 抛错不外泄', threw2 === null, threw2 ? String(threw2.message) : '')

// 7. ctx.inject 路径：回调拿到带 systemPrompt 的 scope
const injectCalls = []
let deps = null
mod.apply({
  inject: (d, cb) => {
    deps = d
    cb({
      systemPrompt: {
        section: (section) => injectCalls.push(section),
      },
    })
  },
})
t(
  "走 ctx.inject(['systemPrompt']) 并成功注册",
  Array.isArray(deps) && deps[0] === 'systemPrompt' && injectCalls.length === 1
)

// 回调永远不触发也不能抛错（服务缺失时插件应静默）
let threw3 = null
try {
  mod.apply({ inject: () => {} })
} catch (e) {
  threw3 = e
}
t('inject 回调未触发也不抛错', threw3 === null, threw3 ? String(threw3.message) : '')

// 8. order 锚点与兜底
const anchored = []
mod.apply({
  systemPrompt: {
    getSectionOrder: (name) => (name === 'DEPLOYMENT_PERSONA_SUFFIX' ? 42 : undefined),
    section: (section) => anchored.push(section),
  },
})
t('order 锚定 persona 后缀（42 + 100）', anchored[0]?.order === 142, `order=${anchored[0]?.order}`)

const fallback = []
mod.apply({
  systemPrompt: {
    getSectionOrder: () => {
      throw new Error('unknown section')
    },
    section: (section) => fallback.push(section),
  },
})
t('getSectionOrder 抛错时 order 仍为有限数值', Number.isFinite(fallback[0]?.order), `order=${fallback[0]?.order}`)

// 9. 构建产物行为一致
let lib = null
try {
  lib = await import(libUrl)
} catch (e) {
  fail++
  console.log(`  FAIL 读取构建产物 lib/index.js（先跑 npm run build） ${e.message}`)
}
if (lib) {
  const libCalls = []
  lib.apply({
    systemPrompt: {
      section: (section) => libCalls.push(section),
    },
  })
  t(
    'lib 产物同样注入协议且内容一致',
    libCalls.length === 1 &&
      libCalls[0].name === 'dsh-rich-response:protocol' &&
      typeof libCalls[0].text === 'string' &&
      libCalls[0].text === text
  )
}

// 源码与产物都把协议放在同一处（防止有人只改 src 忘了构建）
for (const file of ['src/index.js', 'lib/index.js']) {
  const code = readFileSync(join(root, file), 'utf8')
  t(`${file} 含协议常量`, code.includes(':::summary{') && code.includes('dsh-rich-response:protocol'))
}

console.log(`\n宿主半区验证：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
