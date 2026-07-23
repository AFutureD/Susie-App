import { z } from 'zod'

// 配置领域模型（对位 Python 版 susie.settings / susie_core）。
// 字段名保持 snake_case 以兼容既有 config.toml。

export const DEFAULT_ASSISTANT_ID = 'default'
/** binding.chat_ids 与白名单中的通配符 */
export const CHAT_ALL = '*'

/** channel/assistant 的 id 同时用作 ConfigRef 的 path 片段，禁止 `.` 等分隔符 */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** 思考深度候选（对齐 codex ModelReasoningEffort；ACP agent 暂不支持时忽略） */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const telegramBotChannelSchema = z.strictObject({
  type: z.literal('telegram_bot'),
  token: z.string().min(1, 'token 不能为空'),
  /** 运行开关：false 时通道不启动（UI 启停按钮写此字段） */
  enabled: z.boolean().default(true),
  drop_pending_updates: z.boolean().default(false),
})

/** 未来扩展通道类型时加入该 discriminated union */
export const channelSettingsSchema = z.discriminatedUnion('type', [telegramBotChannelSchema])

export const assistantSchema = z.strictObject({
  id: z.string().regex(ID_PATTERN, 'id 只能包含字母、数字、_ 和 -'),
  agent_id: z.string().min(1).default('codex'),
  work_dir: z.string().optional(),
  forward_to: z.string().optional(),
  /** 当前模型；空表示 agent 默认 */
  model: z.string().optional(),
  /** 思考深度；空表示 agent 默认（目前仅 codex 生效） */
  thinking_level: z.enum(THINKING_LEVELS).optional(),
  /** /model 命令的候选白名单（legacy：仅保留手改 config.toml 的兼容，UI 不再暴露） */
  models: z.array(z.string()).optional(),
  /** 指令模板覆盖（nunjucks；缺省用内置 SYSTEM 模板） */
  instruction: z.string().optional(),
})

/**
 * 绑定即准入：一条 = 一个会话（chat_id 为 CHAT_ALL 时表示「该通道其余会话」的默认）。
 * 没有任何绑定命中的会话不响应（禁止）——不存在全局兜底。
 */
export const bindingSchema = z.strictObject({
  channel: z.string().min(1),
  /** 缺省 '*' = 该通道默认（手写 TOML 的省写） */
  chat_id: z.string().min(1).default(CHAT_ALL),
  assistant_id: z.string().min(1),
  /** 群会话生效：仅响应 @ 提及 */
  only_mention: z.boolean().default(true),
  /** 群会话生效：可触发的成员 user id；空 = 所有成员 */
  members: z.array(z.string()).default([]),
})

export const configSchema = z
  .strictObject({
    channels: z
      .record(z.string().regex(ID_PATTERN, 'channel id 只能包含字母、数字、_ 和 -'), channelSettingsSchema)
      .default({}),
    assistants: z.array(assistantSchema).default([{ id: DEFAULT_ASSISTANT_ID, agent_id: 'codex' }]),
    bindings: z.array(bindingSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const ids = config.assistants.map((a) => a.id)
    const idSet = new Set(ids)
    if (ids.length !== idSet.size) {
      ctx.addIssue({ code: 'custom', path: ['assistants'], message: 'assistant id 必须唯一' })
    }
    config.bindings.forEach((binding, index) => {
      if (!idSet.has(binding.assistant_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'assistant_id'],
          message: `未知的 assistant id: ${binding.assistant_id}`,
        })
      }
    })
  })

export type TelegramBotChannelSettings = z.infer<typeof telegramBotChannelSchema>
export type ChannelSettings = z.infer<typeof channelSettingsSchema>
export type AssistantConfig = z.infer<typeof assistantSchema>
export type ChatBinding = z.infer<typeof bindingSchema>
export type Config = z.infer<typeof configSchema>

/** 推给 UI / IPC 的配置状态快照 */
export interface ConfigState {
  /** 每次生效的配置变更 +1；乐观并发控制的依据 */
  version: number
  configPath: string
  config: Config
  /** 最近一次加载失败的原因（此时 config 为 last-good），null 表示健康 */
  lastError: string | null
  /** 本次加载时被忽略的 legacy 内容说明（api_id / telegram_user 通道等） */
  migrations: string[]
}

export type ConfigMutationResult = { ok: true; state: ConfigState } | { ok: false; message: string; conflict: boolean }
