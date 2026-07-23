// @susie/codex-app-server：`codex app-server` 的 TypeScript SDK
// （对位 PyPI openai-codex 包；协议类型由 `codex app-server generate-ts` 生成）。
//
// 高层入口：Codex → Thread → TurnHandle（steer / interrupt / stream）。
// 全协议访问：CodexClient.request(method, params)，参数类型按 ClientRequest 联合缩窄；
// 完整生成类型可从 './generated'（根）与 './generated/v2'（v2 面）深引。

export { Codex, Thread, TurnHandle, type ThreadStartOptions, type TurnOptions } from './api'
export {
  CodexClient,
  defaultServerRequestHandler,
  type ClientRequestMethod,
  type ClientRequestParams,
  type CodexClientOptions,
  type ServerRequestHandler,
} from './client'
export {
  CodexError,
  CodexRpcError,
  InternalRpcError,
  InvalidParamsError,
  InvalidRequestError,
  isRetryableError,
  JsonRpcError,
  mapJsonRpcError,
  MethodNotFoundError,
  ParseError,
  RetryLimitExceededError,
  ServerBusyError,
  TransportClosedError,
} from './errors'
export type { ImageInput, InputItem, LocalImageInput, MentionInput, RunInput, SkillInput, TextInput } from './inputs'
export { toWireInput } from './inputs'
export { ChatgptLoginHandle, DeviceCodeLoginHandle } from './login'
export {
  approvalModeSettings,
  sandboxMode,
  sandboxPolicy,
  type ApprovalMode,
  type ApprovalSettings,
  type Sandbox,
} from './modes'
export { notificationLoginId, notificationTurnId, type JsonObject, type Notification } from './notifications'
export { AsyncQueue } from './queue'
export { retryOnOverload, type RetryOptions } from './retry'
export { MessageRouter } from './router'
export { collectTurnResult, type TurnResult } from './run'

// 常用生成类型直接再导出（更多类型请从 generated 目录深引）
export type { ClientRequest } from './generated/ClientRequest'
export type { InitializeResponse } from './generated/InitializeResponse'
export type { ReasoningEffort } from './generated/ReasoningEffort'
export type { ServerNotificationEnvelope } from './generated/ServerNotificationEnvelope'
export type { ServerRequest } from './generated/ServerRequest'
export type { JsonValue } from './generated/serde_json/JsonValue'
export type { AccountLoginCompletedNotification } from './generated/v2/AccountLoginCompletedNotification'
export type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification'
export type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification'
export type { ItemStartedNotification } from './generated/v2/ItemStartedNotification'
export type { Model } from './generated/v2/Model'
export type { ModelListResponse } from './generated/v2/ModelListResponse'
export type { ThreadItem } from './generated/v2/ThreadItem'
export type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage'
export type { Turn } from './generated/v2/Turn'
export type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification'
export type { TurnError } from './generated/v2/TurnError'
export type { TurnStatus } from './generated/v2/TurnStatus'
