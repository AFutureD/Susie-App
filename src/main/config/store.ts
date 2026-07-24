import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  ID_PATTERN,
  configSchema,
  type AssistantConfig,
  type ChannelSettings,
  type ChannelUser,
  type ChatBinding,
  type Config,
  type ConfigMutationResult,
  type ConfigState,
} from '../../shared/config'
import { deepEqual, defaultConfig, parseConfigText, serializeConfig } from './load'

export type Unsubscribe = () => void

/**
 * 指向配置实体的引用句柄：`.current` 永远解析到最新 snapshot。
 * 热加载后无需换手；实体被删除时解析为 undefined（持有者应自行销毁）。
 */
export interface ConfigRef<T> {
  readonly path: string
  readonly current: T | undefined
  onChange(listener: (next: T | undefined, prev: T | undefined) => void): Unsubscribe
}

type PathListener = (next: unknown, prev: unknown) => void

/**
 * 主进程唯一的配置中枢。
 *
 * - snapshot 不可变：每次变更（外部热加载 / UI 修改）整体换入新对象；
 * - 变更按 path 做结构比较，只通知真正变化的订阅者；
 * - 加载失败保留 last-good snapshot，错误进入 state().lastError；
 * - 所有 UI 修改带 expectedVersion 做乐观并发控制；
 * - 自写文件通过内容 hash 抑制 watcher 回环。
 */
export class ConfigStore {
  readonly configPath: string

  private snapshot: Config
  private version = 1
  private lastError: string | null = null

  private readonly pathListeners = new Map<string, Set<PathListener>>()
  private readonly stateListeners = new Set<(state: ConfigState) => void>()
  private readonly pendingSelfHashes = new Set<string>()

  private constructor(configPath: string, snapshot: Config, lastError: string | null) {
    this.configPath = configPath
    this.snapshot = snapshot
    this.lastError = lastError
  }

