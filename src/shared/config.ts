import { z } from 'zod'
import { decodeChatId } from './chat-id'
import { parseCron } from './schedule'

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

/**
 * Manager bot（渠道管理，不是渠道）：经 BotFather 开启 Bot Management Mode 的 bot，
 * 常驻监听 managed_bot 事件、代取被管 bot 的 token。不参与会话循环（消息 record-only 入历史），
 * 不可作为 bindings / scheduled_tasks 目标；无 enabled——存在即运行，删除即停。
 */
export const managerBotSchema = z.strictObject({
  token: z.string().min(1, 'token 不能为空'),
  /** 经「添加托管 Bot」流程落地的渠道 id 列表（自动维护，手改合法）；引用不校验，渠道删除时同步剔除 */
  managing: z.array(z.string()).default([]),
})

export const assistantSchema = z.strictObject({
  id: z.string().regex(ID_PATTERN, 'id 只能包含字母、数字、_ 和 -'),
  /** 展示名；缺省时 UI 统一回退 id（name ?? id） */
  name: z.string().optional(),
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
 * 是否响应由 respond 决定（精确命中优先于通道默认）；没有任何绑定命中、
 * 或解析不到助手（精确绑定未指定且通道无默认）的会话不响应——不存在全局兜底。
 * 发送者层面的响应与审核由用户模块（users）按身份决定，绑定不参与。
 */
export const bindingSchema = z.strictObject({
  channel: z.string().min(1),
  /** 缺省 '*' = 该通道默认（手写 TOML 的省写）；channel（C:*）不允许作为绑定目标——bot 不参与 channel 的会话循环 */
  chat_id: z
    .string()
    .min(1)
    .default(CHAT_ALL)
    .refine((value) => decodeChatId(value)?.chatType !== 'channel', 'channel 不能作为绑定目标'),
  /** 通道默认（chat_id='*'）必填（superRefine）；精确会话可缺省 = 跟随通道默认助手 */
  assistant_id: z.string().min(1).optional(),
  /** 是否响应；缺省 true——老配置（无此字段）保持「绑定存在即响应」的行为 */
  respond: z.boolean().default(true),
  /** 群会话生效：仅响应 @ 提及 */
  only_mention: z.boolean().default(true),
  /**
   * 开启后把 agent 运行期间的全部直接产出（命令/推理/工具调用与最终回复文本）发送到会话；
   * 默认关闭——agent 仅通过 susie 的 send_message 工具主动回复
   */
  send_output: z.boolean().default(false),
})

/** 定时任务的投递目标；chat_id 编码同 bindings（P:/G:/S: 前缀），不允许通配 */
export const taskTargetSchema = z.strictObject({
  channel: z.string().min(1),
  chat_id: z
    .string()
    .min(1)
    .refine((value) => value !== CHAT_ALL, 'chat_id 不能为 *'),
})

/**
 * 定时任务引用的技能：值 = 技能目录名，执行时按 assistant 的支持目录现场解析
 * （工作目录优先于全局 × agent 支持的容器目录），缺失记 error 执行记录——
 * 与 assistant 缺失同型，不做 schema 级校验。
 */
export const taskSkillSchema = z.string().min(1, 'skill 名称不能为空')

/**
 * 定时任务：到点用 assistant 执行一次 content，结果由 agent 经 susie MCP send_message
 * 发送到 targets（可附带文件）；agent 未发送任何消息时，调度器把最终输出兜底投递到全部 targets。
 * schedule 为标准 5 字段 cron（分 时 日 月 周，本地时区）；UI 用预设控件生成/反解析，
 * 不直接暴露表达式。错过的点位（睡眠/未运行）一律跳过，不补跑。
 */
export const scheduledTaskSchema = z
  .strictObject({
    id: z.string().regex(ID_PATTERN, 'id 只能包含字母、数字、_ 和 -'),
    name: z.string().min(1, '任务名称不能为空'),
    /** skill 未设时为任务全文（必填，见 superRefine）；设了 skill 时为补充输入（可空） */
    content: z.string(),
    /** 任务内容来自技能：执行期渲染为「阅读 SKILL.md 并遵循」的提示词（main/skills/task-prompt.ts） */
    skill: taskSkillSchema.optional(),
    assistant_id: z.string().min(1),
    schedule: z.string().refine((value) => parseCron(value) !== null, '调度表达式不合法'),
    targets: z.array(taskTargetSchema).min(1, '至少选择一个会话'),
    enabled: z.boolean().default(true),
  })
  .superRefine((task, ctx) => {
    if (task.skill === undefined && task.content.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['content'], message: '任务内容不能为空' })
    }
  })

