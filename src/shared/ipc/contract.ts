// 主进程 ↔ 渲染进程的 IPC 契约（唯一事实源）。
// - req 用 zod schema：主进程路由（main/ipc/router.ts）对每个通道做运行时校验；
// - res 用 phantom token：响应来自可信主进程，只承载类型不做运行时校验；
// - 通道名由 group + method 自动派生（susie:<group>.<method>），主进程 handler 的完整性由
//   IpcHandlers 映射类型强制（缺一个 = 编译错），preload 只做前缀门卫——不存在第三份手工清单。
// 渲染端经 type-only import 取 IpcClient 类型，zod 不进 renderer bundle。

import { z } from 'zod'
import {
  assistantSchema,
  autoReviewSchema,
  bindingSchema,
  channelSettingsSchema,
  managerBotSchema,
  scheduledTaskSchema,
  userSchema,
  type ConfigMutationResult,
  type ConfigState,
} from '../config'
import type {
  AgentCliDetection,
  AgentModelOption,
  AgentsOverview,
  AutoReviewRecord,
  ChannelStatus,
  ChatInfo,
  ManagedBotDiscovery,
  SenderInfo,
  StoredMessage,
  TaskRunRecord,
  TaskStatus,
  UpdateState,
} from '../messages'
import { SKILL_DIRS, SKILL_SCOPES } from '../skills'
import type {
  AssistantSkills,
  LocalSkillList,
  RegistrySearchResult,
  RepoSkillsResult,
  SkillInstallResult,
} from '../skills'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  headless: boolean
  loginItemEnabled: boolean
  mcpUrl: string | null
}

export type ActionResult = { ok: true } | { ok: false; message: string }

/** res 类型占位：运行时是共享冻结空对象（零成本），类型经 ResOf 提取 */
const RES_TOKEN = Object.freeze({})
export interface ResType<T> {
  readonly __res?: T
}
const res = <T>(): ResType<T> => RES_TOKEN as ResType<T>

export interface MethodDef {
  req: z.ZodType
  res: ResType<unknown>
}
export type ContractShape = Record<string, Record<string, MethodDef>>

/** 乐观并发控制的版本号（ConfigState.version） */
const expectedVersion = z.number().int().nonnegative()

/** 远程技能的安装目标：scope=assistant 时 assistantId 必填（handler 内校验） */
const skillInstallTarget = z.object({
  scope: z.enum(SKILL_SCOPES),
  assistantId: z.string().optional(),
  dir: z.enum(SKILL_DIRS),
})

