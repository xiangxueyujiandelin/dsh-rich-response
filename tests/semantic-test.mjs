/**
 * S 族语义块（GitHub Alerts）识别测试 —— 直接测 src/parser.js 的真实实现。
 *
 * 背景：2026-11-05 之前的 detectSemantic 从标记行结尾直接切剩余文本，
 * 开头是换行符，正文循环立刻 break → **对任何输入恒返回 []**，
 * 语义色块因此从未生效过（而且渲染层根本没调用它）。
 *
 * 这些断言把「识别 + 字符区间」钉死，防止再退回死代码或坏实现。
 *
 * 运行：node tests/semantic-test.mjs
 */
import { detectSemantic } from '../src/parser.js'

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

console.log('── 基础识别 ──')

const plain = detectSemantic('> [!NOTE]\n> 补充说明。')
t('单行 NOTE 能识别（旧实现恒返回 []）', plain.length === 1, `实际 ${plain.length} 条`)
t('kind 归一成小写 note', plain[0]?.kind === 'note', `kind=${plain[0]?.kind}`)
t('label 用协议中文标签「补充说明」', plain[0]?.label === '补充说明', `label=${plain[0]?.label}`)
t('content 收进正文', plain[0]?.content === '补充说明。', `content=${plain[0]?.content}`)

const multi = detectSemantic('前文。\n\n> [!TIP]\n> 第一行 **加粗**。\n> 第二行 `code`。\n\n后文。')
t('多行正文逐行收入并用 \\n join', multi[0]?.content === '第一行 **加粗**。\n第二行 `code`。', `content=${JSON.stringify(multi[0]?.content)}`)
t('TIP 映射成 tip 标签「实用建议」', multi[0]?.kind === 'tip' && multi[0]?.label === '实用建议')

const warn = detectSemantic('> [!WARNING]\n> 危险。')
t('WARNING 映射成 warning 标签「注意事项」', warn[0]?.kind === 'warning' && warn[0]?.label === '注意事项')

const imp = detectSemantic('> [!IMPORTANT]\n> 关键。')
t('IMPORTANT 映射成 important 标签「关键结论」', imp[0]?.kind === 'important' && imp[0]?.label === '关键结论')

console.log('\n── 字符区间（渲染层据此切分原文）──')
const source = '前文\n\n> [!NOTE]\n> 补充 **说明**。\n> 第二行\n\n后文'
const one = detectSemantic(source)
t('标记块只识别一次', one.length === 1, `实际 ${one.length}`)
t(
  'start/end 能切回原始引用块',
  typeof one[0]?.start === 'number' &&
    typeof one[0]?.end === 'number' &&
    source.slice(one[0].start, one[0].end) === '> [!NOTE]\n> 补充 **说明**。\n> 第二行\n',
  JSON.stringify(source.slice(one[0]?.start, one[0]?.end)),
)
t(
  '切分区间之外就是普通 markdown（前文 / 后文都保留）',
  source.slice(0, one[0].start) === '前文\n\n' && source.slice(one[0].end) === '\n后文',
)

// 文件末尾没有换行也要能收到正文
const eof = detectSemantic('> [!NOTE]\n> 最后一行没有换行')
t('EOF 处正文不丢（最后一行无换行）', eof[0]?.content === '最后一行没有换行', `content=${JSON.stringify(eof[0]?.content)}`)

// 多个语义块
const two = detectSemantic('> [!NOTE]\n> A\n\n中间\n\n> [!TIP]\n> B')
t('同一段里能识别多个语义块', two.length === 2 && two[0].content === 'A' && two[1].content === 'B', `实际 ${two.length} 条`)

console.log('\n── 降级与边界 ──')
const unknown = detectSemantic('> [!CAUTION]\n> 未定义类型。')
t('未定义类型 kind=unknown（渲染层降级成 NOTE 样式）', unknown[0]?.kind === 'unknown', `kind=${unknown[0]?.kind}`)
t('未定义类型保留标签 Caution', unknown[0]?.label === 'Caution', `label=${unknown[0]?.label}`)

t('普通引用不误判', detectSemantic('> 普通引用\n> 第二行').length === 0)
t('行内出现 [!NOTE] 不误判', detectSemantic('这里说 > [!NOTE] 不是语义块').length === 0)
t('标记行带尾随空格能识别', detectSemantic('> [!NOTE]   \n> 正文').length === 1)
t('空正文的语义块被丢弃（不产生空卡片）', detectSemantic('> [!NOTE]\n\n后续').length === 0)

t('非字符串输入返回空数组', detectSemantic(null).length === 0 && detectSemantic(undefined).length === 0)
t('空字符串返回空数组', detectSemantic('').length === 0)

let threw = 0
const seeds = ['> [!NOTE]', '> [!', '> [!NOTE]\n> ', '> [!UNKNOWN]\n> x', '> [', '>', '> [!NOTE] \r\n> 正文']
for (let i = 0; i < 500; i++) {
  const s = seeds[i % seeds.length] + seeds[(i * 7) % seeds.length]
  try {
    detectSemantic(s)
  } catch {
    threw++
  }
}
t('500 次随机拼接不抛异常', threw === 0, `threw=${threw}`)

console.log(`\n语义块识别测试：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
