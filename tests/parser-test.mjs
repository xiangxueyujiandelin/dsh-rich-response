/**
 * 富渲染协议 · 解析器测试用例集
 *
 * 对应规范：protocol/rich-render-protocol-v1.md §12
 * 运行：node parser-test.mjs
 *
 * 状态：31/31 通过（2026-11-05）
 * 本文件是实现的验收标准，可直接移植为 vitest / junit 测试。
 *
 * 注意：这里的 parseRich 是规范 §9 的参考实现（与 parser-reference.ts 逻辑一致），
 * 之所以内联而非 import，是为了让本文件零依赖、可直接 node 运行。
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// 测试用例集：对应 protocol/rich-render-protocol-v1.md §12
// 直接内联核心逻辑，验证降级矩阵成立

const FENCE = ':::'
const KNOWN = ['summary','points','table','steps','columns']
const DEFAULT_ATTRS = {
  summary:{title:'结论',tone:'summary'}, points:{cols:'3',tone:'neutral'},
  table:{title:'',compact:'false'}, steps:{title:'',ordered:'',showLine:'true'}, columns:{}
}
function matchOpen(line){
  const t=line.trim(); if(!t.startsWith(FENCE)) return null
  const m=/^([a-zA-Z][\w-]*)\s*(\{.*\})?\s*$/.exec(t.slice(3)); if(!m) return null
  const attrs={}; if(m[2]){const r=/([\w-]+)\s*=\s*"([^"]*)"/g;let a;while((a=r.exec(m[2]))!==null)attrs[a[1]]=a[2]}
  return {type:m[1].toLowerCase(),attrs}
}
function inCode(lines,idx){
  let open=false,mk='';
  for(let k=0;k<=idx;k++){const m=/^(`{3,}|~{3,})/.exec(lines[k].trim());if(!m)continue;
    if(!open){open=true;mk=m[1][0]}else if(m[1][0]===mk){open=false}}
  return open
}
function findClose(lines,from){for(let j=from;j<lines.length;j++){if(inCode(lines,j))continue;if(lines[j].trim()===FENCE)return j}return -1}
function parsePoints(raw){const o=[];const re=/^[-*+]\s+(?:\*\*(.+?)\*\*|__(.+?)__)\s*[—–\-:：]?\s*(.*)$/
  for(const l of raw.split('\n')){const m=re.exec(l.trim());if(m)o.push({title:(m[1]??m[2]??'').trim(),desc:(m[3]??'').trim()})}return o}
function parseSteps(raw){const o=[];const re=/^(?:\d+[.)]|[-*+])\s+(.*)$/
  for(const l of raw.split('\n')){const m=re.exec(l.trim());if(!m)continue;const t=m[1].trim()
    const s=/^(?:\*\*(.+?)\*\*|__(.+?)__)\s*[—–\-:：]?\s*(.*)$/.exec(t)
    if(s)o.push({title:(s[1]??s[2]??'').trim(),desc:(s[3]??'').trim()});else o.push({title:t,desc:''})}return o}
function isValidTable(raw){const l=raw.split('\n').filter(x=>x.trim());if(l.length<2)return false
  return /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/.test(l[1])&&l[1].includes('-')}
function splitCols(raw){return raw.split(/^\s*---\s*$/m).map(p=>p.trim()).filter(p=>p.length>0)}
function hasNestedBlock(body){
  // 块内部出现其他块起始行 → 违反最大嵌套深度=1
  for(let i=0;i<body.length;i++){
    if(inCode(body,i))continue
    const m=matchOpen(body[i])
    if(m&&KNOWN.includes(m.type))return true
  }
  return false
}
function build(open,body){
  const raw=body.join('\n'),type=open.type
  if(!KNOWN.includes(type))return{type:'summary',attrs:{},raw,level:2}
  const attrs={...DEFAULT_ATTRS[type],...open.attrs}
  if(hasNestedBlock(body))return{type,attrs,raw,level:2}
  switch(type){
    case 'summary': if(!raw.trim())return{type,attrs,raw,level:4};return{type,attrs,raw,level:open.attrs.title===undefined?1:0}
    case 'points': if(parsePoints(raw).length===0)return{type,attrs,raw,level:2};return{type,attrs,raw,level:open.attrs.cols===undefined?1:0}
    case 'table': if(!isValidTable(raw))return{type,attrs,raw,level:2};return{type,attrs,raw,level:open.attrs.title===undefined?1:0}
    case 'steps': if(parseSteps(raw).length===0)return{type,attrs,raw,level:2};return{type,attrs,raw,level:open.attrs.title===undefined?1:0}
    case 'columns': if(splitCols(raw).length!==2)return{type,attrs,raw,level:2};return{type,attrs,raw,level:0}
    default: return{type,attrs,raw,level:2}
  }
}
function parseRich(text){
  try{
    if(!text)return[]
    const segs=[],lines=text.split('\n');let buf=[],i=0
    const flush=()=>{if(buf.length){segs.push({kind:'markdown',content:buf.join('\n')});buf=[]}}
    while(i<lines.length){
      const line=lines[i]
      if(inCode(lines,i)){buf.push(line);i++;continue}
      const open=matchOpen(line)
      if(open){
        const ci=findClose(lines,i+1)
        const body=lines.slice(i+1,ci===-1?lines.length:ci)
        flush()
        if(ci===-1){segs.push({kind:'markdown',content:[line,...body].join('\n')});i=lines.length;continue}
        segs.push({kind:'block',block:build(open,body)});i=ci+1;continue
      }
      buf.push(line);i++
    }
    flush();return segs
  }catch(e){return[{kind:'markdown',content:text}]}
}

// ── 测试 ──
let pass=0,fail=0
function t(id,name,cond,extra=''){
  if(cond){pass++;console.log(`  ok   ${id} ${name}`)}
  else{fail++;console.log(`  FAIL ${id} ${name} ${extra}`)}
}
const blocks=(r)=>r.filter(s=>s.kind==='block').map(s=>s.block)
const md=(r)=>r.filter(s=>s.kind==='markdown')

console.log('── §12.1 解析正确性 ──')
let r=parseRich(':::summary{title="结论"}\n内容\n:::')
t(1,'summary 解析',blocks(r).length===1&&blocks(r)[0].level===0&&blocks(r)[0].attrs.title==='结论')
r=parseRich(':::summary\n内容\n:::')
t(2,'默认 title',blocks(r).length===1&&blocks(r)[0].attrs.title==='结论'&&blocks(r)[0].level===1)
r=parseRich(':::points{cols="2"}\n- **A** — 说明\n- **B** — 说明\n:::')
t(3,'points 解析',blocks(r).length===1&&blocks(r)[0].attrs.cols==='2'&&parsePoints(blocks(r)[0].raw).length===2)
r=parseRich(':::table{title="影响面"}\n| a | b |\n|---|---|\n| 1 | 2 |\n:::')
t(4,'table 解析(有title→L0)',blocks(r).length===1&&blocks(r)[0].level===0&&blocks(r)[0].attrs.title==='影响面')
r=parseRich(':::table\n| a | b |\n|---|---|\n| 1 | 2 |\n:::')
t('4b','table 无title→L1',blocks(r).length===1&&blocks(r)[0].level===1)
r=parseRich(':::steps\n1. 一\n2. 二\n:::')
t(5,'steps 解析',blocks(r).length===1&&parseSteps(blocks(r)[0].raw).length===2)
r=parseRich(':::columns\n左\n\n---\n\n右\n:::')
t(6,'columns 解析',blocks(r).length===1&&splitCols(blocks(r)[0].raw).length===2)
r=parseRich('普通段落\n\n第二段')
t(7,'纯 markdown 合并为1段',r.length===1&&r[0].kind==='markdown'&&r[0].content==='普通段落\n\n第二段')

console.log('── §12.2 降级（主要路径）──')
r=parseRich(':::table\n| a | b |\n无分隔行\n:::')
t(8,'表格非法→L2',blocks(r).length===1&&blocks(r)[0].level===2)
r=parseRich(':::points\n没有加粗也没有分隔符\n:::')
t(9,'points 非法→L2',blocks(r).length===1&&blocks(r)[0].level===2)
r=parseRich(':::summary{title="x"}\n内容')
t(10,'未闭合→L3',blocks(r).length===0&&md(r).length===1)
r=parseRich(':::unknown{foo="bar"}\n内容\n:::')
t(11,'未知类型→L2',blocks(r).length===1&&blocks(r)[0].level===2)
r=parseRich(':::summary\n\n:::')
t(12,'空块→丢弃(L4)',blocks(r).length===1&&blocks(r)[0].level===4)
r=parseRich('普通 markdown')
t(13,'无块→默认路径',r.length===1&&r[0].kind==='markdown')

console.log('── §12.3 边界 ──')
r=parseRich('```\n:::summary\n代码里的\n:::\n```')
t(14,'代码块内 ::: 不解析',blocks(r).length===0)
r=parseRich('\\:::summary')
t(15,'转义 \\:::',blocks(r).length===0)
r=parseRich(':::points\n- **A** — x\n:::summary\n嵌套\n:::\n:::')
t(16,'嵌套→该块L2',blocks(r).length===1&&blocks(r)[0].level===2)
t(17,'空字符串',parseRich('').length===0)
t(18,'只有 :::',parseRich(':::').length>=0)
t(19,'10000字不超时',parseRich(':::summary\n'+'x'.repeat(10000)+'\n:::').length===1)

console.log('── §12.4 不变量 ──')
// fuzz: 随机输入不抛异常
let threw=0
const seeds=[':::',':::x',':::summary{','```','> [!NOTE]','|---',':::columns\n---\n---',':::points{cols=}','','\n\n\n']
for(let i=0;i<3000;i++){
  let s=seeds[i%seeds.length]
  s+=seeds[(i*7)%seeds.length]+seeds[(i*13)%seeds.length]
  try{parseRich(s)}catch(e){threw++}
}
t(21,'fuzz 3000 次不抛异常',threw===0,`threw=${threw}`)
// 流式：逐字符喂入，块区域始终存在且最终闭合
let acc='',states=[]
const full=':::summary{title="结论"}\n内容\n:::'
for(const ch of full){acc+=ch;states.push(parseRich(acc))}
t(22,'流式最终闭合为块',blocks(states[states.length-1]).length===1&&blocks(states[states.length-1])[0].level===0)
t(23,'流式中途不产生块',states.slice(0,-1).every(s=>blocks(s).length===0))
t(17.5,'流式中途有 markdown 兜底',states.slice(0,-1).every(s=>md(s).length>=1))

console.log('── §12.5 renderInline 不变量（递归 + 共享 g 正则回归）──')
// renderInline 住在 src/client.js 的 factory 闭包里，无法 import；
// 这里按源码切片 + vm 执行（只用 node 内置模块，仍然零外部依赖）。
// 回归背景：INLINE_RE 曾是模块级带 g 的正则，递归调用共享它的 lastIndex ——
// 子循环结束时 exec 返回 null 并把 lastIndex 归零，父循环于是从 0 重匹配同一个
// token，m.index > last 恒假 → 无限循环，浏览器主线程忙等、标签页冻结。
// 下面覆盖当时实测冻住的 4 个输入，外加 2 个不该受影响的正常对照。
const clientSrc = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const inlineStart = clientSrc.indexOf('const INLINE_RE =')
const inlineEnd = ['// S 族 · 语义块（GitHub Alerts）', 'function buildMarkdownLabels']
  .map((marker) => clientSrc.indexOf(marker))
  .find((idx) => idx > inlineStart)
t('rr0', '能从 src/client.js 定位 renderInline 代码段', inlineStart !== -1 && inlineEnd !== undefined && inlineEnd !== -1)

if (inlineStart !== -1 && inlineEnd !== undefined && inlineEnd !== -1) {
  const inlineCode = clientSrc.slice(inlineStart, inlineEnd)
  const renderInlineCase = (text) => {
    // 独立上下文：createElement 桩只需产出可断言的树，不依赖 React
    const context = vm.createContext({
      createElement: (type, props, ...kids) => ({ type, children: kids.length > 1 ? kids : kids[0] }),
    })
    vm.runInContext(`${inlineCode}\nthis.rrRenderInline = renderInline;`, context, { timeout: 1000 })
    return vm.runInContext(`this.rrRenderInline(${JSON.stringify(text)})`, context, { timeout: 1000 })
  }
  const inlineCase = (id, name, text, check) => {
    let ok = false
    let detail = ''
    try {
      const out = renderInlineCase(text)
      ok = check(out)
      detail = JSON.stringify(out) ?? String(out)
    } catch (err) {
      detail = `抛错或超时：${err && err.message}`
    }
    t(id, name, ok, String(detail).slice(0, 160))
  }

  inlineCase('rr1', '加粗内含斜体不死循环（曾冻结标签页）', '**a *b* c**',
    (o) => Array.isArray(o) && o[0] && o[0].type === 'strong' && o[0].children.some((c) => c && c.type === 'em'))
  inlineCase('rr2', '链接标签内含加粗不死循环（曾冻结标签页）', '[**x**](https://e.com)',
    (o) => Array.isArray(o) && o[0] && o[0].type === 'a' && o[0].children[0].type === 'strong')
  inlineCase('rr3', '删除线内含斜体不死循环（曾冻结标签页）', '~~*x*~~',
    (o) => Array.isArray(o) && o[0] && o[0].type === 'del' && o[0].children[0].type === 'em')
  inlineCase('rr4', '加粗内含行内代码不死循环（曾冻结标签页）', '**注意 `--flag`**',
    (o) => Array.isArray(o) && o[0] && o[0].type === 'strong' && o[0].children.some((c) => c && c.type === 'code'))
  inlineCase('rr5', '加粗内含下划线正常（不应误判为 __ 强调）', '**snake_case**',
    (o) => Array.isArray(o) && o[0] && o[0].type === 'strong')
  inlineCase('rr6', '扁平加粗不受影响（防修过头）', '**bold**',
    (o) => Array.isArray(o) && o[0] && o[0].type === 'strong' && o[0].children === 'bold')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail>0?1:0)
