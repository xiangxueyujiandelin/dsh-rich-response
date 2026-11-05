/**
 * 富渲染协议 · 解析器参考实现（TypeScript）
 *
 * 对应规范：protocol/rich-render-protocol-v1.md §9 渲染层 API 契约
 *
 * 设计要点：
 * 1. parseRich 永不抛异常 —— 任何异常降级为纯 markdown
 * 2. 返回 level 字段，由渲染层决定用结构样式还是降级样式
 * 3. 流式友好：调用方对累积文本重复调用 parseRich 即可
 *
 * 本文件可直接作为 DSH 插件与安卓端共用的核心模块。
 */

export type Tone = 'info' | 'success' | 'warn' | 'danger' | 'neutral'

export type BlockType = 'summary' | 'points' | 'table' | 'steps' | 'columns'

/** 降级层级：0 完整 / 1 默认值补齐 / 2 结构非法退普通 markdown / 3 未闭合 / 4 纯文本 */
export type Level = 0 | 1 | 2 | 3 | 4

export interface Block {
  type: BlockType
  attrs: Record<string, string>
  raw: string
  level: Level
}

export interface MarkdownSegment {
  kind: 'markdown'
  content: string
}

export interface BlockSegment {
  kind: 'block'
  block: Block
}

export type Segment = MarkdownSegment | BlockSegment

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const FENCE = ':::'
const KNOWN_TYPES: BlockType[] = ['summary', 'points', 'table', 'steps', 'columns']

/** 语义块（S 族）→ 语气映射 */
export const SEMANTIC_TONE: Record<string, Tone> = {
  NOTE: 'info',
  TIP: 'success',
  WARNING: 'warn',
  IMPORTANT: 'danger',
}

