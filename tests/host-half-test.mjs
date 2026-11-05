/**
 * 宿主半区（index.js）验证 —— 纯被动渲染，不注入任何提示词
 *
 * 背景：2026-11-05 曾在这里往系统提示词注入「结构化回复协议」，
 *   主动教模型输出 `:::` 围栏。实测被引导出来的卡片干扰正常排版，
 *   用户要求去掉。现在本半区是空实现，插件只在模型自己写出合规
 *   围栏时才渲染卡片。
 *
 * 断言：
 *   1. 宿主给什么 ctx 都不抛错（绝不能连累客户端渲染）
 *   2. 即使宿主提供 systemPrompt.section，也绝不被调用
 *   3. 源码与产物都不含协议围栏文本（没有偷偷注入）
 *   4. 仍导出宿主要求的 name / inject / apply
 *
 * 运行：node tests/host-half-test.mjs
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

// index.js 是 ESM 源码，直接动态 import（不经构建）
const mod = await import(pathToFileURL(join(root, 'src', 'index.js')).href)

t('导出 name / inject / apply', mod.name === 'dsh-rich-response' && Array.isArray(mod.inject) && typeof mod.apply === 'function')

// 1. 各种 ctx 形态都不抛错
let threw = null
try {
  mod.apply({})
  mod.apply(undefined)
  mod.apply(null)
  mod.apply({ systemPrompt: { section: () => { throw new Error('should not be called') } } })
  mod.apply({ systemPrompt: {} })
} catch (e) {
  threw = e
}
t('任意 ctx 都不抛错（连注入点抛错也不受影响）', threw === null, threw ? String(threw.message) : '')

// 2. 宿主提供 section 也绝不调用
const calls = []
mod.apply({
  systemPrompt: {
    section: (...args) => calls.push(args),
  },
})
t('systemPrompt.section 一次都不调用', calls.length === 0, `实际 ${calls.length} 次`)

// 3. 源码 / 产物都不含协议围栏文本
for (const file of ['src/index.js', 'lib/index.js']) {
  const code = readFileSync(join(root, file), 'utf8')
  // 剥掉注释再断言，避免注释里提到 :::summary 造成误判
  const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  t(`${file} 不含协议提示词`, !/:::summary|:::points|systemPrompt/.test(codeOnly))
}

console.log(`\n宿主半区验证：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
