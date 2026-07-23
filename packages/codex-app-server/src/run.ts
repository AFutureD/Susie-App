// TurnResult 收集（对位 openai_codex _run.py）：消费 turn 通知流直至 turn/completed
import type { ThreadItem } from './generated/v2/ThreadItem'
import type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage'
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification'
import type { TurnError } from './generated/v2/TurnError'
import type { TurnStatus } from './generated/v2/TurnStatus'
import type { Notification } from './notifications'

export interface TurnResult {
  id: string
  status: TurnStatus
  error: TurnError | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  finalResponse: string | null
  items: ThreadItem[]
  usage: ThreadTokenUsage | null
}

function finalAssistantResponse(items: ThreadItem[]): string | null {
  let lastUnknownPhase: string | null = null
  for (const item of [...items].reverse()) {
    if (item.type !== 'agentMessage') continue
    if (item.phase === 'final_answer') return item.text
    if (item.phase === null && lastUnknownPhase === null) lastUnknownPhase = item.text
  }
  return lastUnknownPhase
}

export async function collectTurnResult(stream: AsyncIterable<Notification>, turnId: string): Promise<TurnResult> {
  let completed: TurnCompletedNotification | null = null
  const items: ThreadItem[] = []
  let usage: ThreadTokenUsage | null = null

  for await (const event of stream) {
    if (event.method === 'item/completed') {
      const params = event.params as { item?: ThreadItem; turnId?: string }
      if (params.turnId === turnId && params.item !== undefined) items.push(params.item)
      continue
    }
    if (event.method === 'thread/tokenUsage/updated') {
      const params = event.params as { tokenUsage?: ThreadTokenUsage; turnId?: string }
      if (params.turnId === turnId && params.tokenUsage !== undefined) usage = params.tokenUsage
      continue
    }
    if (event.method === 'turn/completed') {
      const params = event.params as unknown as TurnCompletedNotification
      if (params.turn.id === turnId) completed = params
    }
  }

  if (completed === null) throw new Error('turn/completed 通知未收到')
  const turn = completed.turn
  if (turn.status === 'failed') {
    throw new Error(turn.error?.message ?? `turn failed with status ${turn.status}`)
  }
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    finalResponse: finalAssistantResponse(items),
    items,
    usage,
  }
}
