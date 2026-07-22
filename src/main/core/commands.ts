// 命令系统（对位 Python CommandChain 的功能，去掉反射式注入）。
// 消息以 "/" 开头时进入命令分发；未注册的命令原样交给 assistant。

export interface CommandContext {
  channelId: string
  chatId: string
  reply: (text: string) => Promise<void>
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<string | void> | string | void

export interface Command {
  name: string
  description: string
  handler: CommandHandler
}

export function parseCommandText(text: string): { name: string; args: string[] } | null {
  if (!text.startsWith('/')) return null
  const tokens = text.slice(1).trim().split(/\s+/)
  const head = tokens[0]
  if (head === undefined || head === '') return null
  // Telegram 群里的命令形如 /help@my_bot
  const name = head.split('@')[0] ?? head
  if (name === '') return null
  return { name, args: tokens.slice(1) }
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()

  constructor(private readonly parent?: CommandRegistry) {
    if (parent === undefined) {
      this.register({
        name: 'help',
        description: '显示可用命令',
        handler: () => this.helpText(),
      })
    }
  }

  register(command: Command): void {
    this.commands.set(command.name, command)
  }

  list(): Command[] {
    const merged = new Map<string, Command>()
    for (const command of this.parent?.list() ?? []) merged.set(command.name, command)
    for (const command of this.commands.values()) merged.set(command.name, command)
    return [...merged.values()]
  }

  get(name: string): Command | undefined {
    return this.commands.get(name) ?? this.parent?.get(name)
  }

  helpText(): string {
    return this.list()
      .map((command) => `/${command.name}: ${command.description}`)
      .join('\n')
  }

  /** 返回 false 表示不是已注册命令（调用方应转交 assistant） */
  async execute(ctx: CommandContext, name: string, args: string[]): Promise<boolean> {
    const command = this.get(name)
    if (command === undefined) return false

    try {
      const result = await command.handler(ctx, args)
      if (typeof result === 'string' && result !== '') {
        await ctx.reply(result)
      }
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }
}
