/**
 * 富渲染协议 · 解析器
 *
 * 对应规范：protocol/rich-render-protocol-v1.md §9
 *
 * 设计要点：
 *   1. parseRich 永不抛异常 —— 任何异常降级为纯 markdown
 *   2. 返回 level 字段，由渲染层决定用结构样式还是降级样式
 *   3. 流式友好：调用方对累积文本重复调用 parseRich 即可
 *
 * 本文件是 src/parser-reference.ts 的运行版，逻辑保持一致。
 * 两者差异：TS 版带完整类型标注，本版为纯 JS，便于浏览器直接加载。
 */

export const FENCE = ':::'

export const KNOWN_TYPES = ['summary', 'points', 'table', 'steps', 'columns']

/** 语义块（S 族）→ 语气映射 */
export const SEMANTIC_TONE = {
  NOTE: 'info',
  TIP: 'success',
  WARNING: 'warn',
  IMPORTANT: 'danger',
}

/** 语义块 → 中文标签 */
export const SEMANTIC_LABEL = {
  NOTE: '补充说明',
  TIP: '实用建议',
  WARNING: '注意事项',
  IMPORTANT: '关键结论',
}

/** 块默认属性 */
const DEFAULT_ATTRS = {
  summary: { title: '结论', tone: 'info' },
  points: { cols: '3', tone: 'neutral' },
  table: { title: '', compact: 'false' },
  steps: { title: '', ordered: '', showLine: 'true' },
  columns: {},
}

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

/**
 * 把整段文本切成 markdown 段与结构块段。
 * 永不抛异常。
 *
 * @param {string} text
 * @returns {Array<{kind:'markdown',content:string}|{kind:'block',block:object}>}
 */
export function parseRich(text) {
  try {
    if (!text) return []
    return parseSegments(text)
  } catch (err) {
    // 兜底：任何未预期的异常 → 整段当普通 markdown
    return [{ kind: 'markdown', content: text }]
  }
}

/**
 * 流式辅助：对累积文本解析，返回「已完成的段」和「末尾未完成部分」。
 *
 * 实测行为（协议 §15.3）：
 *   - 闭合前：0 个块 + 1 个 markdown 段（整段当未闭合文本）
 *   - 闭合后：1 个块，level 0
 * 所以渲染层只需：markdown 段照常渲染，遇 level 0 才切卡片。
 *
 * @param {string} text
 * @returns {{segments: Array, trailing: string}}
 */
export function parseRichStreaming(text) {
  try {
    const segments = parseSegments(text)
    if (segments.length > 0) {
      const last = segments[segments.length - 1]
      if (last.kind === 'markdown') {
        return { segments: segments.slice(0, -1), trailing: last.content }
      }
    }
    return { segments, trailing: '' }
  } catch {
    return { segments: [{ kind: 'markdown', content: text }], trailing: '' }
  }
}

// ─────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────

