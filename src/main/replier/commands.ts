// Assistant 侧命令（对位 Python AssistantReplier.list_commands）：
// 命令由 replier 层自述，ChatManager 只负责注册进 per-chat registry。
// spec 与 handler 同源定义；spec 单独导出，供 Telegram 命令菜单静态枚举。

import type { AgentRuntime } from '../agents/types'
import type { Command, CommandSpec } from '../core/commands'

const SPECS = {
  new: { name: 'new', description: '开启新会话', gated: false },
  model: { name: 'model', description: '查看或切换模型（/model 或 /model <value>）', gated: true },
} satisfies Record<string, CommandSpec>

/** per-chat assistant 命令的静态名单（无需 runtime 实例即可枚举） */
export const ASSISTANT_COMMAND_SPECS: CommandSpec[] = Object.values(SPECS)

export function assistantCommands(runtime: AgentRuntime, instruction: string): Command[] {
  return [
    {
      ...SPECS.new,
      handler: async () => {
        await runtime.newSession(instruction)
        return 'ok'
      },
    },
    {
      ...SPECS.model,
      handler: async (_ctx, args) => {
        const value = args[0]
        if (value === undefined) {
          const [current, options] = await Promise.all([runtime.currentModel(), runtime.listModels()])
          if (options.length === 0) {
            return `current: ${current ?? '(agent 默认)'}\n\n（拿不到模型候选——可在 assistant 配置的 models 里手动指定）`
          }
          const lines = options.map((option) => {
            const label = option.name === option.value ? option.value : `${option.value}（${option.name}）`
            return option.description === undefined ? label : `${label}：${option.description}`
          })
          return `current: ${current ?? '(agent 默认)'}\n\n${lines.join('\n')}\n\n切换：/model <value>`
        }
        const ok = await runtime.setModel(value)
        return ok ? 'ok（新会话已生效）' : 'failed：不在候选列表内'
      },
    },
  ]
}
