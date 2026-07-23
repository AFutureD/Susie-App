import type { ThreadItem } from '@susie/codex-app-server'
import type { MessagePart } from '../../shared/messages'

/** app-server v2 ThreadItem → 消息 parts（对位 Python CodexSDKMessage.chat_message_parts） */
export function mapThreadItem(item: ThreadItem): MessagePart[] {
  switch (item.type) {
    case 'agentMessage':
      return item.text === '' ? [] : [{ kind: 'text', text: item.text }]

    case 'reasoning': {
      const body = [...item.summary, ...item.content].join('\n')
      return body === '' ? [] : [{ kind: 'quote', title: '[reasoning]', body }]
    }

    case 'plan':
      return item.text === '' ? [] : [{ kind: 'quote', title: '[plan]', body: item.text }]

    case 'commandExecution': {
      const output = item.aggregatedOutput ?? ''
      const body = item.exitCode === null ? output : `exit_code: ${item.exitCode}\n${output}`
      return [{ kind: 'quote', title: `[${item.status}] ${item.command}`, body: body.trim() }]
    }

    case 'mcpToolCall': {
      const body =
        item.error !== null
          ? item.error.message
          : item.result !== null
            ? JSON.stringify(item.result.content)
            : JSON.stringify(item.arguments)
      return [{ kind: 'quote', title: `[${item.status}] ${item.server}.${item.tool}`, body: body ?? '' }]
    }

    case 'dynamicToolCall': {
      const title = item.namespace === null ? item.tool : `${item.namespace}.${item.tool}`
      const body = item.contentItems !== null ? JSON.stringify(item.contentItems) : JSON.stringify(item.arguments)
      return [{ kind: 'quote', title: `[${item.status}] ${title}`, body: body ?? '' }]
    }

    case 'fileChange': {
      const body = item.changes.map((change) => `${change.kind.type}: ${change.path}`).join('\n')
      return [{ kind: 'quote', title: `[${item.status}] file changes`, body }]
    }

    case 'collabAgentToolCall':
      return [{ kind: 'quote', title: `[${item.status}] ${item.tool}`, body: item.prompt ?? '' }]

    case 'webSearch':
      return [{ kind: 'quote', title: '[web_search]', body: item.query }]

    default:
      return []
  }
}
