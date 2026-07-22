import type { MessagePart } from '../../shared/messages'

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const MAX_QUOTE_BODY = 2800

/**
 * 出站渲染：parts → Telegram HTML（parse_mode=HTML）。
 * 折叠块用官方 <blockquote expandable>（对位 Python 版的 <details> rich message）。
 * 文件 part 不在此渲染，由通道单独 sendDocument。
 */
export function renderMessageHtml(parts: MessagePart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    switch (part.kind) {
      case 'text':
        if (part.text !== '') chunks.push(escapeHtml(part.text))
        break
      case 'quote': {
        const body = part.body.length > MAX_QUOTE_BODY ? `${part.body.slice(0, MAX_QUOTE_BODY)}\n…(截断)` : part.body
        chunks.push(`<blockquote expandable><b>${escapeHtml(part.title)}</b>\n${escapeHtml(body)}</blockquote>`)
        break
      }
      case 'file':
        break
    }
  }
  return chunks.join('\n\n')
}

/** HTML 发送失败（实体解析错误等）时的纯文本降级 */
export function renderMessagePlain(parts: MessagePart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    switch (part.kind) {
      case 'text':
        if (part.text !== '') chunks.push(part.text)
        break
      case 'quote':
        chunks.push(`[${part.title}]\n${part.body}`)
        break
      case 'file':
        break
    }
  }
  return chunks.join('\n\n')
}
