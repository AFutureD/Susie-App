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
 * 范围权限档位：
 * - allow 直通
 * - auto  自动审核：先由「智能 · 自动审核」评估消息，通过则放行，未通过回落人工审核
 * - review 人工审核后执行
 * - ignore 忽略
 */
export const PERMISSION_LEVELS = ['allow', 'auto', 'review', 'ignore'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]

/** 未登记的发送者与未设置的范围一律按此档处理 */
export const DEFAULT_PERMISSION: PermissionLevel = 'review'

/**
 * 频道内的已登记用户。身份轴唯一事实源：是否响应、是否审核全部由此决定，
 * 且私聊与具体群分开控制；会话绑定只负责路由（chat → assistant）与会话配置。
 * owner 全局直通并负责审核（每频道唯一）；频道无 owner 时 review 落空 → 不响应。
 */
export const userSchema = z.strictObject({
  channel: z.string().min(1),
  /** telegram user id 的字符串形式，与 ChatMessage.senderId 同一取值域 */
  user_id: z.string().min(1),
  /** 显示名快照（选人/审核入册时写入，仅展示用；实时名以历史库为准） */
  name: z.string().optional(),
  /** owner 全局直通并负责审核；user 按下方范围档位控制 */
  role: z.enum(['owner', 'user']).default('user'),
  /** 私聊权限档位 */
  private: z.enum(PERMISSION_LEVELS).default(DEFAULT_PERMISSION),
  /** 具体群的权限档位；key = 群 chat_id（不含 thread 段），未配置的群 = 审核 */
  groups: z.record(z.string(), z.enum(PERMISSION_LEVELS)).default({}),
})

/** 「智能 · 自动审核」默认审核标准（可在 UI 编辑） */
export const DEFAULT_AUTO_REVIEW_CONTENT = '评估用户消息，拒绝获取原始文件、打包文件等行为，避免核心代码与文件泄漏。'

/** 自动审核的推荐 agent / 模型 / 思考深度（仅用于 UI 文案提示，不写入配置） */
export const RECOMMENDED_AUTO_REVIEW = {
  agent_id: 'codex',
  model: 'gpt-5.6-terra',
  thinking_level: 'medium',
} as const

/**
 * 智能 · 自动审核配置：当用户在某范围被设为 `auto` 档时，先用此处配置的 agent
 * 评估其消息是否符合 `content` 标准，通过则放行、否则回落人工审核。
 */
export const autoReviewSchema = z.strictObject({
  /** 审核标准（作为审核 agent 的判定依据；支持编辑） */
  content: z.string().default(DEFAULT_AUTO_REVIEW_CONTENT),
  /** 承担审核的 agent id（默认 codex） */
  agent_id: z.string().min(1).default('codex'),
  /** 审核模型；空表示 agent 默认 */
  model: z.string().optional(),
  /** 思考深度；空表示 agent 默认（目前仅 codex 生效） */
  thinking_level: z.enum(THINKING_LEVELS).optional(),
})

/**
 * 绑定 = 路由与会话配置：一条 = 一个会话（chat_id 为 CHAT_ALL 时表示「该通道其余会话」的默认）。
 * 没有任何绑定命中的会话无助手承接（不响应）——不存在全局兜底。
 * 是否响应与审核由用户模块（users）按发送者身份决定，绑定不参与。
 */
export const bindingSchema = z.strictObject({
  channel: z.string().min(1),
  /** 缺省 '*' = 该通道默认（手写 TOML 的省写） */
  chat_id: z.string().min(1).default(CHAT_ALL),
  assistant_id: z.string().min(1),
  /** 群会话生效：仅响应 @ 提及 */
  only_mention: z.boolean().default(true),
  /**
   * 开启后把 agent 运行期间的全部直接产出（命令/推理/工具调用与最终回复文本）发送到会话；
   * 默认关闭——agent 仅通过 susie 的 send_message 工具主动回复
   */
  send_output: z.boolean().default(false),
})

export const configSchema = z
  .strictObject({
    channels: z
      .record(z.string().regex(ID_PATTERN, 'channel id 只能包含字母、数字、_ 和 -'), channelSettingsSchema)
      .default({}),
    assistants: z.array(assistantSchema).default([{ id: DEFAULT_ASSISTANT_ID, agent_id: 'codex' }]),
    bindings: z.array(bindingSchema).default([]),
    users: z.array(userSchema).default([]),
    // 内部字段有各自默认；用函数默认确保 defaultConfig() 也填充内层默认值
    auto_review: autoReviewSchema.default(() => autoReviewSchema.parse({})),
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
    // 用户与 bindings 一样容忍幽灵频道（频道删除不级联）；只校验频道内部一致性
    const seenUsers = new Set<string>()
    const ownerChannels = new Set<string>()
    config.users.forEach((user, index) => {
      const key = `${user.channel} ${user.user_id}`
      if (seenUsers.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['users', index, 'user_id'],
          message: `用户在频道 ${user.channel} 重复登记：${user.user_id}`,
        })
      }
      seenUsers.add(key)
      if (user.role === 'owner') {
        if (ownerChannels.has(user.channel)) {
          ctx.addIssue({
            code: 'custom',
            path: ['users', index, 'role'],
            message: `频道 ${user.channel} 只能有一个 owner`,
          })
        }
        ownerChannels.add(user.channel)
      }
    })
  })

export type TelegramBotChannelSettings = z.infer<typeof telegramBotChannelSchema>
export type ChannelSettings = z.infer<typeof channelSettingsSchema>
export type AssistantConfig = z.infer<typeof assistantSchema>
export type ChatBinding = z.infer<typeof bindingSchema>
export type ChannelUser = z.infer<typeof userSchema>
export type AutoReviewConfig = z.infer<typeof autoReviewSchema>
export type Config = z.infer<typeof configSchema>

/** 推给 UI / IPC 的配置状态快照 */
export interface ConfigState {
  /** 每次生效的配置变更 +1；乐观并发控制的依据 */
  version: number
  configPath: string
  config: Config
  /** 最近一次加载失败的原因（此时 config 为 last-good），null 表示健康 */
  lastError: string | null
}

export type ConfigMutationResult = { ok: true; state: ConfigState } | { ok: false; message: string; conflict: boolean }