function parseSegments(text) {
  const segments = []
  const lines = text.split('\n')

  let buffer = []
  let i = 0

  const flushBuffer = () => {
    if (buffer.length > 0) {
      segments.push({ kind: 'markdown', content: buffer.join('\n') })
      buffer = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // 代码块内的 ::: 一律不解析（硬规则，优先于一切）
    if (isInsideCodeFence(lines, i)) {
      buffer.push(line)
      i++
      continue
    }

    const open = matchFenceOpen(line)

    if (open) {
      const closeIdx = findClosingFence(lines, i + 1)
      const body = lines.slice(i + 1, closeIdx === -1 ? lines.length : closeIdx)
      const closed = closeIdx !== -1

      flushBuffer()

      if (!closed) {
        // L3：未闭合 —— 按普通 markdown 处理
        segments.push({
          kind: 'markdown',
          content: [line, ...body].join('\n'),
        })
        i = lines.length
        continue
      }

      const block = buildBlock(open, body)
      segments.push({ kind: 'block', block })
      i = closeIdx + 1
      continue
    }

    buffer.push(line)
    i++
  }

  flushBuffer()
  return segments
}

/**
 * 匹配围栏起始行：`:::type{attr="v"}`
 * @returns {{type:string, attrs:Object}|null}
 */
function matchFenceOpen(line) {
  const t = line.trim()
  if (!t.startsWith(FENCE)) return null

  const m = /^([a-zA-Z][\w-]*)\s*(\{.*\})?\s*$/.exec(t.slice(FENCE.length))
  if (!m) return null

  const type = m[1].toLowerCase()
  const attrs = {}

  if (m[2]) {
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g
    let am
    while ((am = attrRe.exec(m[2])) !== null) {
      attrs[am[1]] = am[2]
    }
  }

  return { type, attrs }
}

/** 找闭合围栏，跳过代码块内的行 */
function findClosingFence(lines, from) {
  for (let j = from; j < lines.length; j++) {
    if (isInsideCodeFence(lines, j)) continue
    if (lines[j].trim() === FENCE) return j
  }
  return -1
}

/** 判断第 idx 行是否处于代码块内（``` 或 ~~~） */
function isInsideCodeFence(lines, idx) {
  let open = false
  let marker = ''
  for (let k = 0; k <= idx; k++) {
    const m = /^(`{3,}|~{3,})/.exec(lines[k].trim())
    if (!m) continue
    if (!open) {
      open = true
      marker = m[1][0]
    } else if (m[1][0] === marker) {
      open = false
    }
  }
  return open
}

/**
 * 块内是否嵌套了其他块。
 * 规范 §8.2：最大嵌套深度 = 1，任何块内部不得再出现块。
 * 违反 → 整块按 L2 降级。
 */
function hasNestedBlock(body) {
  for (let i = 0; i < body.length; i++) {
    if (isInsideCodeFence(body, i)) continue
    const m = matchFenceOpen(body[i])
    if (m && KNOWN_TYPES.includes(m.type)) return true
  }
  return false
}

/** 构建块，含结构合法性检查与降级 */
function buildBlock(open, body) {
  const raw = body.join('\n')
  const type = open.type

  // 未知类型 → L2
  if (!KNOWN_TYPES.includes(type)) {
    return { type: 'summary', attrs: {}, raw, level: 2 }
  }

  const attrs = { ...DEFAULT_ATTRS[type], ...open.attrs }

  // 嵌套违规 → L2
  if (hasNestedBlock(body)) {
    return { type, attrs, raw, level: 2 }
  }

  switch (type) {
    case 'summary':
      if (!raw.trim()) return { type, attrs, raw, level: 4 }
      return { type, attrs, raw, level: open.attrs.title === undefined ? 1 : 0 }
    case 'points':
      if (parsePoints(raw).length === 0) return { type, attrs, raw, level: 2 }
      return { type, attrs, raw, level: open.attrs.cols === undefined ? 1 : 0 }
    case 'table':
      if (!isValidTable(raw)) return { type, attrs, raw, level: 2 }
      return { type, attrs, raw, level: open.attrs.title === undefined ? 1 : 0 }
    case 'steps':
      if (parseSteps(raw).length === 0) return { type, attrs, raw, level: 2 }
      return { type, attrs, raw, level: open.attrs.title === undefined ? 1 : 0 }
    case 'columns':
      if (splitColumns(raw).length !== 2) return { type, attrs, raw, level: 2 }
      return { type, attrs, raw, level: 0 }
    default:
      return { type, attrs, raw, level: 2 }
  }
}

// ─────────────────────────────────────────────────────────────
// 块内部结构解析
// ─────────────────────────────────────────────────────────────

/** 解析 points：`- **标题** — 描述` */
export function parsePoints(raw) {
  const items = []
  const re = /^[-*+]\s+(?:\*\*(.+?)\*\*|__(.+?)__)\s*[—–\-:：]?\s*(.*)$/
  for (const line of raw.split('\n')) {
    const m = re.exec(line.trim())
    if (m) {
      items.push({ title: (m[1] ?? m[2] ?? '').trim(), desc: (m[3] ?? '').trim() })
    }
  }
  return items
}

/** 解析 steps：有序或无序列表 */
export function parseSteps(raw) {
  const items = []
  const re = /^(?:\d+[.)]|[-*+])\s+(.*)$/
  for (const line of raw.split('\n')) {
    const m = re.exec(line.trim())
    if (!m) continue
    const text = m[1].trim()
    const sp = /^(?:\*\*(.+?)\*\*|__(.+?)__)\s*[—–\-:：]?\s*(.*)$/.exec(text)
    if (sp) {
      items.push({ title: (sp[1] ?? sp[2] ?? '').trim(), desc: (sp[3] ?? '').trim() })
    } else {
      items.push({ title: text, desc: '' })
    }
  }
  return items
}

/** 表格合法性：必须有分隔行且至少一行数据 */
export function isValidTable(raw) {
  const lines = raw.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return false
  return (
    /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/.test(lines[1]) && lines[1].includes('-')
  )
}

/** 分栏：独占一行的 --- 分隔 */
export function splitColumns(raw) {
  return raw
    .split(/^\s*---\s*$/m)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

// ─────────────────────────────────────────────────────────────
// S 族 · 语义块识别
// ─────────────────────────────────────────────────────────────

/**
 * 从 markdown 段落中识别 GitHub Alerts 引用块。
 * 渲染层用它在普通 markdown 内部做语义着色。
 *
 * 返回项带 `start` / `end`（原文字符区间），渲染层据此把整段 markdown
 * 切成「普通段落 / 语义块」交错渲染。2026-11-05 修复：此前从标记行
 * 结尾直接切剩余文本，开头是换行符，导致正文一行都收不到、
 * 对任何输入恒返回 []（语义色块因此从未生效）。
 */
export function detectSemantic(markdown) {
  const out = []
  if (typeof markdown !== 'string' || markdown.length === 0) return out
  const re = /^>\s*\[!([A-Za-z]+)\]\s*$/gm
  let m

  while ((m = re.exec(markdown)) !== null) {
    const type = m[1].toUpperCase()
    const known = Object.keys(SEMANTIC_TONE)

    // 标记行之后从「下一行」开始收引用正文（跳过 \r?\n）
    let cursor = m.index + m[0].length
    if (markdown[cursor] === '\r') cursor++
    if (markdown[cursor] === '\n') cursor++
    let end = cursor

    const bodyLines = []
    while (cursor < markdown.length) {
      const nl = markdown.indexOf('\n', cursor)
      const lineEnd = nl === -1 ? markdown.length : nl
      const line = markdown.slice(cursor, lineEnd).replace(/\r$/, '')
      if (!/^>\s?/.test(line)) break
      bodyLines.push(line.replace(/^>\s?/, ''))
      end = nl === -1 ? markdown.length : nl + 1
      cursor = nl === -1 ? markdown.length : nl + 1
    }

    const content = bodyLines.join('\n').trim()
    if (!content) continue

    out.push({
      kind: known.includes(type) ? type.toLowerCase() : 'unknown',
      label: known.includes(type) ? SEMANTIC_LABEL[type] : type.charAt(0) + type.slice(1).toLowerCase(),
      content,
      start: m.index,
      end,
    })
  }
  return out
}
