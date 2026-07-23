import { CHAT_ALL, type ChatBinding } from './config'

// 准入统一由绑定决定：β(x) = 精确绑定 | 通道默认（chat_id='*'） | null（禁止，不响应）。
// 不存在全局兜底——没有绑定命中就是不响应。群会话在命中后还要过发送者准入
// （成员名单 + @ 提及要求，来自命中的那条绑定）。

/** 一个会话的指派（含群触发属性与输出选项） */
export interface ChatAssignment {
  assistantId: string
  onlyMention: boolean
  /** 空 = 所有成员 */
  members: string[]
  /** 开启后把 agent 运行期间的全部直接产出（过程与结果）发送到会话 */
  sendOutput: boolean
}

/** 展开后的指派集合（图/树编辑器与规范化共用的语义模型） */
export interface BindingAssignments {
  /** channelId -> chatId -> 指派（精确绑定） */
  exact: Record<string, Record<string, ChatAssignment>>
  /** channelId -> 指派（通道默认，chat_id='*'）；群触发属性同样生效 */
  wildcard: Record<string, ChatAssignment>
}

export function assignmentOf(binding: ChatBinding): ChatAssignment {
  return {
    assistantId: binding.assistant_id,
    onlyMention: binding.only_mention,
    members: binding.members,
    sendOutput: binding.send_output,
  }
}

/** bindings → 指派集合。legacy 容错：同一 (channel, chatId) 重复声明时首条胜出。 */
export function expandBindings(bindings: ChatBinding[]): BindingAssignments {
  const exact: Record<string, Record<string, ChatAssignment>> = {}
  const wildcard: Record<string, ChatAssignment> = {}
  for (const binding of bindings) {
    if (binding.chat_id === CHAT_ALL) {
      wildcard[binding.channel] ??= assignmentOf(binding)
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
    assistant_id: assignment.assistantId,
    only_mention: assignment.onlyMention,
    members: assignment.members,
    send_output: assignment.sendOutput,
  }
}

/**
 * binding 解析：精确 > 通道默认 > null（禁止）。与声明顺序无关；
 * 同层重复按声明序取首条（仅作 legacy 配置容错）。
 */
export function resolveBinding(bindings: ChatBinding[], channelId: string, chatId: string): ChatBinding | null {
  let wildcardHit: ChatBinding | null = null
  for (const binding of bindings) {
    if (binding.channel !== channelId) continue
    if (chatId !== CHAT_ALL && binding.chat_id === chatId) return binding
    if (wildcardHit === null && binding.chat_id === CHAT_ALL) wildcardHit = binding
  }
  return wildcardHit
}

export interface SenderMeta {
  /** private/group/supergroup/channel/sender；无法解析时为 null */
  chatType: string | null
  senderId: string | null
  /** 群内消息是否 @ 了 bot 或回复了 bot */
  mentioned: boolean
}

/**
 * 发送者准入：私聊命中绑定即放行（chat=user，会话粒度已含用户粒度）；
 * 群会话再按命中绑定的成员名单与 @ 要求过滤。
 */
export function isSenderAdmitted(binding: ChatBinding, meta: SenderMeta): boolean {
  if (meta.chatType === 'private') return true
  if (binding.only_mention && !meta.mentioned) return false
  if (binding.members.length === 0) return true
  return meta.senderId !== null && binding.members.includes(meta.senderId)
}
