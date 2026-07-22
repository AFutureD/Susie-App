import type { ThreadItem } from '@openai/codex-sdk'
import type { MessagePart } from '../../shared/messages'

/** codex ThreadItem → 消息 parts（对位 Python CodexSDKMessage.chat_message_parts） */
export function mapThreadItem(item: ThreadItem): MessagePart[] {
  switch (item.type) {
    case 'agent_message':
      return item.text === '' ? [] : [{ kind: 'text', text: item.text }]

    case 'reasoning':
      return item.text === '' ? [] : [{ kind: 'quote', title: '[reasoning]', body: item.text }]

    case 'command_execution': {
      const body =
        item.exit_code === undefined
          ? item.aggregated_output
          : `exit_code: ${item.exit_code}\n${item.aggregated_output}`
      return [{ kind: 'quote', title: `[${item.status}] ${item.command}`, body: body.trim() }]
    }

    case 'mcp_tool_call': {
      // JSONL 里 error/result 可能是显式 null（类型声明为可选，运行时并非 undefined）
      const body =
        item.error != null
          ? item.error.message
          : item.result != null
            ? JSON.stringify(item.result.content)
            : JSON.stringify(item.arguments)
      return [{ kind: 'quote', title: `[${item.status}] ${item.server}.${item.tool}`, body: body ?? '' }]
    }

    case 'file_change': {
      const body = item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n')
      return [{ kind: 'quote', title: `[${item.status}] file changes`, body }]
    }

    case 'todo_list': {
      const body = item.items.map((todo) => `- [${todo.completed ? 'x' : ' '}] ${todo.text}`).join('\n')
      return [{ kind: 'quote', title: '[plan]', body }]
    }

    case 'web_search':
      return [{ kind: 'quote', title: '[web_search]', body: item.query }]

    case 'error':
      return [{ kind: 'quote', title: '[error]', body: item.message }]

    default:
      return []
  }
}