  /** 加载配置；文件缺失时写入默认配置。任何失败都退化为内存默认配置 + lastError，不抛异常。 */
  static init(configPath: string): ConfigStore {
    try {
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        atomicWrite(configPath, serializeConfig(defaultConfig()))
      }
      const text = fs.readFileSync(configPath, 'utf-8')
      const result = parseConfigText(text)
      if (result.ok) {
        return new ConfigStore(configPath, result.config, null)
      }
      return new ConfigStore(configPath, defaultConfig(), result.error)
    } catch (error) {
      const message = `读取配置失败：${error instanceof Error ? error.message : String(error)}`
      return new ConfigStore(configPath, defaultConfig(), message)
    }
  }

  get current(): Config {
    return this.snapshot
  }

  get currentVersion(): number {
    return this.version
  }

  state(): ConfigState {
    return {
      version: this.version,
      configPath: this.configPath,
      config: this.snapshot,
      lastError: this.lastError,
    }
  }

  /** 原始文件文本（供 Raw 编辑器）；读不到时回退为当前 snapshot 的序列化 */
  readRawText(): string {
    try {
      return fs.readFileSync(this.configPath, 'utf-8')
    } catch {
      return serializeConfig(this.snapshot)
    }
  }

  // ---------- 热加载 ----------

  /** watcher 回调：读盘并应用。自写内容（hash 命中）直接跳过。 */
  reloadFromDisk(): void {
    let text: string
    try {
      text = fs.readFileSync(this.configPath, 'utf-8')
    } catch (error) {
      this.setError(`读取配置失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (this.pendingSelfHashes.delete(sha256(text))) return

    this.applyExternalText(text)
  }

  /** 应用一段外部配置文本；失败保留 last-good。 */
  applyExternalText(text: string): void {
    const result = parseConfigText(text)
    if (!result.ok) {
      this.setError(result.error)
      return
    }
    this.applySnapshot(result.config)
  }

  // ---------- 引用与订阅 ----------

  ref<T = unknown>(refPath: string): ConfigRef<T> {
    // 引用创建即校验 path 形态，尽早暴露拼写错误
    resolveConfigPath(this.snapshot, refPath)
    const resolveCurrent = (): T | undefined => resolveConfigPath(this.snapshot, refPath) as T | undefined
    const subscribe = (listener: (next: T | undefined, prev: T | undefined) => void): Unsubscribe =>
      this.subscribePath(refPath, listener as PathListener)
    return {
      path: refPath,
      get current(): T | undefined {
        return resolveCurrent()
      },
      onChange: subscribe,
    }
  }

  subscribePath(refPath: string, listener: PathListener): Unsubscribe {
    let set = this.pathListeners.get(refPath)
    if (!set) {
      set = new Set()
      this.pathListeners.set(refPath, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.pathListeners.delete(refPath)
    }
  }

  /** 任意状态变化（配置生效、加载出错）都会触发；用于 IPC 推送。 */
  onState(listener: (state: ConfigState) => void): Unsubscribe {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  // ---------- UI 修改（乐观并发 + 原子写盘） ----------

  upsertChannel(id: string, settings: ChannelSettings, expectedVersion: number): ConfigMutationResult {
    if (!ID_PATTERN.test(id)) return fail('channel id 只能包含字母、数字、_ 和 -')
    return this.mutate(expectedVersion, (draft) => {
      draft.channels[id] = settings
    })
  }

  deleteChannel(id: string, expectedVersion: number): ConfigMutationResult {
    return this.mutate(expectedVersion, (draft) => {
      if (!(id in draft.channels)) throw new Error(`通道不存在：${id}`)
      delete draft.channels[id]
    })
  }

  upsertAssistant(assistant: AssistantConfig, expectedVersion: number): ConfigMutationResult {
    return this.mutate(expectedVersion, (draft) => {
      const index = draft.assistants.findIndex((a) => a.id === assistant.id)
      if (index >= 0) draft.assistants[index] = assistant
      else draft.assistants.push(assistant)
    })
  }

  deleteAssistant(id: string, expectedVersion: number): ConfigMutationResult {
    // 被绑定引用的助手由 schema 引用校验拦截；无引用即可删（不再有全局兜底特权助手）
    return this.mutate(expectedVersion, (draft) => {
      const index = draft.assistants.findIndex((a) => a.id === id)
      if (index < 0) throw new Error(`助手不存在：${id}`)
      draft.assistants.splice(index, 1)
    })
  }

  /** 整组替换 bindings。解析已是顺序无关（最特异匹配），无需 index 式增删移。 */
  setBindings(bindings: ChatBinding[], expectedVersion: number): ConfigMutationResult {
    return this.mutate(expectedVersion, (draft) => {
      draft.bindings = bindings
    })
  }

  /** 整组替换用户名单（owner 唯一性等约束由 schema 校验拦截） */
  setUsers(users: ChannelUser[], expectedVersion: number): ConfigMutationResult {
    return this.mutate(expectedVersion, (draft) => {
      draft.users = users
    })
  }

  /** Raw 编辑器整文件保存：按用户书写的原文落盘（不 canonical 化）。 */
  saveRaw(text: string, expectedVersion: number): ConfigMutationResult {
    if (expectedVersion !== this.version) return conflict(this.version, expectedVersion)
    const result = parseConfigText(text)
    if (!result.ok) return fail(result.error)

    try {
      this.writeToDisk(text)
    } catch (error) {
      return fail(`写入配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.applySnapshot(result.config)
    return { ok: true, state: this.state() }
  }

  // ---------- 内部 ----------

  private mutate(expectedVersion: number, edit: (draft: Config) => void): ConfigMutationResult {
    if (expectedVersion !== this.version) return conflict(this.version, expectedVersion)

    const draft = structuredClone(this.snapshot)
    try {
      edit(draft)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }

    const reparsed = configSchema.safeParse(JSON.parse(JSON.stringify(draft)))
    if (!reparsed.success) {
      const issues = reparsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      return fail(`配置校验失败：${issues.join('；')}`)
    }

    try {
      this.writeToDisk(serializeConfig(reparsed.data))
    } catch (error) {
      return fail(`写入配置失败：${error instanceof Error ? error.message : String(error)}`)
    }

    this.applySnapshot(reparsed.data)
    return { ok: true, state: this.state() }
  }

  private writeToDisk(text: string): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    atomicWrite(this.configPath, text)
    this.pendingSelfHashes.add(sha256(text))
  }

  private applySnapshot(next: Config): void {
    const prev = this.snapshot
    const changedPaths = diffConfigPaths(prev, next)

    this.snapshot = next
    this.lastError = null
    if (changedPaths.length > 0) this.version += 1

    for (const changed of changedPaths) {
      const listeners = this.pathListeners.get(changed)
      if (!listeners) continue
      const nextValue = resolveConfigPath(next, changed)
      const prevValue = resolveConfigPath(prev, changed)
      // 快照后再遍历：回调里可能退订，避免边遍历边改 Set
      for (const listener of Array.from(listeners)) listener(nextValue, prevValue)
    }
    this.notifyState()
  }

  private setError(message: string): void {
    this.lastError = message
    this.notifyState()
  }

  private notifyState(): void {
    const state = this.state()
    for (const listener of Array.from(this.stateListeners)) listener(state)
  }
}