export const configSchema = z
  .strictObject({
    channels: z
      .record(z.string().regex(ID_PATTERN, 'channel id 只能包含字母、数字、_ 和 -'), channelSettingsSchema)
      .default({}),
    manager_bots: z
      .record(z.string().regex(ID_PATTERN, 'manager id 只能包含字母、数字、_ 和 -'), managerBotSchema)
      .default({}),
    assistants: z.array(assistantSchema).default([{ id: DEFAULT_ASSISTANT_ID, agent_id: 'codex' }]),
    bindings: z.array(bindingSchema).default([]),
    users: z.array(userSchema).default([]),
    // 内部字段有各自默认；用函数默认确保 defaultConfig() 也填充内层默认值
    auto_review: autoReviewSchema.default(() => autoReviewSchema.parse({})),
    scheduled_tasks: z.array(scheduledTaskSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const ids = config.assistants.map((a) => a.id)
    const idSet = new Set(ids)
    if (ids.length !== idSet.size) {
      ctx.addIssue({ code: 'custom', path: ['assistants'], message: 'assistant id 必须唯一' })
    }
    config.bindings.forEach((binding, index) => {
      if (binding.assistant_id !== undefined && !idSet.has(binding.assistant_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'assistant_id'],
          message: `未知的 assistant id: ${binding.assistant_id}`,
        })
      }
      // 通道默认是精确绑定的助手兜底，必须指定；防止「respond=true 却永远静默」的迷惑态
      if (binding.chat_id === CHAT_ALL && binding.assistant_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'assistant_id'],
          message: '通道默认绑定（chat_id = "*"）必须指定 assistant_id',
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
    const taskIds = new Set<string>()
    config.scheduled_tasks.forEach((task, index) => {
      if (taskIds.has(task.id)) {
        ctx.addIssue({ code: 'custom', path: ['scheduled_tasks', index, 'id'], message: `任务 id 重复：${task.id}` })
      }
      taskIds.add(task.id)
      if (!idSet.has(task.assistant_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scheduled_tasks', index, 'assistant_id'],
          message: `未知的 assistant id: ${task.assistant_id}`,
        })
      }
    })
  })

export type TelegramBotChannelSettings = z.infer<typeof telegramBotChannelSchema>
export type ChannelSettings = z.infer<typeof channelSettingsSchema>
export type ManagerBotConfig = z.infer<typeof managerBotSchema>
export type AssistantConfig = z.infer<typeof assistantSchema>
export type ChatBinding = z.infer<typeof bindingSchema>
export type ChannelUser = z.infer<typeof userSchema>
export type AutoReviewConfig = z.infer<typeof autoReviewSchema>
export type TaskTarget = z.infer<typeof taskTargetSchema>
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>
export type Config = z.infer<typeof configSchema>

/** 推给 UI / IPC 的配置状态快照 */
export interface ConfigState {
  /** 每次生效的配置变更 +1；乐观并发控制的依据 */
  version: number
  configPath: string
  config: Config
  /** 最近一次加载失败的原因（此时 config 为 last-good），null 表示健康 */
  lastError: string | null
  /**
   * 本次启动时 config.toml 不存在（init 在采样后随即写入默认文件）。
   * 首启引导据此进入——删除 config.toml 重启即可重新触发。
   */
  firstRun: boolean
}

export type ConfigMutationResult = { ok: true; state: ConfigState } | { ok: false; message: string; conflict: boolean }