/** 块默认属性 */
const DEFAULT_ATTRS: Record<BlockType, Record<string, string>> = {
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
 */
export function parseRich(text: string): Segment[] {
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
 * 调用方只需对累积文本反复调用，替换上次结果。
 */
export function parseRichStreaming(text: string): {
  segments: Segment[]
  trailing: string
} {
  try {
    const segments = parseSegments(text)
    // 最后一个 markdown 段视为可能未完成（流式场景）
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

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = []
  const lines = text.split('\n')

  let buffer: string[] = []
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
      // 找闭合围栏
      const closeIdx = findClosingFence(lines, i + 1)
      const body = lines.slice(i + 1, closeIdx === -1 ? lines.length : closeIdx)
      const closed = closeIdx !== -1

      flushBuffer()

      if (!closed) {
        // L3：未闭合 —— 按普通 markdown 处理（引用块样式由渲染层决定）
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

interface FenceOpen {
  type: string
  attrs: Record<string, string>
}

/** 匹配围栏起始行：`:::type{attr="v"}` */
function matchFenceOpen(line: string): FenceOpen | null {
  const t = line.trim()
  if (!t.startsWith(FENCE)) return null

  const rest = t.slice(FENCE.length)
  // 必须是 type{...} 或纯 type
  const m = /^([a-zA-Z][\w-]*)\s*(\{.*\})?\s*$/.exec(rest)
  if (!m) return null

  const type = m[1].toLowerCase()
  const attrs: Record<string, string> = {}

  if (m[2]) {
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(m[2])) !== null) {
      attrs[am[1]] = am[2]
    }
  }

  return { type, attrs }
}

/** 找闭合围栏，跳过代码块内的行 */
function findClosingFence(lines: string[], from: number): number {
  for (let j = from; j < lines.length; j++) {
    if (isInsideCodeFence(lines, j)) continue
    if (lines[j].trim() === FENCE) return j
  }
  return -1
}

/** 判断第 idx 行是否处于代码块内（``` 或 ~~~） */
function isInsideCodeFence(lines: string[], idx: number): boolean {
  let open = false
  let marker = ''
  for (let k = 0; k <= idx; k++) {
    const t = lines[k].trim()
    const m = /^(`{3,}|~{3,})/.exec(t)
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
 * 规范 §8.2 规定最大嵌套深度 = 1，任何块内部不得再出现块。
 * 违反 → 整块按 L2 降级。
 */
function hasNestedBlock(body: string[]): boolean {
  for (let i = 0; i < body.length; i++) {
    if (isInsideCodeFence(body, i)) continue
    const m = matchFenceOpen(body[i])
    if (m && (KNOWN_TYPES as string[]).includes(m.type)) return true
  }
  return false
}

/** 构建块，含结构合法性检查与降级 */
function buildBlock(open: FenceOpen, body: string[]): Block {
  const raw = body.join('\n')
  const type = open.type as BlockType

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
    case 'summary': {
      // 正文为空 → 丢弃（level 4 表示丢弃）
      if (!raw.trim()) return { type, attrs, raw, level: 4 }
      // 补默认值 → L1
      const level: Level = open.attrs.title === undefined ? 1 : 0
      return { type, attrs, raw, level }
    }

    case 'points': {
      const items = parsePoints(raw)
      if (items.length === 0) return { type, attrs, raw, level: 2 }
      const level: Level = open.attrs.cols === undefined ? 1 : 0
      return { type, attrs, raw, level }
    }

    case 'table': {
      if (!isValidTable(raw)) return { type, attrs, raw, level: 2 }
      const level: Level = open.attrs.title === undefined ? 1 : 0
      return { type, attrs, raw, level }
    }

    case 'steps': {
      const items = parseSteps(raw)
      if (items.length === 0) return { type, attrs, raw, level: 2 }
      const level: Level = open.attrs.title === undefined ? 1 : 0
      return { type, attrs, raw, level }
    }

    case 'columns': {
      const cols = splitColumns(raw)
      if (cols.length !== 2) return { type, attrs, raw, level: 2 }
      return { type, attrs, raw, level: 0 }
    }

    default:
      return { type, attrs, raw, level: 2 }
  }
}

/** 解析 points：`- **标题** — 描述` */
export function parsePoints(raw: string): Array<{ title: string; desc: string }> {
  const items: Array<{ title: string; desc: string }> = []
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
export function parseSteps(raw: string): Array<{ title: string; desc: string }> {
  const items: Array<{ title: string; desc: string }> = []
  const re = /^(?:\d+[.)]|[-*+])\s+(.*)$/

  for (const line of raw.split('\n')) {
    const m = re.exec(line.trim())
    if (!m) continue
    const text = m[1].trim()
    const split = /^(?:\*\*(.+?)\*\*|__(.+?)__)\s*[—–\-:：]?\s*(.*)$/.exec(text)
    if (split) {
      items.push({
        title: (split[1] ?? split[2] ?? '').trim(),
        desc: (split[3] ?? '').trim(),
      })
    } else {
      items.push({ title: text, desc: '' })
    }
  }
  return items
}

/** 表格合法性：必须有分隔行且至少一行数据 */
export function isValidTable(raw: string): boolean {
  const lines = raw.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return false
  return /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/.test(lines[1]) && lines[1].includes('-')
}

/** 分栏：独占一行的 --- 分隔 */
export function splitColumns(raw: string): string[] {
  const parts = raw.split(/^\s*---\s*$/m)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

// ─────────────────────────────────────────────────────────────
// S 族 · 语义块识别
// ─────────────────────────────────────────────────────────────

export interface SemanticBlock {
  kind: 'note' | 'tip' | 'warning' | 'important' | 'unknown'
  label: string
  content: string
}

/**
 * 从 markdown 段落中识别 GitHub Alerts 引用块。
 * 渲染层用它在普通 markdown 内部做语义着色。
 */
export function detectSemantic(markdown: string): SemanticBlock[] {
  const out: SemanticBlock[] = []
  const re = /^>\s*\[!([A-Za-z]+)\]\s*$/gm
  let m: RegExpExecArray | null

  while ((m = re.exec(markdown)) !== null) {
    const type = m[1].toUpperCase()
    const start = m.index + m[0].length
    // 取该引用块后续所有 > 行
    const rest = markdown.slice(start)
    const bodyLines: string[] = []
    for (const line of rest.split('\n')) {
      if (/^>\s?/.test(line)) bodyLines.push(line.replace(/^>\s?/, ''))
      else if (line.trim() === '') break
      else break
    }
    const content = bodyLines.join('\n').trim()
    if (!content) continue

    const known = ['NOTE', 'TIP', 'WARNING', 'IMPORTANT']
    out.push({
      kind: (known.includes(type) ? type.toLowerCase() : 'unknown') as SemanticBlock['kind'],
      label: known.includes(type) ? SEMANTIC_LABEL[type] : type.charAt(0) + type.slice(1).toLowerCase(),
      content,
    })
  }
  return out
}

const SEMANTIC_LABEL: Record<string, string> = {
  NOTE: '补充说明',
  TIP: '实用建议',
  WARNING: '注意事项',
  IMPORTANT: '关键结论',
}
