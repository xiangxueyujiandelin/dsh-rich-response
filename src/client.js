/**
 * 客户端半区（client half）—— 浏览器侧
 *
 * ⚠️ 本文件所有宿主 API 均已对照源码确认，出处见 docs/host-seam-reference.md
 *
 * ── 加载格式（2026-11-05 崩溃排查实证）──────────────────────────────
 * 宿主用 `<script>` 标签加载插件 bundle（**classic script，不是 ES module**），
 * 所以顶层 `import` 会直接抛：
 *   SyntaxError: Cannot use import statement outside a module
 *
 * 而且宿主会把多个插件的 client.js 拼成一个「批次 combo 脚本」一起执行 ——
 * 我们这一行语法错误，会把**同一批次的所有插件**一起拖垮。
 * （崩溃日志里两条报错：一条是 combo 批次 URL，一条是我们自己的单资源 URL。）
 *
 * 正确格式（对照已装插件 dshmarket / dsh-prompt-sortable / dsh-context
 * 与社区插件 dsh-markstream 的产物）：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * factory 收到的 `require` 由宿主的模块表解析，顺序是
 *   seed 表 → 已物化记录 → 启动图 row → 已注册 factory
 * 其中 seed 表（PLATFORM_MODULES）含：
 *   react / react/jsx-runtime / react-dom / react-dom/client
 *   @deepseek-ai/cordis / zod / @tanstack/react-virtual
 *   @deepseek-ai/dsh-client-store / dsh-client-ui-slots
 *   dsh-client-ui-primitives / dsh-client-ui-dockkit
 *
 * ⚠️ **相对路径 require 不支持** —— './parser.js' 三处解析都不命中，会抛
 *   「missed the module table」。所以协议解析器代码直接内联在本文件里。
 *   src/parser.js 保留为独立可测副本，由构建脚本校验两份行为一致。
 *
 * 数据流（已实证）：
 *   SessionEvent → assistantDefinition → AssistantChatData
 *   → node.data.blocks[] → 遍历渲染
 *
 * 渲染器 props 实际结构（来自 ChatNodeSeat.tsx）：
 *   { node, groupPart, cwd, openFile, inspectCall, forkAt, loadImage,
 *     turnProcess, renderSlot, t, useDisclosure, usePresentation, ... }
 *
 * node.data 结构（来自 contract/chat-nodes.ts）：
 *   { status: 'running'|'settled'|'interrupted', turn, step,
 *     blocks: readonly AssistantBlock[], time, usage?, finalNode? }
 *
 * blocks 每项的 kind：
 *   'text'       → { kind:'text', text }
 *   'reasoning'  → { kind:'reasoning', text }
 *   'image'      → { kind:'image', attachment }
 *   'tool-call'  → { kind:'tool-call', callId, name, argsRaw }
 *
 * ── 2026-11-05 空白故障实证（第三次翻车，根因已定位）──────────────────
 *
 * 症状：聊天区**助手回复正文整片空白**，用户气泡、工具栏、输入框一切正常。
 *
 * 根因链（已扒宿主真实产物确认，非推测）：
 *   1. 宿主 MarkdownText 的真实签名（web bundle 实测）：
 *        memo(function({text, streaming, labels, fileMentions, pathImages,
 *                        variant, omitHtml, textInteractionSource}))
 *      本插件原先只传了 3 个 prop，**漏了 labels**。
 *   2. 宿主渲染代码块时执行 `r.labels.code.copyLabel`（无任何保护），
 *      labels 为 undefined → TypeError: Cannot read properties of undefined
 *   3. 宿主在 slot 外套了 SlotErrorBoundary，捕获后渲染一个**空 div**：
 *        `<div data-slot-error="conversation.chat.node">`
 *      → 于是正文整片消失，而 UI 其余部分照常。
 *
 * 教训：**宿主 API 不能靠推理，必须扒产物**（第三次了）。
 *   本轮是从 app.asar 里提取 dsh-client-ui-chat/lib/client.js 与
 *   dsh-web-frontend 的 web bundle，扒出真实实现才定位到的。
 *
 * 现在的防线：
 *   - MarkdownText 补齐全部必需 prop（labels/pathImages/fileMentions）
 *   - 三层 ErrorBoundary（块级 / 结构块 / 整节点），任何一层失败都
 *     降级到宿主原生渲染，**绝不向外抛异常**
 */