/** 结构比较两份配置，返回发生变化的 path（含集合级与根 ''）。 */
export function diffConfigPaths(prev: Config, next: Config): string[] {
  const changed: string[] = []

  const channelIds = new Set([...Object.keys(prev.channels), ...Object.keys(next.channels)])
  let channelsChanged = false
  for (const id of channelIds) {
    if (!deepEqual(prev.channels[id], next.channels[id])) {
      changed.push(`channels.${id}`)
      channelsChanged = true
    }
  }
  if (channelsChanged) changed.push('channels')

  const prevAssistants = new Map(prev.assistants.map((a) => [a.id, a]))
  const nextAssistants = new Map(next.assistants.map((a) => [a.id, a]))
  const assistantIds = new Set([...prevAssistants.keys(), ...nextAssistants.keys()])
  let assistantsChanged = false
  for (const id of assistantIds) {
    if (!deepEqual(prevAssistants.get(id), nextAssistants.get(id))) {
      changed.push(`assistants.${id}`)
      assistantsChanged = true
    }
  }
  if (assistantsChanged) changed.push('assistants')

  if (!deepEqual(prev.bindings, next.bindings)) changed.push('bindings')

  if (!deepEqual(prev.users, next.users)) changed.push('users')

  if (changed.length > 0) changed.push('')
  return changed
}

/**
 * path 寻址：'' | 'channels' | 'channels.<id>' | 'assistants' | 'assistants.<id>' | 'bindings' | 'users'。
 * id 由 schema 保证不含 '.'。
 */
export function resolveConfigPath(config: Config, refPath: string): unknown {
  if (refPath === '') return config

  const dot = refPath.indexOf('.')
  const head = dot < 0 ? refPath : refPath.slice(0, dot)
  const rest = dot < 0 ? null : refPath.slice(dot + 1)

  switch (head) {
    case 'channels':
      return rest === null ? config.channels : config.channels[rest]
    case 'assistants':
      return rest === null ? config.assistants : config.assistants.find((a) => a.id === rest)
    case 'bindings':
      if (rest !== null) throw new Error(`bindings 不支持子路径：${refPath}`)
      return config.bindings
    case 'users':
      if (rest !== null) throw new Error(`users 不支持子路径：${refPath}`)
      return config.users
    default:
      throw new Error(`未知的配置 path：${refPath}`)
  }
}

function atomicWrite(filePath: string, text: string): void {
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, text, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function fail(message: string): ConfigMutationResult {
  return { ok: false, message, conflict: false }
}

function conflict(currentVersion: number, expectedVersion: number): ConfigMutationResult {
  return {
    ok: false,
    conflict: true,
    message: `配置已被其他修改更新（当前 v${currentVersion}，本次修改基于 v${expectedVersion}），请刷新后重试`,
  }
}
