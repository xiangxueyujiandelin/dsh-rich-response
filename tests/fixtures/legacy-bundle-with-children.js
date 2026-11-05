/**
 * 冻结的故障样本：2026-11-05 14:25 那份 bundle（原提交 ea58b16）的最小等价复现。
 *
 * 这不是可执行插件，只被 tests/register-seam.mjs 读成字符串丢进 vm 里跑。
 *
 * 为什么冻结而不是 `git show ea58b16:lib/client.js`：
 *   - 仓库重建过，ea58b16 已不存在，那条断言会静默跳过、套件照样报绿；
 *   - 这个文件永不变，所以「注册期崩溃」的根因被钉死，HEAD 怎么前移都不影响。
 *
 * 复现的正是白屏根因：在 register 的 spec 里声明 children，
 * 而内置 assistant-step entry 已经声明过同名的两个子 slot（声明权独占）→
 * 宿主 slots.register 在注册期抛出 `slot "..." is already declared`。
 *
 * 这里不照抄原 bundle 里的 try/catch：原始版本是否吞掉这个异常，
 * 决定它表现成「抛错」还是「静默没有渲染器」—— 两种结局都是整片空白。
 * 样本保留异常外抛，是为了让断言直接盯住宿主规则本身。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rich-response',
  factory: (require) => {
    const { createElement } = require('react')

    function LegacyAssistantNodeView(props) {
      return createElement(
        'div',
        { className: 'rr-root' },
        props?.node?.data?.blocks?.[0]?.text ?? '',
      )
    }

    function apply(ctx) {
      // 与真实插件同构：register 发生在 inject 的 factory 里（宿主惰性调用）
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.node',
            key: 'assistant-step',
            locale: 'conversation',
            priority: -10,
            children: {
              'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
              'conversation.chat.message.images': { kind: 'single', scope: 'session' },
            },
          },
          LegacyAssistantNodeView,
        ),
      )
    }

    return { name: 'dsh-rich-response', inject: ['slots'], apply }
  },
})