window.__ModuleLoader__.load({
  id: 'dsh-rich-response',
  factory: (require) => {
    const react = require('react')
    const { createElement, Fragment, useState } = react
    const primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      JsonBlock,
      MarkdownText,
      DisclosureRow,
      IconThinkOutlineRegular,
    } = primitivesModule

    /**
     * React 基类。
     *
     * 我们的 ErrorBoundary 需要继承 Component 才能实现
     * getDerivedStateFromError。宿主 react 一定有它，
     * 但万一没有（老宿主 / 测试桩），也不能让插件整个崩掉 ——
     * 退化成无边界模式：渲染照常，只是失去错误隔离这层保险。
     */
    const Component = react.Component ?? class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
    }

    /**
     * 宿主注入的 primitives 里，本插件真正依赖的导出。
     *
     * dshmarket 的源码注释警告过：
     *   "The primitives module is host-injected (external at build time), so on an
     *    older host the module resolves but these named exports are undefined —
     *    rendering would throw and blank the whole settings dialog."
     *
     * 同样的风险对聊天区更大 —— 聊天区白屏意味着整个应用不可用。
     * 所以这里做能力探测：缺什么就退到什么，绝不抛异常。
     *
     * DisclosureRow / IconThinkOutlineRegular 用于自己画推理折叠行
     * （因为我们不声明 children，拿不到宿主的 reasoning.body 子 slot）。
     */
    const REQUIRED_PRIMITIVES = [
      'MarkdownText',
      'JsonBlock',
      'DisclosureRow',
      'IconThinkOutlineRegular',
    ]

    /** 探测宿主提供的 primitives 是否齐全 */
    function missingPrimitives(mod, required) {
      const list = required ?? REQUIRED_PRIMITIVES
      return list.filter((n) => mod[n] === undefined)
    }

    // ─────────────────────────────────────────────────────────────
    // 入口
    // ─────────────────────────────────────────────────────────────

    function apply(ctx) {
      try {
        // 能力探测：宿主版本过老导致 primitives 缺失时，直接不注册渲染器，
        // 保持宿主默认渲染 —— 宁可不生效，也不能让聊天区白屏。
        const gaps = missingPrimitives(primitivesModule)
        if (gaps.length > 0) {
          console.warn(
            `[dsh-rich-response] 宿主缺少 ${gaps.join(', ')}，本次不接管渲染器（保持默认显示）`,
          )
          return
        }
        registerRichRenderer(ctx)
      } catch (err) {
        console.error('[dsh-rich-response] 注册失败，宿主渲染不受影响:', err)
      }
    }

    /**
     * 注册 assistant-step 座位的渲染器。
     *
     * key 必须是 'assistant-step'（来自 register-node-renderers.ts）——
     * 写错则 slot 匹配不上，插件完全不生效。
     *
     * priority: -10 —— 内置渲染器未指定 priority（默认 0），
     * 数字越小越优先，故 -10 排在内置之前（社区插件 dsh-markstream 同款做法）。
     *
     * ⚠️⚠️ **绝对不能声明 children**（2026-11-05 实测踩坑）
     *
     *   子 slot 的**声明权是独占的**。宿主 slots 源码（web bundle，register 方法）：
     *     if (e.children) for (const f of Object.keys(e.children)) {
     *       const h = this.records.get(f);
     *       if (h?.spec) throw new Error(`slot "${f}" is already declared ...`)
     *     }
     *
     *   内建 assistant-step entry 已经声明了
     *     'conversation.chat.reasoning.body'
     *     'conversation.chat.message.images'
     *   我们再声明一次 → **注册时直接抛错**：
     *     slot "conversation.chat.reasoning.body" is already declared
     *     (by an entry in "conversation.chat.node" (dsh-rich-response))
     *   → 整个插件注册失败 → 渲染器从未接管 → 助手回复正文空白。
     *
     *   官方文档原话：「声明即占有渲染权，不要争抢别人的 seat」
     *   「One live entry owns each declaration. ... declaring a child already
     *     owned elsewhere fails during plugin activation.」
     *
     *   社区插件 dsh-markstream 的做法（github.com/boomboomxx/dsh-markstream）：
     *     ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
     *       { name: 'conversation.chat.node', key: 'assistant-step',
     *         locale: 'conversation', priority: -10 },
     *       view,
     *     ))
     *   —— **没有 children**，推理块改用 primitives 的 DisclosureRow 自己画。
     *
     *   代价：standardKit 里 `entry.children !== void 0` 才有 renderSlot，
     *   所以我们拿不到 renderSlot → 推理块与图片块要自己处理（见下）。
     *
     * ⚠️ locale 命名空间必须与内建**逐字一致**，否则 t() 拿不到翻译。
     *   宿主内建用的是 NS = "chat"（dsh-client-ui-chat 的 locale 字典注册在
     *   'chat' 命名空间下，见 lib/types/client/chat/register-node-renderers.ts
     *   里的 `const NS = "chat"`）。
     *   ⚠️ 2026-11-05 实测修正：这里原先写的是 'conversation'，是错的。
     *   写错不会崩（locale face.bind 对未知命名空间只是回退到返回 key 本身），
     *   但所有 UI 文案会变成裸 key（如 'message.unknownBlock'）。
     *
     * ⚠️ inject 必须与内建一致 —— 内建注入了 resolveFilePath / fileMentions /
     *   presentation hook，MarkdownText 的 fileMentions prop 依赖它。
     *   内建原文：
     *     inject: (sessionId) => ({
     *       hooks: { presentation },
     *       resolveFilePath: sessionFilePath(ctx, sessionId),
     *       fileMentions: (owner, getFileTriggerProps) =>
     *         ctx.get("chatFileMentions")?.forClosing(owner, sessionId, getFileTriggerProps)
     *     })
     *   我们覆盖后必须重复声明，否则 inject 出来的 props 缺失，
     *   fileMentions 拿不到 → @路径 提及无法点开。
     */
    function registerRichRenderer(ctx) {
      if (!ctx.slots) {
        // ⚠️ 2026-11-05：这里原先是静默 return —— 宿主 ctx 形状不符时
        //   插件不接管且**不留任何痕迹**，排查时完全看不见。必须留日志。
        console.warn(
          '[dsh-rich-response] ctx.slots 缺失（宿主 ctx 形状不符），本次不接管渲染器',
        )
        return
      }

      ctx.slots.inject('conversation.chat.node', () => {
        // ⚠️ factory 在宿主内部被调用，它抛错会逃过 apply 的 try/catch
        //   被宿主吞掉 → 插件不接管且不留痕迹。这里先记日志。
        try {
          ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'assistant-step',
              locale: 'chat',
              priority: -10,
              // ⚠️ 这里**故意不声明 children** ——
              //   子 slot 声明权是独占的，内建 assistant-step entry 已经声明了
              //   reasoning.body 与 message.images，我们再声明会在注册时抛
              //   「slot "..." is already declared」→ 插件整个注册失败 →
              //   渲染器从未接管 → 助手回复正文空白。
              //   详见上方注释。
              inject: (sessionId) => {
                // ⚠️ 2026-11-05 DevTools 实测：宿主 MarkdownText 内部执行
                //   `fileMentions?.resolve(...)` —— 期望**带 resolve 方法的对象**；
                //   而内建 inject 给的是函数形态。裸函数会让宿主抛
                //   TypeError: r.fileMentions?.resolve is not a function
                //   → slot entry crashed → 该节点被 SlotErrorBoundary 接管。
                //   鸭型兼容：函数对象上挂 resolve，两种调用形态都满足。
                const fileMentions = () => undefined
                fileMentions.resolve = () => undefined
                return {
                  resolveFilePath: (path) => path,
                  fileMentions,
                }
              },
            },
            AssistantNodeBoundary,
          )
          console.info(
            '[dsh-rich-response] 渲染器已注册（conversation.chat.node / assistant-step, priority -10）',
          )
        } catch (err) {
          // ⚠️ 不往外抛：若首次注册仍活着（例如宿主再次调用 factory），
          //   抛错会让宿主回退内建渲染器 → 插件全局失效。吞掉并视为已注册。
          console.warn(
            '[dsh-rich-response] slot 注册抛错（视为已注册，吞掉）:',
            err?.message ?? err,
          )
        }
        // ⚠️️ 2026-11-05 实测（DevTools 取证）：宿主把 inject factory 的**返回值**
        //   当作 dispose 回调，在**切换会话**时调用；且之后不再调用 factory。
        //   原先这里返回 ctx.slots.register 的注销句柄 → 切换会话 = 自己注销自己
        //   → 本进程内插件永久失效（内建接管，卡片消失，新会话也没有）。
        //   渲染器应对所有会话生效：返回 noop，不随会话切换注销。
        return () => {}
      })
    }

    // ─────────────────────────────────────────────────────────────
    // 渲染组件
    // ─────────────────────────────────────────────────────────────

    /**
     * 整个 assistant-step 的**最外层错误隔离**。
     *
     * 这是最后一道保险：即便上面的块级边界都漏了，
     * 也不会让宿主的 SlotErrorBoundary 接手（那会导致正文整片空白）。
     * 失败时退回宿主原生渲染 —— 宁可没有富渲染，也不能没有内容。
     */
    class AssistantNodeBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error(
          '[dsh-rich-response] 渲染器整体失败，退回宿主默认渲染:',
          error,
        )
      }

      render() {
        if (this.state.failed) {
          try {
            return renderHostFallback(this.props)
          } catch {
            return null
          }
        }
        return createElement(RichAssistantNodeView, this.props)
      }
    }

    /**
     * assistant-step 渲染器。
     *
     * 保留内置渲染器的全部外围逻辑（reasoning 折叠、tool-call 分组、图片画廊、
     * 文件提及、上下文菜单、turn-process 联动），只改一件事：
     * **text 块不再整段丢给 MarkdownText，而是先过一遍富渲染解析。**
     *
     * ⚠️ 宿主在 slot 外层套了 SlotErrorBoundary（dsh-client-ui-renderer）：
     *   渲染器一旦抛错，boundary 会渲染一个空的
     *   `<div data-slot-error="conversation.chat.node">`，
     *   **聊天区正文整片空白**，而侧栏/输入框等一切照常 —— 极难定位。
     *
     *   2026-11-05 就是这么翻车的：MarkdownText 少传 labels，
     *   渲染代码块时 `r.labels.code.copyLabel` 抛 TypeError，
     *   整条回复消失。
     *
     *   所以这里的铁律是：**渲染器内部绝不向外抛异常**。
     *   三层防护：块级边界 → 结构块边界 → 整节点边界，
     *   任何一层失败都降级到宿主原生渲染，而不是空白。
     */
    function RichAssistantNodeView(props) {
      const { node, groupPart } = props
      const data = node?.data

      // 诊断信标（只打一次）：2026-11-05「装了但看不出效果」排查教训 ——
      //   注册成功 ≠ 被宿主调用 ≠ 拿到的数据形状对。这三个环节此前全无痕迹，
      //   只能在 Console 里靠这一行区分。
      if (!RichAssistantNodeView.__beacon) {
        RichAssistantNodeView.__beacon = true
        try {
          console.info(
            '[dsh-rich-response] 首次渲染 assistant-step:',
            JSON.stringify({
              hasData: !!data,
              hasBlocks: Array.isArray(data?.blocks),
              kinds: Array.isArray(data?.blocks)
                ? data.blocks.map((b) => b?.kind).slice(0, 6)
                : null,
              status: data?.status,
              groupPart: groupPart ?? null,
            }),
          )
        } catch {
          /* 信标失败不影响渲染 */
        }
      }

      // 数据结构不认得 → 完全交给宿主（渲染 fallback）
      if (!data || !Array.isArray(data.blocks)) {
        return renderHostFallback(props)
      }

      const streaming = data.status === 'running'

      // 与内置 AssistantMarkdown 一致：只有 tool-call 头时不要画空壳
      const hasVisible =
        streaming ||
        data.status === 'interrupted' ||
        data.blocks.some((b) => b !== undefined && b.kind !== 'tool-call')
      if (!hasVisible) return null

      const rendered = []

      for (let i = 0; i < data.blocks.length; i++) {
        const block = data.blocks[i]
        if (block === undefined) continue

        // groupPart 分流 —— 与内置逻辑完全一致
        if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
        if (groupPart === 'response' && block.kind === 'reasoning') continue

        switch (block.kind) {
          case 'text': {
            rendered.push(
              createElement(TextBlockBoundary, {
                key: i,
                text: block.text,
                streaming,
                props,
              }),
            )
            break
          }

          case 'reasoning': {
            // ⚠️ 不能用 props.renderSlot('conversation.chat.reasoning.body')
            //   —— 我们不声明 children（避免与内建抢 seat），
            //   所以拿不到 renderSlot（standardKit: entry.children 才有 renderSlot）。
            //   改为自己用 primitives 的 DisclosureRow 画折叠行
            //   （与社区插件 dsh-markstream 同样的做法）。
            rendered.push(
              createElement(ReasoningDisclosure, {
                key: i,
                text: block.text,
                running: streaming && i === data.blocks.length - 1,
                props,
              }),
            )
            break
          }

          case 'image': {
            // ⚠️ 同样不能用 props.renderSlot('conversation.chat.message.images')
            //   —— 我们不声明 children，拿不到 renderSlot。
            //   且实测当前桌面版宿主里，这个子 slot **只有声明、没有实现提供者**
            //   （内建自己调 renderSlot 也是空的），所以图片在当前版本本就渲染不出来。
            //
            //   降级策略：用 primitives 的图片组件自己渲染附件缩略图，
            //   至少让用户看得到图，而不是彻底空白。
            const attachment = block.attachment
            if (attachment) {
              rendered.push(
                createElement(RichImageBlock, {
                  key: i,
                  attachment,
                  loadImage: props.loadImage,
                }),
              )
            }
            break
          }

          case 'tool-call':
            // 工具调用头由 ChatView 分组渲染成工具行，这里不画
            break

          default:
            // 未知块 → 宿主 JsonBlock 兜底，保持一致
            rendered.push(
              createElement(JsonBlock, {
                key: i,
                label: props.t?.('message.unknownBlock') ?? '未知内容',
                payload: block.block,
                truncatedLabel: (total) =>
                  props.t?.('json.truncated', { total }) ?? `已截断（共 ${total} 项）`,
              }),
            )
        }
      }

      return createElement(
        'div',
        { className: 'rr-root', 'data-streaming': streaming || undefined },
        rendered,
      )
    }

    // ─────────────────────────────────────────────────────────────
    // 推理块（自己画，不依赖子 slot）
    // ─────────────────────────────────────────────────────────────

    /**
     * 思考过程折叠行。
     *
     * 为什么自己画而不用宿主的 reasoning.body 子 slot：
     *   我们不声明 children（子 slot 声明权独占，重复声明会让注册抛错），
     *   拿不到 renderSlot。于是用 primitives 的 DisclosureRow 自己实现 ——
     *   与社区插件 dsh-markstream 同样的做法。
     *
     * 结构对齐宿主内建 ReasoningRow：
     *   - 折叠时显示摘要（流式中取最新完整段的首行，否则取首行）
     *   - 展开时显示全文（markdown 渲染）
     */
    function ReasoningDisclosure({ text, running, props }) {
      const [expanded, setExpanded] = useState(false)
      const t = props?.t

      if (typeof text !== 'string' || text.trim() === '') return null

      const summary = (running ? latestCompletedParagraphFirstLine(text) : firstLine(text))
        .replaceAll('**', '')
      const title = summary !== '' ? summary : t?.('row.running') ?? '思考中'

      return createElement(
        'div',
        { className: 'rr-reasoning' },
        createElement(
          DisclosureRow,
          {
            icon: createElement(IconThinkOutlineRegular, { size: 14 }),
            title,
            open: expanded,
            expandable: true,
            onToggle: () => setExpanded((v) => !v),
            running,
          },
          createElement(
            'div',
            { className: 'rr-reasoning-body' },
            renderHostText(text, running, props),
          ),
        ),
      )
    }

    /** 取首行（宿主 firstLine 的等价实现） */
    function firstLine(text) {
      const newline = text.indexOf('\n')
      return newline === -1 ? text : text.slice(0, newline)
    }

    /** 流式中取最新「完整段落」的首行（宿主 latestCompletedParagraphFirstLine 的简化等价） */
    function latestCompletedParagraphFirstLine(text) {
      const lines = text.split('\n')
      // 从后往前找最后一个非空行（跳过正在写入的残缺行）
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (line !== '') return line
      }
      return ''
    }

    // ─────────────────────────────────────────────────────────────
    // 图片块（自己画，不依赖子 slot）
    // ─────────────────────────────────────────────────────────────

    /**
     * 图片块降级渲染。
     *
     * 当前桌面版宿主里 'conversation.chat.message.images' 只有声明、没有实现，
     * 所以图片在本就渲染不出来。我们用最朴素的 <img> 兜住，
     * 至少让用户看得到图，而不是彻底空白。
     */
    function RichImageBlock({ attachment, loadImage }) {
      const src = resolveAttachmentSrc(attachment, loadImage)
      const alt = attachment?.name ?? attachment?.path ?? 'image'

      if (!src) {
        return createElement(
          'div',
          { className: 'rr-image rr-image-missing' },
          `[图片: ${alt}]`,
        )
      }

      return createElement('img', {
        className: 'rr-image',
        src,
        alt,
        loading: 'lazy',
      })
    }

    /** 从 attachment 里解析出可用的图片地址 */
    function resolveAttachmentSrc(attachment, loadImage) {
      if (!attachment) return undefined
      // 宿主 loadImage 可能返回一个 URL
      if (typeof loadImage === 'function') {
        try {
          const loaded = loadImage(attachment)
          if (typeof loaded === 'string') return loaded
          if (loaded && typeof loaded === 'object' && typeof loaded.src === 'string') {
            return loaded.src
          }
        } catch {
          /* 忽略，走下面的兜底 */
        }
      }
      // 直接用 attachment 上可能已有的地址字段
      for (const key of ['url', 'src', 'href', 'path']) {
        const v = attachment[key]
        if (typeof v === 'string' && v !== '') return v
      }
      return undefined
    }

    /**
     * 单个 text 块的**错误隔离**边界。
     *
     * ⚠️ 为什么必须用 ErrorBoundary 而不是 try/catch：
     *   React 的渲染错误发生在**子组件渲染阶段**，不是在 createElement 调用时。
     *   `try { createElement(MarkdownText, {...}) } catch {}` 里的 createElement
     *   只是构造元素描述对象，根本不会执行 MarkdownText 的函数体 ——
     *   真正的 TypeError 发生在 React 渲染 MarkdownText 时，
     *   try/catch 根本抓不到。
     *
     *   只有 class 组件的 getDerivedStateFromError 能拦住，
     *   并在渲染失败时渲染 fallback（这里退回宿主原生 markdown）。
     *
     * 为什么必须有这层：
     *   宿主在 slot 外套了 SlotErrorBoundary，一旦渲染器抛错，
     *   它会渲染一个空的 `<div data-slot-error="...">` ——
     *   **聊天区正文整片空白**，而侧栏、输入框等一切照常。
     *   2026-11-05 就是这么翻车的（MarkdownText 少传 labels）。
     */
    class TextBlockBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error(
          '[dsh-rich-response] text 块渲染失败，降级为普通 markdown:',
          error,
        )
      }

      render() {
        if (this.state.failed) {
          // 降级：退回宿主原生 markdown 渲染（不走富渲染路径）
          const { text, streaming, props } = this.props
          try {
            return renderHostText(text, streaming, props)
          } catch {
            return createElement('div', { className: 'rr-md' }, text)
          }
        }
        return createElement(RichTextBlock, this.props)
      }
    }

    /**
     * 结构块视图的错误隔离边界。
     *
     * 与 TextBlockBoundary 同理 —— 结构块里调用的是宿主 MarkdownText，
     * 渲染错误同样只能靠 boundary 拦。
     */
    class BlockViewBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error(
          '[dsh-rich-response] 结构块渲染失败，降级为普通 markdown:',
          error,
        )
      }

      render() {
        if (this.state.failed) {
          const { block, props } = this.props
          try {
            return createElement(
              'div',
              { className: 'rr-md' },
              renderHostText(block.raw, false, props),
            )
          } catch {
            return createElement('div', { className: 'rr-md' }, block.raw)
          }
        }
        return createElement(BlockView, this.props)
      }
    }

    /**
     * 单个 text 块 —— 富渲染核心。
     *
     * 策略：
     *   1. 解析出结构块 → 结构块用卡片渲染，普通段落用 MarkdownText
     *   2. 整段都是普通 markdown → 直接交给宿主 MarkdownText（零开销，走宿主优化路径）
     *   3. 解析异常 → 交回宿主
     */
    function RichTextBlock({ text, streaming, props }) {
      let segments
      try {
        segments = parseRich(text)
      } catch {
        return renderHostText(text, streaming, props)
      }

      const hasBlock = segments.some((s) => s.kind === 'block')

      // 渲染完全协议驱动：只有模型明确输出 ::: 围栏才出卡片。
      // 2026-11-05 曾加过「自动改写」，把普通表格 / 列表硬转成卡片；
      // 实测效果生硬（纯文本渲染、行内代码反引号外露），已按用户要求移除。
      // 绝不对普通 markdown 做自动改写 —— 那会破坏宿主原生排版。

      // 无结构块 —— 仍走宿主原生 markdown，只额外识别 S 族语义块（GitHub Alerts）。
      // 没有语义块时 MarkdownWithAlerts 直通 renderHostText，性能与行为不变。
      if (!hasBlock) {
        return createElement(MarkdownWithAlerts, { text, streaming, props })
      }

      return createElement(
        'div',
        { className: 'rr-rich' },
        segments.map((seg, i) =>
          seg.kind === 'block'
            ? createElement(BlockViewBoundary, { key: `b${i}`, block: seg.block, props })
            : createElement(
                'div',
                { key: `m${i}`, className: 'rr-md' },
                createElement(MarkdownWithAlerts, {
                  text: seg.content,
                  streaming,
                  props,
                }),
              ),
        ),
      )
    }

    /**
     * 构造 MarkdownText 的 pathImages prop。
     *
     * 宿主内建（AssistantMarkdown.tsx）：
     *   const pathImages = { resolve: (value) => localPathMediaUrl(document.baseURI, value) }
     * 而 localPathMediaUrl → fileMediaUrl(base, path)：
     *   - base 不是 http(s)/dsh-app:// 时不解析
     *   - path 必须是工作区绝对路径
     *   - 结果是 new URL(`api/file?path=...`, base).href
     *
     * 这两个函数都在 chat 包内部，插件拿不到 —— 这里按同样规则等价实现。
     * 缺失不会崩（宿主 rU 里是 `t?.resolve(e)` 可选链），
     * 但图片会退化成 alt 文本，所以照样补上。
     */
    function buildPathImages() {
      return {
        resolve: (value) => {
          let path
          try {
            path = decodeURIComponent(value.split(/[?#]/u)[0] ?? '')
          } catch {
            return undefined
          }
          const base = typeof document !== 'undefined' ? document.baseURI : ''
          if (!base) return undefined
          if (!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/')) return undefined
          if (!isAbsoluteWorkspacePath(path)) return undefined
          if (/^[/\\]{2}/u.test(path)) return undefined
          if (/[\u0000-\u001f\u007f]/u.test(path)) return undefined
          return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
        },
      }
    }

    /** 工作区绝对路径判定（等价于宿主的 isAbsoluteWorkspacePath） */
    function isAbsoluteWorkspacePath(path) {
      if (typeof path !== 'string' || path.length === 0) return false
      // Windows 盘符（C:\ / C:/）或 UNC 前缀
      if (/^[A-Za-z]:[\\/]/u.test(path)) return true
      // POSIX 绝对路径
      if (path.startsWith('/')) return true
      return false
    }

    /** 用宿主 MarkdownText 渲染一段 markdown */
    function renderHostText(text, streaming, props) {
      if (typeof text !== 'string' || text.length === 0) return null
      return createElement(MarkdownText, {
        text,
        streaming,
        // ⚠️ labels 是**必需** prop，不能省！
        //   宿主渲染代码块时执行 `r.labels.code.copyLabel`（web bundle 实测），
        //   labels 为 undefined 会抛
        //     TypeError: Cannot read properties of undefined (reading 'code')
        //   React 随即卸载整棵 assistant-step 子树 →
        //   **聊天区正文整片空白**（2026-11-05 实测到的真实故障）。
        //
        //   labels 结构由宿主 markdown-labels.ts 的 markdownLabels(t) 决定：
        //   { code: { copyLabel, copiedLabel, toolbarLabels:{codeLabel,wrapLabel,unwrapLabel} },
        //     footnotes }
        labels: buildMarkdownLabels(props?.t),
        fileMentions: props?.fileMentions,
        pathImages: props?.pathImages ?? buildPathImages(),
        // 与内建一致：settled 且有 finalNode.messageId 才算可交互文本
        textInteractionSource:
          props?.node?.data?.status === 'settled' &&
          props?.node?.data?.finalNode?.messageId !== undefined,
      })
    }

    // ─────────────────────────────────────────────────────────────
    // 行内 markdown（加粗 / 行内代码 / 斜体 / 删除线 / 链接）
    //
    // 协议 §4.1：结构块正文只允许「段落级 / 行内」markdown。
    // 宿主 MarkdownText 是段落级渲染器（会产出 <p>），塞进表格单元格
    // 会破坏表格结构，所以单元格、要点标题走这个轻量行内渲染器；
    // 整段正文（结论卡正文 / 分栏）仍交给宿主 MarkdownText。
    //
    // ⚠️ 2026-11-05：此前这些位置直接把原始字符串当纯文本渲染，
    //   回复里出现 `代码` 与 **加粗** 时反引号和星号会原样外露。
    // ─────────────────────────────────────────────────────────────

    const INLINE_RE =
      /(`[^`\n]+`)|(\*\*(?:[^*\n]|\*(?!\*))+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))/g
    const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/
    const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:|\/|#)/i

    function renderInline(text) {
      const src = typeof text === 'string' ? text : text == null ? '' : String(text)
      if (!src) return src
      if (
        src.indexOf('`') === -1 &&
        src.indexOf('*') === -1 &&
        src.indexOf('_') === -1 &&
        src.indexOf('~') === -1 &&
        src.indexOf('[') === -1
      ) {
        return src
      }

      let out = null
      let last = 0
      let m
      INLINE_RE.lastIndex = 0
      while ((m = INLINE_RE.exec(src)) !== null) {
        if (m.index > last) {
          out = out || []
          out.push(src.slice(last, m.index))
        }
        const token = m[0]
        const key = `i${m.index}`
        let node = null
        if (token.charCodeAt(0) === 96) {
          node = createElement('code', { key, className: 'rr-inline-code' }, token.slice(1, -1))
        } else if (token.startsWith('**') || token.startsWith('__')) {
          node = createElement('strong', { key }, renderInline(token.slice(2, -2)))
        } else if (token.startsWith('~~')) {
          node = createElement('del', { key }, renderInline(token.slice(2, -2)))
        } else if (token.startsWith('*')) {
          node = createElement('em', { key }, renderInline(token.slice(1, -1)))
        } else {
          const lm = LINK_RE.exec(token)
          const href = lm ? lm[2] : ''
          if (lm && SAFE_HREF_RE.test(href)) {
            node = createElement(
              'a',
              { key, href, className: 'rr-inline-link', target: '_blank', rel: 'noopener noreferrer' },
              renderInline(lm[1]),
            )
          } else {
            // 不安全的链接（javascript: 等）整体退回纯文本，绝不过滤后拼 HTML
            node = token
          }
        }
        out = out || []
        out.push(node)
        last = m.index + token.length
      }

      if (out === null) return src
      if (last < src.length) out.push(src.slice(last))
      return out
    }

    // ─────────────────────────────────────────────────────────────
    // S 族 · 语义块（GitHub Alerts）
    //
    // 协议 §3：NOTE / TIP / WARNING / IMPORTANT 必须映射到
    // info / success / warn / danger；未知类型降级为 NOTE 样式并记 warning。
    // 语义块原先只有 parser 里的识别函数、渲染层从未调用（死代码）；
    // 现在在普通 markdown 路径上切分渲染，其余文本仍交宿主 MarkdownText。
    // ─────────────────────────────────────────────────────────────

    const SEMANTIC_CARD_TONE = {
      note: 'info',
      tip: 'success',
      warning: 'warn',
      important: 'danger',
      unknown: 'info',
    }
    const warnedSemanticLabels = new Set()

    function SemanticCard({ alert, props }) {
      const tone = SEMANTIC_CARD_TONE[alert.kind] || 'info'
      if (alert.kind === 'unknown' && !warnedSemanticLabels.has(alert.label)) {
        warnedSemanticLabels.add(alert.label)
        console.warn(
          '[dsh-rich-response] 未定义的语义块类型，按 NOTE 样式降级渲染:',
          alert.label,
        )
      }
      return createElement(
        'div',
        { className: `rr-card rr-alert rr-tone-${tone}` },
        createElement('div', { className: 'rr-card-title' }, alert.label),
        createElement(
          'div',
          { className: 'rr-card-body rr-md' },
          renderHostText(alert.content, false, props),
        ),
      )
    }

    /**
     * 把一段 markdown 按 S 族语义块切开渲染；没有语义块时零开销直通宿主。
     * 返回单个 host 元素或元素数组（React 与测试用的假渲染器都支持）。
     */
    function MarkdownWithAlerts({ text, streaming, props }) {
      let alerts = []
      try {
        alerts = detectSemantic(text)
      } catch {
        alerts = []
      }
      if (!Array.isArray(alerts) || alerts.length === 0) {
        return renderHostText(text, streaming, props)
      }

      const pieces = []
      let cursor = 0
      alerts.forEach((alert, i) => {
        if (alert.start > cursor) {
          pieces.push(
            createElement(
              'div',
              { key: `t${i}`, className: 'rr-md' },
              renderHostText(text.slice(cursor, alert.start), streaming, props),
            ),
          )
        }
        pieces.push(createElement(SemanticCard, { key: `a${i}`, alert, props }))
        cursor = alert.end
      })
      const tail = text.slice(cursor)
      if (tail.trim()) {
        pieces.push(
          createElement(
            'div',
            { key: 'tail', className: 'rr-md' },
            renderHostText(tail, streaming, props),
          ),
        )
      }
      return createElement('div', { className: 'rr-rich rr-alerts' }, pieces)
    }

    /**
     * 构造 MarkdownText 的 labels prop。
     *
     * 宿主内建的 markdownLabels(t) 走 `t` 翻译函数取文案；
     * 我们同样按 chat 命名空间的 key 取，取不到时回退到英文默认文案 ——
     * **绝不能返回 undefined**，否则代码块渲染会崩掉整个回复区。
     */
    function buildMarkdownLabels(t) {
      const tr = (key, fallback) => {
        try {
          const v = typeof t === 'function' ? t(key) : undefined
          return typeof v === 'string' && v.length > 0 ? v : fallback
        } catch {
          return fallback
        }
      }
      return {
        code: {
          copyLabel: tr('copy', '复制'),
          copiedLabel: tr('copied', '已复制'),
          toolbarLabels: {
            codeLabel: tr('codeBlock.title', '代码'),
            wrapLabel: tr('codeBlock.wrap', '自动换行'),
            unwrapLabel: tr('codeBlock.unwrap', '取消换行'),
          },
        },
        footnotes: tr('markdown.footnotes', '脚注'),
      }
    }

    /**
     * 完全交给宿主渲染（最后兜底）。
     *
     * 这是富渲染彻底失败时的退路，**它自己绝不能抛错** ——
     * 否则会一路冒泡到宿主的 SlotErrorBoundary，正文再次整片空白。
     * 所以这里连 createElement 都在 try 里。
     */
    function renderHostFallback(props) {
      try {
        const data = props?.node?.data
        if (data && Array.isArray(data.blocks)) {
          // 结构认识但内容不对，尽量用宿主的 text 块
          const text = data.blocks
            .filter((b) => b?.kind === 'text')
            .map((b) => b.text)
            .join('\n')
          return renderHostText(text, data.status === 'running', props)
        }
        return null
      } catch (err) {
        console.error('[dsh-rich-response] 宿主 fallback 也失败:', err)
        // 最后的最后：直接吐纯文本，宁可丑也不能空
        try {
          const data = props?.node?.data
          const text =
            data && Array.isArray(data.blocks)
              ? data.blocks
                  .filter((b) => b?.kind === 'text')
                  .map((b) => b.text)
                  .join('\n')
              : ''
          return text ? createElement('div', { className: 'rr-md' }, text) : null
        } catch {
          return null
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 结构块视图
    // ─────────────────────────────────────────────────────────────

    /**
     * 结构块渲染。
     * level ≥ 2 → 结构非法或未闭合，按普通 markdown 渲染，不给用户任何错误提示。
     */
    function BlockView({ block, props }) {
      if (block.level >= 2) {
        return createElement(
          'div',
          { className: 'rr-md' },
          createElement(MarkdownWithAlerts, { text: block.raw, streaming: false, props }),
        )
      }

      switch (block.type) {
        case 'summary':
          return createElement(SummaryCard, { block, props })
        case 'points':
          return createElement(PointsGroup, { block, props })
        case 'table':
          return createElement(TableBlock, { block, props })
        case 'steps':
          return createElement(StepsFlow, { block, props })
        case 'columns':
          return createElement(ColumnsBlock, { block, props })
        default:
          return createElement(
            'div',
            { className: 'rr-md' },
            createElement(MarkdownWithAlerts, { text: block.raw, streaming: false, props }),
          )
      }
    }

    /**
     * 卡片 / 分栏正文 —— 段落级 markdown + S 族语义块。
     * 宿主 MarkdownText 负责段落排版，语义块由 MarkdownWithAlerts 切出来。
     */
    function renderBody(raw, props) {
      return createElement(MarkdownWithAlerts, { text: raw, streaming: false, props })
    }

    function SummaryCard({ block, props }) {
      const tone = block.attrs.tone || 'info'
      return createElement(
        'div',
        { className: `rr-card rr-tone-${tone}` },
        createElement(
          'div',
          { className: 'rr-card-title' },
          renderInline(block.attrs.title || '结论'),
        ),
        createElement('div', { className: 'rr-card-body rr-md' }, renderBody(block.raw, props)),
      )
    }

    function PointsGroup({ block, props }) {
      const items = parsePoints(block.raw)
      if (items.length === 0) {
        return createElement('div', { className: 'rr-md' }, renderBody(block.raw, props))
      }
      return createElement(
        'div',
        { className: 'rr-points', style: { '--rr-cols': String(block.attrs.cols || '3') } },
        items.map((it, i) =>
          createElement(
            'div',
            { key: i, className: 'rr-point' },
            createElement('div', { className: 'rr-point-title' }, renderInline(it.title)),
            it.desc
              ? createElement('div', { className: 'rr-point-desc' }, renderInline(it.desc))
              : null,
          ),
        ),
      )
    }

    function TableBlock({ block, props }) {
      const rows = parseTable(block.raw)
      if (rows.length === 0) {
        return createElement('div', { className: 'rr-md' }, renderBody(block.raw, props))
      }
      const [head, ...body] = rows
      return createElement(
        'div',
        { className: 'rr-table-wrap' },
        block.attrs.title
          ? createElement('div', { className: 'rr-table-title' }, renderInline(block.attrs.title))
          : null,
        createElement(
          'table',
          { className: 'rr-table' },
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              head.map((c, i) => createElement('th', { key: i }, renderInline(c))),
            ),
          ),
          createElement(
            'tbody',
            null,
            body.map((row, ri) =>
              createElement(
                'tr',
                { key: ri },
                row.map((c, ci) => createElement('td', { key: ci }, renderInline(c))),
              ),
            ),
          ),
        ),
      )
    }

    function StepsFlow({ block, props }) {
      const items = parseSteps(block.raw)
      if (items.length === 0) {
        return createElement('div', { className: 'rr-md' }, renderBody(block.raw, props))
      }
      return createElement(
        'div',
        { className: 'rr-steps' },
        block.attrs.title
          ? createElement('div', { className: 'rr-steps-title' }, renderInline(block.attrs.title))
          : null,
        block.attrs.ordered
          ? createElement('div', { className: 'rr-steps-sub' }, renderInline(block.attrs.ordered))
          : null,
        createElement(
          'ol',
          { className: 'rr-steps-list' },
          items.map((it, i) =>
            createElement(
              'li',
              { key: i, className: 'rr-step' },
              createElement('div', { className: 'rr-step-title' }, renderInline(it.title)),
              it.desc
                ? createElement('div', { className: 'rr-step-desc' }, renderInline(it.desc))
                : null,
            ),
          ),
        ),
      )
    }

    function ColumnsBlock({ block, props }) {
      const cols = splitColumns(block.raw)
      if (cols.length !== 2) {
        return createElement('div', { className: 'rr-md' }, renderBody(block.raw, props))
      }
      // 长文分栏会把两段密集正文硬挤成两窄列（2026-11-05 用户实测：文字快挤出屏幕）。
      // 分栏只适合短对照；正文超过阈值就退回单列，中间分隔线保留。
      const tooLong = cols.some((col) => {
        const plain = col.replace(/[#>*`|\-\s]/g, '')
        return plain.length > 160 || (col.match(/\n/g) || []).length > 6
      })
      return createElement(
        'div',
        { className: tooLong ? 'rr-columns rr-columns-stacked' : 'rr-columns' },
        cols.map((col, i) =>
          createElement(
            'div',
            { key: i, className: 'rr-col' },
            createElement('div', { className: 'rr-md' }, renderBody(col, props)),
          ),
        ),
      )
    }

    // ─────────────────────────────────────────────────────────────
    // 块内部结构解析
    //
    // parsePoints / parseSteps / splitColumns 由内联的协议解析器提供
    // （见下方 __INJECT_PARSER__ 段），此处不重复定义 —— 避免两份实现漂移。
    // parseTable 是渲染层专有的（解析器里对应的是 isValidTable）。
    // ─────────────────────────────────────────────────────────────

    function parseTable(raw) {
      const lines = raw.split('\n').filter((l) => l.trim())
      if (lines.length < 2) return []
      const rows = []
      for (let i = 0; i < lines.length; i++) {
        if (i === 1 && /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/.test(lines[i])) continue
        rows.push(
          lines[i]
            .replace(/^\s*\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map((c) => c.trim()),
        )
      }
      return rows
    }

    // ─────────────────────────────────────────────────────────────
    // 协议解析（内联副本 —— 宿主模块表不支持相对 require）
    //
    // 与 src/parser.js 保持一致。tests/verify-build.mjs 会断言
    // 两份实现的解析行为一致，防止源码漂移。
    // ─────────────────────────────────────────────────────────────

    /* __INJECT_PARSER__ */

    return {
      name: 'dsh-rich-response',
      inject: ['slots'],
      apply,
    }
  },
})
