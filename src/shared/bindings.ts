import { CHAT_ALL, type ChatBinding } from './config'

// 绑定 = 路由：β(x) = 精确绑定 | 通道默认（chat_id='*'） | null（无绑定命中，不响应）。
// 不存在全局兜底。是否响应看命中绑定的 respond（精确优先）；精确绑定可不指定助手（跟随通道默认），
// 解析不到助手同样不响应。群会话在命中后还要过触发条件（@ 提及要求，来自命中的那条绑定）；
// 发送者层面的响应与审核由用户模块按身份决定，不在本层。

interface AssignmentOptions {
  /** 是否响应；精确绑定可显式 false 静音单个会话 */
  respond: boolean
  onlyMention: boolean
  /** 开启后把 agent 运行期间的全部直接产出（过程与结果）发送到会话 */
  sendOutput: boolean
}

/** 精确会话的指派；assistantId null = 跟随通道默认助手 */
export interface ChatAssignment extends AssignmentOptions {
  assistantId: string | null
}

/** 通道默认的指派；assistantId 必有（schema superRefine 同规则） */
export interface WildcardAssignment extends AssignmentOptions {
  assistantId: string
}

/** 展开后的指派集合（图/树编辑器与规范化共用的语义模型） */
export interface BindingAssignments {
  /** channelId -> chatId -> 指派（精确绑定） */
  exact: Record<string, Record<string, ChatAssignment>>
  /** channelId -> 指派（通道默认，chat_id='*'）；respond 决定未列出会话是否响应 */
  wildcard: Record<string, WildcardAssignment>
}

export function assignmentOf(binding: ChatBinding): ChatAssignment {
  return {
    assistantId: binding.assistant_id ?? null,
    respond: binding.respond,
    onlyMention: binding.only_mention,
    sendOutput: binding.send_output,
  }
}

/** bindings → 指派集合。legacy 容错：同一 (channel, chatId) 重复声明时首条胜出。 */
export function expandBindings(bindings: ChatBinding[]): BindingAssignments {
  const exact: Record<string, Record<string, ChatAssignment>> = {}
  const wildcard: Record<string, WildcardAssignment> = {}
  for (const binding of bindings) {
    if (binding.chat_id === CHAT_ALL) {
      // schema superRefine 保证通道默认必有 assistant_id；缺失（仅测试构造可能）时跳过
      if (binding.assistant_id === undefined) continue
      wildcard[binding.channel] ??= { ...assignmentOf(binding), assistantId: binding.assistant_id }
    } else {
      const channelExact = (exact[binding.channel] ??= {})
      channelExact[binding.chat_id] ??= assignmentOf(binding)
    }
  }
  return { exact, wildcard }
}

/**
 * 指派集合 → 规范形 bindings：每会话一条，channel/chatId 全排序，
 * 通道默认（'*'）排在该通道末尾；输出与输入顺序无关（TOML diff 稳定）。
 */
export function canonicalizeBindings(assignments: BindingAssignments): ChatBinding[] {
  const out: ChatBinding[] = []
  const channels = [...new Set([...Object.keys(assignments.exact), ...Object.keys(assignments.wildcard)])].toSorted()
  for (const channel of channels) {
    const channelExact = assignments.exact[channel] ?? {}
    for (const chatId of Object.keys(channelExact).toSorted()) {
      const assignment = channelExact[chatId]
      if (assignment === undefined) continue
      out.push(toBinding(channel, chatId, assignment))
    }
    const fallback = assignments.wildcard[channel]
    if (fallback !== undefined) out.push(toBinding(channel, CHAT_ALL, fallback))
  }
  return out
}

function toBinding(channel: string, chatId: string, assignment: ChatAssignment): ChatBinding {
  return {
    channel,
    chat_id: chatId,
    // null（跟随通道默认）省写：serializeConfig 的 JSON 往返会剔除 undefined，TOML 不落该键
    assistant_id: assignment.assistantId ?? undefined,
    respond: assignment.respond,
    only_mention: assignment.onlyMention,
    send_output: assignment.sendOutput,
  }
}

/**
 * 有效路由结论：respond/onlyMention/sendOutput 取命中绑定自身（精确优先）；
 * assistantId = 精确.assistant_id ?? 通道默认.assistant_id ?? null（null = 无助手承接）。
 */
export interface EffectiveBinding {
  respond: boolean
  assistantId: string | null
  onlyMention: boolean
  sendOutput: boolean
}

/**
 * binding 解析：精确 > 通道默认 > null（无命中）。与声明顺序无关；
 * 同层重复按声明序取首条（仅作 legacy 配置容错）。
 * 精确命中只向通道默认借助手（assistant_id 缺省时），不借 respond/触发/输出选项。
 */
export function resolveEffectiveBinding(
  bindings: ChatBinding[],
  channelId: string,
  chatId: string,
): EffectiveBinding | null {
  let exactHit: ChatBinding | null = null
  let wildcardHit: ChatBinding | null = null
  for (const binding of bindings) {
    if (binding.channel !== channelId) continue
    // chatId 字面量 '*' 不当精确命中（防手写 TOML 的通配值撞精确分支）
    if (exactHit === null && chatId !== CHAT_ALL && binding.chat_id === chatId) exactHit = binding
    if (wildcardHit === null && binding.chat_id === CHAT_ALL) wildcardHit = binding
    if (exactHit !== null && wildcardHit !== null) break
  }
  const hit = exactHit ?? wildcardHit
  if (hit === null) return null
  return {
    respond: hit.respond,
    assistantId: hit.assistant_id ?? wildcardHit?.assistant_id ?? null,
    onlyMention: hit.only_mention,
    sendOutput: hit.send_output,
  }
}

export interface SenderMeta {
  /** private/group/supergroup/channel/sender；无法解析时为 null */
  chatType: string | null
  /** 群内消息是否 @ 了 bot 或回复了 bot */
  mentioned: boolean
}

/**
 * 会话触发条件：私聊恒触发；群会话按命中绑定的 @ 提及要求过滤。
 * 纯会话侧配置——发送者的权限（响应/审核/忽略）由用户模块判定，不在本层。
 */
export function isTriggerSatisfied(onlyMention: boolean, meta: SenderMeta): boolean {
  if (meta.chatType === 'private') return true
  return !onlyMention || meta.mentioned
}
