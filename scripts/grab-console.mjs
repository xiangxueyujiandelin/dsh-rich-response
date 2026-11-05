/**
 * 抓 DSH web 版的真实 console 报错
 *
 * 目的：定位「回复区整片空白」的真实原因 ——
 * 宿主的 SlotErrorBoundary 会把渲染异常变成空 div，
 * 只有 console 里那句 "slot entry crashed in ..." 才能指出真正的堆栈。
 *
 * 用法：node grab-console.mjs <url>
 */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:8791/'

const browser = await chromium.launch({
  // 用系统已装的 Edge/Chrome，不下载 Playwright 自带浏览器
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'msedge',
})
const page = await browser.newPage()

const logs = []
page.on('console', (msg) => {
  logs.push({
    type: msg.type(),
    text: msg.text(),
  })
})
page.on('pageerror', (err) => {
  logs.push({ type: 'pageerror', text: err.message + '\n' + (err.stack ?? '') })
})
page.on('requestfailed', (req) => {
  logs.push({
    type: 'requestfailed',
    text: `${req.method()} ${req.url()} — ${req.failure()?.errorText}`,
  })
})

console.log(`打开 ${url} ...`)
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
} catch (e) {
  console.log('导航出错:', e.message)
}

await page.waitForTimeout(6000)

// 报告
console.log('\n═══════ console 输出 ═══════')
for (const l of logs) {
  const mark = l.type === 'error' || l.type === 'pageerror' ? '❌' : l.type === 'warning' ? '⚠️ ' : '·  '
  console.log(`${mark} [${l.type}] ${l.text.slice(0, 600)}`)
}

// 关键：找 slot crash
const crashes = logs.filter((l) => /slot entry crashed|slot factory|dsh-rich-response|data-slot-error/i.test(l.text))
console.log('\n═══════ 关键线索（slot crash / 本插件）══════')
if (crashes.length === 0) {
  console.log('（没有找到 slot crash 记录）')
} else {
  for (const c of crashes) console.log(`[${c.type}] ${c.text.slice(0, 1500)}`)
}

// DOM 检查
const dom = await page.evaluate(() => {
  const errs = [...document.querySelectorAll('[data-slot-error]')].map((e) => ({
    slot: e.getAttribute('data-slot-error'),
    tag: e.tagName,
    html: e.innerHTML.slice(0, 200),
  }))
  return {
    slotErrors: errs,
    hasRichRoot: document.querySelectorAll('.rr-root').length,
    hasMarkdown: document.querySelectorAll('.markdown, [class*=markdown]').length,
    bodyLen: document.body.innerText.length,
  }
})
console.log('\n═══════ DOM 状态 ═══════')
console.log(JSON.stringify(dom, null, 2))

await browser.close()
