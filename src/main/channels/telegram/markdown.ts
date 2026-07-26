// Markdown → Telegram HTML（https://core.telegram.org/bots/api#formatting-options）。
// 对位 Python 版：text part 一律按 Markdown 解析后发送（telethon markdown.parse）。
// agent 输出是 CommonMark/GFM，这里转换 Telegram 支持的子集；
// 不支持的块级结构降级为可读文本（标题→粗体、列表→圆点、表格→pre）。

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function markdownToTelegramHtml(markdown: string): string {
  // \u0000 是内部占位符定界符，输入里出现一律剔除（Telegram 也不接受 NUL）
  const lines = markdown.replaceAll('\u0000', '').split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*).*$/.exec(line)
    if (fence !== null) {
      const marker = fence[2] ?? ''
      const close = new RegExp(`^\\s*${marker.startsWith('`') ? '`' : '~'}{${marker.length},}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i++
      }
      if (i < lines.length) i++ // 跳过闭合围栏；无闭合则吃到结尾
      const lang = /^[\w+#.-]+$/.test(fence[3] ?? '') ? fence[3] : ''
      const code = escapeHtml(body.join('\n'))
      out.push(lang !== '' ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`)
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''))
        i++
      }
      // 只剥一层引用；Telegram 不支持 blockquote 嵌套
      out.push(`<blockquote>${quoted.map(renderLine).join('\n')}</blockquote>`)
      continue
    }

    // GFM 表格没有对应实体，整块进 pre 保持等宽对齐
    if (/^\s*\|.+\|\s*$/.test(line)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i] ?? '')) {
        rows.push(lines[i] ?? '')
        i++
      }
      out.push(`<pre>${escapeHtml(rows.join('\n'))}</pre>`)
      continue
    }

    out.push(renderLine(line))
    i++
  }

  return out.join('\n')
}

function renderLine(line: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(line)
  if (heading !== null) return `<b>${renderInline(heading[1] ?? '')}</b>`

  if (/^ {0,3}([-*_])( *\1){2,}\s*$/.test(line)) return '———'

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (bullet !== null) return `${bullet[1] ?? ''}• ${renderInline(bullet[2] ?? '')}`

  const ordered = /^(\s*\d+[.)]\s+)(.*)$/.exec(line)
  if (ordered !== null) return `${ordered[1] ?? ''}${renderInline(ordered[2] ?? '')}`

  return renderInline(line)
}

function renderInline(text: string): string {
  // 已生成的 HTML 片段进 stash，防止后续替换命中标签/URL 内部字符
  const tokens: string[] = []
  const stash = (html: string): string => {
    tokens.push(html)
    return `\u0000${tokens.length - 1}\u0000`
  }

  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => stash(`<code>${escapeHtml(code)}</code>`))
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) =>
    stash(`<a href="${escapeHtml(url).replaceAll('"', '%22')}">${escapeHtml(url)}</a>`),
  )
  out = escapeHtml(out)
  out = out.replace(
    /\[([^\]\n]+)\]\(([^()\s]+)\)/g,
    (_, label: string, href: string) => `${stash(`<a href="${href.replaceAll('"', '%22')}">`)}${label}${stash('</a>')}`,
  )

  out = out.replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<b><i>$1</i></b>')
  out = out.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>')
  out = out.replace(/__(?!\s)(.+?)(?<!\s)__/g, '<b>$1</b>')
  out = out.replace(/\|\|(?!\s)(.+?)(?<!\s)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
  out = out.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>')
  out = out.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<i>$1</i>')
  // 下划线斜体要求词边界，避免命中 snake_case / URL 路径
  out = out.replace(/(?<![\w\\])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '<i>$1</i>')

  // oxlint-disable-next-line no-control-regex -- NUL 定界符是内部约定，输入侧已剔除
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => tokens[Number(index)] ?? '')
}