export const ipcContract = {
  app: {
    getInfo: { req: z.void(), res: res<AppInfo>() },
    setLoginItem: { req: z.object({ enabled: z.boolean() }), res: res<ActionResult>() },
    /** 在系统默认浏览器/对应 App 打开外部链接（仅 https 与 tg: deeplink） */
    openExternal: { req: z.object({ url: z.string() }), res: res<ActionResult>() },
    pickDirectory: { req: z.void(), res: res<string | null>() },
  },

  // 用户可编辑的载荷（settings/assistant/bindings/users/autoReview）在 handler 内做语义校验：
  // 违规返回 { ok:false, message: <第一条 issue> } 供表单内联展示（UI 反馈路径，不是异常）。
  // 契约层对这些字段用 z.custom<T>() 做类型化透传，路由只校验信封结构（id / expectedVersion）。
  config: {
    get: { req: z.void(), res: res<ConfigState>() },
    getRaw: { req: z.void(), res: res<{ text: string; version: number }>() },
    saveRaw: { req: z.object({ text: z.string(), expectedVersion }), res: res<ConfigMutationResult>() },
    upsertChannel: {
      req: z.object({ id: z.string(), settings: z.custom<z.input<typeof channelSettingsSchema>>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    deleteChannel: { req: z.object({ id: z.string(), expectedVersion }), res: res<ConfigMutationResult>() },
    upsertAssistant: {
      req: z.object({ assistant: z.custom<z.input<typeof assistantSchema>>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    deleteAssistant: { req: z.object({ id: z.string(), expectedVersion }), res: res<ConfigMutationResult>() },
    /** 整组替换 bindings（节点编辑器是全量状态编辑，index 式 API 不适配） */
    setBindings: {
      req: z.object({ bindings: z.custom<z.input<typeof bindingSchema>[]>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    /** 整组替换用户名单（用户管理/引导都是全量状态编辑） */
    setUsers: {
      req: z.object({ users: z.custom<z.input<typeof userSchema>[]>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    /** 整体替换「智能 · 自动审核」配置 */
    setAutoReview: {
      req: z.object({ autoReview: z.custom<z.input<typeof autoReviewSchema>>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    upsertScheduledTask: {
      req: z.object({ task: z.custom<z.input<typeof scheduledTaskSchema>>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    deleteScheduledTask: { req: z.object({ id: z.string(), expectedVersion }), res: res<ConfigMutationResult>() },
    upsertManagerBot: {
      req: z.object({ id: z.string(), settings: z.custom<z.input<typeof managerBotSchema>>(), expectedVersion }),
      res: res<ConfigMutationResult>(),
    },
    /** 删除 manager：managed 渠道保留（只失去分组与自动轮换），发现记录清库 */
    deleteManagerBot: { req: z.object({ id: z.string(), expectedVersion }), res: res<ConfigMutationResult>() },
  },

  assistants: {
    /** 在 Finder 打开 assistant 的生效工作目录（缺省为 workspace/<id>，会自动创建） */
    openWorkdir: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
  },

  channels: {
    statuses: { req: z.void(), res: res<ChannelStatus[]>() },
    /**
     * 用 token 调 getMe 拿 bot username（ID 留空时自动命名）与 can_manage_bots
     * （新增入口据此自动识别普通渠道 / manager，不需要用户手选类型）
     */
    resolveUsername: {
      req: z.object({ token: z.string() }),
      res: res<{ ok: true; username: string; canManageBots: boolean } | { ok: false; message: string }>(),
    },
  },

  managerBots: {
    statuses: { req: z.void(), res: res<ChannelStatus[]>() },
    /** 某 manager 的 managed bot 发现列表（发现 ≠ 添加；打开弹窗时回填，之后订阅事件） */
    discoveries: { req: z.object({ managerId: z.string() }), res: res<ManagedBotDiscovery[]>() },
    /** 从发现落地为普通 telegram_bot 渠道：取 token、写 managing、复制 owner（创建者兜底） */
    add: {
      req: z.object({ managerId: z.string(), botId: z.string(), expectedVersion }),
      res: res<
        { ok: true; channelId: string; state: ConfigState } | { ok: false; message: string; conflict: boolean }
      >(),
    },
  },

  chat: {
    send: {
      req: z.object({ channelId: z.string(), chatId: z.string(), text: z.string() }),
      res: res<ActionResult>(),
    },
  },

  history: {
    chats: { req: z.void(), res: res<ChatInfo[]>() },
    /** 出现过的发送者（白名单/用户候选）；chatId 省略时跨该频道全部会话；privateOnly 仅私聊发送者（owner 候选） */
    senders: {
      req: z.object({ channelId: z.string(), chatId: z.string().optional(), privateOnly: z.boolean().optional() }),
      res: res<SenderInfo[]>(),
    },
    messages: {
      req: z.object({
        channelId: z.string(),
        chatId: z.string(),
        limit: z.number().int().positive().optional(),
        beforeId: z.number().int().optional(),
      }),
      res: res<StoredMessage[]>(),
    },
    search: {
      req: z.object({ q: z.string(), limit: z.number().int().positive().optional() }),
      res: res<StoredMessage[]>(),
    },
  },

  tasks: {
    /** 全部任务的运行时状态（在跑/下次触发/最近一次执行） */
    statuses: { req: z.void(), res: res<TaskStatus[]>() },
    /** 执行历史（新 → 旧）；taskId 省略时跨全部任务 */
    runs: {
      req: z.object({ taskId: z.string().optional(), limit: z.number().int().positive().optional() }),
      res: res<TaskRunRecord[]>(),
    },
    /** 立即执行一次（任务在跑时拒绝） */
    run: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
  },

  agents: {
    overview: { req: z.void(), res: res<AgentsOverview>() },
    /** 检测本机 PATH 上的 codex/claude CLI（onboarding「准备 Agent」步推荐用） */
    detectCli: { req: z.void(), res: res<AgentCliDetection>() },
    /** 枚举指定 agent 的模型候选；agent 未安装或枚举失败返回 [] */
    models: { req: z.object({ agentId: z.string() }), res: res<AgentModelOption[]>() },
    install: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
    uninstall: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
  },

  skills: {
    /** 本地技能清单：global 扫用户主目录，assistant 扫助手生效工作目录（三个容器目录全扫） */
    listLocal: {
      req: z.object({ scope: z.enum(SKILL_SCOPES), assistantId: z.string().optional() }),
      res: res<LocalSkillList>(),
    },
    /** 某助手实际可读的技能（按 agent 支持目录过滤；助手弹窗与任务表单选择器共用） */
    listForAssistant: { req: z.object({ id: z.string() }), res: res<AssistantSkills>() },
    /** 删除本地技能目录 */
    remove: {
      req: z.object({
        scope: z.enum(SKILL_SCOPES),
        assistantId: z.string().optional(),
        dir: z.enum(SKILL_DIRS),
        dirName: z.string().min(1),
      }),
      res: res<ActionResult>(),
    },
    /** 在 Finder 打开技能目录 */
    reveal: { req: z.object({ path: z.string().min(1) }), res: res<ActionResult>() },
    /** 列出 GitHub 仓库中的技能（owner/repo 或 github.com 链接）；返回 sessionId 供安装复用解包结果 */
    listRepo: { req: z.object({ source: z.string().min(1) }), res: res<RepoSkillsResult>() },
    /** 从最近一次 listRepo 的解包结果安装指定技能 */
    installFromRepo: {
      req: z.object({
        sessionId: z.string().min(1),
        relPath: z.string().min(1),
        target: skillInstallTarget,
        overwrite: z.boolean().default(false),
      }),
      res: res<SkillInstallResult>(),
    },
    /** skillhubs registry 关键词搜索 */
    searchRegistry: { req: z.object({ keyword: z.string() }), res: res<RegistrySearchResult>() },
    /** 从 skillhubs registry 安装（取最新版本） */
    installFromRegistry: {
      req: z.object({ name: z.string().min(1), target: skillInstallTarget, overwrite: z.boolean().default(false) }),
      res: res<SkillInstallResult>(),
    },
  },

  logs: {
    tail: {
      req: z.object({ lines: z.number().int().optional(), file: z.enum(['main', 'error']).optional() }),
      res: res<{ path: string; lines: string[] }>(),
    },
  },

  autoReview: {
    /** 智能 · 自动审核的历史与进度（新 → 旧） */
    list: { req: z.object({ limit: z.number().int().optional() }), res: res<AutoReviewRecord[]>() },
  },

  update: {
    /** 手动触发检查更新（dev/未打包时返回 not-ok） */
    check: { req: z.void(), res: res<ActionResult>() },
    /** 立即重启并安装已下载的更新 */
    install: { req: z.void(), res: res<ActionResult>() },
    /** 拉取当前更新状态快照（新窗口订阅前回填） */
    getState: { req: z.void(), res: res<UpdateState>() },
  },
} as const satisfies ContractShape

export type IpcContract = typeof ipcContract

export type ResOf<D extends MethodDef> = D['res'] extends ResType<infer T> ? T : never

/**
 * 渲染端客户端类型：入参用 z.input（带 default 的字段可省略），返回 Promise<res>。
 * req 为 z.void() 的方法调用时不带参数。
 */
export type IpcClient = {
  [G in keyof IpcContract]: {
    [M in keyof IpcContract[G]]: IpcContract[G][M] extends infer D extends MethodDef
      ? [z.input<D['req']>] extends [void]
        ? () => Promise<ResOf<D>>
        : (payload: z.input<D['req']>) => Promise<ResOf<D>>
      : never
  }
}
