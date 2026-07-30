import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ChatInfo, StoredMessage } from '../../shared/messages'
import type { Logger } from '../util/logger'
import { resolveDateRange } from './dates'

/** ChatManager/HistoryStore 的窄接口（便于测试注入假实现） */
export interface McpBridge {
  sendMessage(input: {
    channelId: string
    chatId: string
    content: string
    files: string[]
    /**
     * reply_to 语义（agent 侧覆盖当前 turn 的默认锚点）：
     * - undefined = 使用 turn 锚点（普通线程 fallback 时保回复位；其他场景 = null）
     * - null = 显式跳出普通线程（发送到基础会话，不 reply）
     * - 字符串（纯数字）= 显式覆盖到指定 message id
     */
    replyTo?: string | null
  }): Promise<StoredMessage>
  listMessages(input: {
    channelId: string
    chatId: string
    num: number
    dateStart: number | null
    dateEnd: number | null
  }): StoredMessage[]
  listChats(channelId?: string): ChatInfo[]
}

// 工具定义用手写 JSON Schema（避免与 SDK 内部 zod 版本耦合）
const TOOLS = [
  {
    name: 'send_message',
    description:
      'Send a message to a chat by channel_id and chat_id. `file` is an optional local file path (string) or list of paths. `reply_to` overrides the default reply anchor: omit to reuse the current turn anchor (used when the inbound thread was folded into the base chat), pass a numeric message id to explicitly reply, or pass null to break out of the reply thread.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The channel id.' },
        chat_id: { type: 'string', description: 'The chat id.' },
        content: { type: 'string', description: 'The message text.' },
        file: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Optional local file path(s) to attach.',
        },
        reply_to: {
          anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
          description:
            'Optional. Omit to use the turn anchor; pass a numeric message id to override; pass null to skip the anchor entirely.',
        },
      },
      required: ['channel_id', 'chat_id', 'content'],
    },
  },
  {
    name: 'list_messages',
    description:
      'List recent messages of a chat. Dates accept natural language, e.g. "-2d", "yesterday", "last week" (via date_range).',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        chat_id: { type: 'string' },
        num: { type: 'number', description: 'How many messages to fetch. Default 1 (the latest).' },
        date_start: { type: 'string' },
        date_end: { type: 'string' },
        date_range: { type: 'string', description: 'Overrides date_start/date_end, e.g. "last week".' },
      },
      required: ['channel_id', 'chat_id'],
    },
  },
  {
    name: 'list_chats',
    description: 'List known chats. Omit channel_id to list across all channels.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        with_archived: { type: 'boolean' },
      },
    },
  },
] as const

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`invalid ${field}`)
  return value
}

/**
 * 解析 send_message 的 reply_to 输入为 McpBridge 三态：
 * - 参数缺省（属性未出现） → undefined（走 turn 锚点）
 * - 显式 null → null（跳出锚点）
 * - 正整数或纯数字字符串 → string（显式覆盖）
 * - 其他类型（false/负数/非数字字符串等） → undefined 兜底（不覆盖锚点）
 */
export function parseReplyTo(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return undefined
}

/**
 * 内置 MCP server（Streamable HTTP，仅监听 127.0.0.1）。
 * agent 通过它反向操作 Susie：主动发消息、查历史、列会话。
 * 无状态模式：每个请求独立 Server + Transport 实例（SDK 推荐做法）。
 */
export class SusieMcpServer {
  private httpServer: http.Server | null = null
  private bridge: McpBridge | null = null
  private readonly log: Logger
  url: string | null = null

  constructor(log: Logger = { info: () => {}, error: () => {} }) {
    this.log = log
  }

  setBridge(bridge: McpBridge): void {
    this.bridge = bridge
  }

  async start(preferredPort: number): Promise<string> {
    const server = http.createServer((req, res) => {
      if (req.url === undefined || !req.url.startsWith('/mcp')) {
        res.writeHead(404).end()
        return
      }
      void this.handle(req, res).catch((error: unknown) => {
        this.log.error(`mcp http 请求处理失败：${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    this.httpServer = server

    const port = await listen(server, preferredPort).catch(() => listen(server, 0))
    this.url = `http://127.0.0.1:${port}/mcp`
    return this.url
  }

  async stop(): Promise<void> {
    const server = this.httpServer
    this.httpServer = null
    this.url = null
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const mcpServer = this.buildServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void mcpServer.close()
    })
    await mcpServer.connect(transport)
    await transport.handleRequest(req, res)
  }

  private buildServer(): Server {
    const server = new Server({ name: 'susie', version: '1.0.0' }, { capabilities: { tools: {} } })

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const bridge = this.bridge
      if (bridge === null) {
        this.log.error(`mcp tool ${request.params.name} 被拒：susie service not ready`)
        return toolError('susie service not ready')
      }

      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      try {
        switch (request.params.name) {
          case 'send_message': {
            const file = args['file']
            const files = typeof file === 'string' ? [file] : Array.isArray(file) ? file.map(String) : []
            const sent = await bridge.sendMessage({
              channelId: asString(args['channel_id'], 'channel_id'),
              chatId: asString(args['chat_id'], 'chat_id'),
              content: typeof args['content'] === 'string' ? args['content'] : '',
              files,
              replyTo: parseReplyTo(args['reply_to']),
            })
            return toolResult(sent)
          }

          case 'list_messages': {
            const range = resolveDateRange({
              dateStart: typeof args['date_start'] === 'string' ? args['date_start'] : null,
              dateEnd: typeof args['date_end'] === 'string' ? args['date_end'] : null,
              dateRange: typeof args['date_range'] === 'string' ? args['date_range'] : null,
            })
            const messages = bridge.listMessages({
              channelId: asString(args['channel_id'], 'channel_id'),
              chatId: asString(args['chat_id'], 'chat_id'),
              num: typeof args['num'] === 'number' && args['num'] > 0 ? Math.floor(args['num']) : 1,
              dateStart: range.start,
              dateEnd: range.end,
            })
            return toolResult(messages)
          }

          case 'list_chats': {
            const channelId = typeof args['channel_id'] === 'string' ? args['channel_id'] : undefined
            return toolResult(bridge.listChats(channelId))
          }

          default:
            this.log.info(`mcp: agent 调用了不存在的工具 "${request.params.name}"`)
            return toolError(`unknown tool: ${request.params.name}`)
        }
      } catch (error) {
        // toolError 只返回给 agent；agent 可能不上报，这里必须留痕
        const detail = error instanceof Error ? error.message : String(error)
        this.log.error(`mcp tool ${request.params.name} 失败：${detail}`)
        return toolError(detail)
      }
    })

    return server
  }
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('unexpected server address'))
        return
      }
      resolve(address.port)
    })
  })
}
