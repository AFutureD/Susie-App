// 通知模型：payload 即 JSON-RPC params 原文（不做运行时校验），类型上用生成的
// ServerNotificationEnvelope 联合缩窄；未知方法退化为 { method, params } 结构。
import type { JsonValue } from './generated/serde_json/JsonValue'
import type { ServerNotificationEnvelope } from './generated/ServerNotificationEnvelope'

export type JsonObject = { [key in string]?: JsonValue }

/** 已知通知（method → params 类型可判别）或未知通知的原始载荷 */
export type Notification = ServerNotificationEnvelope | { method: string; params: JsonObject }

/**
 * 通知路由 id 提取（对位 notification_registry 的 DIRECT/NESTED 列表）：
 * 结构化提取 params.turnId 或 params.turn.id，对未知通知同样适用。
 */
export function notificationTurnId(notification: Notification): string | null {
  const params = notification.params as JsonObject | undefined
  if (params === undefined) return null
  const direct = params['turnId']
  if (typeof direct === 'string') return direct
  const turn = params['turn']
  if (turn !== null && typeof turn === 'object' && !Array.isArray(turn)) {
    const nested = (turn as JsonObject)['id']
    if (typeof nested === 'string') return nested
  }
  return null
}

/** 交互式登录完成通知携带的 loginId（用于登录通知路由） */
export function notificationLoginId(notification: Notification): string | null {
  if (notification.method !== 'account/login/completed') return null
  const params = notification.params as JsonObject | undefined
  const loginId = params?.['loginId']
  return typeof loginId === 'string' ? loginId : null
}
