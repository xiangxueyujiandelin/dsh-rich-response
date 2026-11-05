/**
 * 宿主半区（host half）
 *
 * DSH 的插件是双侧的：
 *   - 宿主半区（index.js）：跑在 Node 侧
 *   - 客户端半区（client.js）：跑在浏览器侧，负责 UI 渲染
 *
 * 本半区的职责只有一个：往系统提示词末尾追加一段**保守**的「富渲染协议」，
 * 让模型知道 `:::summary / :::points / :::table / :::steps` 四类结构块存在，
 * 并且只在内容确实贴合时才用。客户端半区仍是纯被动渲染器：只有真出现
 * 合规围栏才渲染成卡片，普通 markdown 一律走宿主原生渲染。
 *
 * 历史：2026-11-05 18:10 曾整体删掉这里的协议注入（当时由启发式改写
 * 把普通列表硬转卡片，效果生硬）。现在卡片正文已支持行内 markdown
 * （粗体/行内代码/链接），改回「只注入协议、不做启发式改写」的保守形态。
 *
 * 安全性：宿主给什么 ctx 都不能抛错 —— 一旦这里抛出，插件注册失败会
 * 连带客户端渲染器一起挂掉。所有宿主 API 调用都包在 try/catch 里。
 */

export const name = 'dsh-rich-response'

/** 协议注入用 ctx.inject('systemPrompt') 等待服务就绪，不阻塞插件加载 */
export const inject = []

const SECTION_NAME = 'dsh-rich-response:protocol'

/**
 * 注入给模型的协议。原则：
 *   - 四类块只是可选的排版手段，默认仍是普通 markdown
 *   - 明确「什么时候不用」，避免把解释/代码/报错也塞进卡片
 *   - 每类只给一个最小示例，控制 token 占用
 */
const PROTOCOL = `【富渲染协议 · dsh-rich-response】

下面四种结构块会被渲染成彩色卡片。它们只是可选的排版手段，默认仍然用普通 markdown；同类块最多 2 个，块与块之间空一行，块内不要嵌套，不要写进代码块或引用块；也不要向用户解释这些标记。

· 只有一个核心结论时：
:::summary{title="结论"}
一句话结论
:::

· 2-4 个真正并列的要点时：
:::points{cols="3"}
- **标题** — 一句话说明
- **标题** — 一句话说明
:::

· 需要多维度对照时：
:::table{title="对比"}
| 维度 | 方案 A | 方案 B |
|---|---|---|
| 速度 | 快 | 慢 |
:::

· 3 步以上、有先后的操作时：
:::steps{title="步骤"}
1. 第一步
2. 第二步
3. 第三步
:::

以上都不贴切时（解释概念、贴代码、分析报错、单个命令、寒暄闲聊）一律用普通 markdown，拿不准就不用。强调补充/建议/风险可用 > [!NOTE] / [!TIP] / [!WARNING] / [!IMPORTANT]。`

/** 越靠后越接近对话，取 persona 后缀之前的位置；取不到就退到最后 */
function resolveOrder(systemPrompt) {
  try {
    if (typeof systemPrompt.getSectionOrder === 'function') {
      const tail = systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      if (Number.isFinite(tail)) return tail + 100
      const head = systemPrompt.getSectionOrder('HARNESS_IDENTITY')
      if (Number.isFinite(head)) return head + 1
    }
  } catch {
    // 宿主版本不认识这些 section 名，走兜底顺序
  }
  return 1_000_000
}

/** 找到 systemPrompt 服务就注册一节；找不到/不许注册都安静返回 false */
function installProtocol(scope) {
  try {
    const systemPrompt =
      scope?.systemPrompt ??
      (typeof scope?.get === 'function' ? scope.get('systemPrompt') : undefined)
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return false
    systemPrompt.section({
      name: SECTION_NAME,
      order: resolveOrder(systemPrompt),
      text: PROTOCOL,
      interpolate: false,
    })
    return true
  } catch {
    return false
  }
}

/**
 * @param {any} ctx 宿主上下文
 * @param {{ enabled?: boolean }} [config] 插件配置；enabled=false 可完全关闭注入
 */
export function apply(ctx, config = {}) {
  if (config && config.enabled === false) return
  try {
    if (ctx && typeof ctx.inject === 'function') {
      // 服务就绪后回调；回调参数是新作用域的 ctx
      ctx.inject(['systemPrompt'], (scope) => {
        installProtocol(scope)
      })
      return
    }
    installProtocol(ctx)
  } catch {
    // 绝不连累客户端渲染器
  }
}
