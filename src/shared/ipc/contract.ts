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
  userSchema,
  type ConfigMutationResult,
  type ConfigState,
} from '../config'
import type {
  AgentModelOption,
  AgentsOverview,
  AutoReviewRecord,
  ChannelStatus,
  ChatInfo,
  SenderInfo,
  StoredMessage,
  UpdateState,
} from '../messages'

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

export const ipcContract = {
  app: {
    getInfo: { req: z.void(), res: res<AppInfo>() },
    setLoginItem: { req: z.object({ enabled: z.boolean() }), res: res<ActionResult>() },
    /** 在系统默认浏览器/对应 App 打开外部链接（仅 https） */
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
  },

  assistants: {
    /** 在 Finder 打开 assistant 的生效工作目录（缺省为 workspace/<id>，会自动创建） */
    openWorkdir: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
  },

  channels: {
    statuses: { req: z.void(), res: res<ChannelStatus[]>() },
    /** 用 token 调 getMe 拿 bot username（频道 ID 留空时自动命名） */
    resolveUsername: {
      req: z.object({ token: z.string() }),
      res: res<{ ok: true; username: string } | { ok: false; message: string }>(),
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

  agents: {
    overview: { req: z.void(), res: res<AgentsOverview>() },
    /** 枚举指定 agent 的模型候选；agent 未安装或枚举失败返回 [] */
    models: { req: z.object({ agentId: z.string() }), res: res<AgentModelOption[]>() },
    install: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
    uninstall: { req: z.object({ id: z.string() }), res: res<ActionResult>() },
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
