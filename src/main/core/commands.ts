// 命令系统（对位 Python CommandChain 的功能，去掉反射式注入）。
// 消息以 "/" 开头时进入命令分发；未注册的命令原样交给 assistant。

export interface CommandContext {
  channelId: string
  chatId: string
  reply: (text: string) => Promise<void>
}

export type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<string | void> | string | void

/** 命令的静态描述——供 Telegram setMyCommands 等菜单注册在无 handler 上下文时枚举 */
export interface CommandSpec {
  name: string
  description: string
  /**
   * 权限分类：缺省 true = 需要审核（审核档用户执行须经 owner 批准）；
   * false = 不需要审核（无权限也直接响应；忽略档除外——显式拉黑强于免审）
   */
  gated?: boolean
}

export interface Command extends CommandSpec {
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
    // 对位 Python CommandChain：每一层都注册绑定到本层的 help——
    // chat 层的 help 遮蔽全局层，list() 合并父链后才能列出全集
    this.register({
      name: 'help',
      description: '显示可用命令',
      gated: false,
      handler: () => this.helpText(),
    })
  }

  register(command: Command): void {
    this.commands.set(command.name, command)
  }

  /** 批量注册（对位 Python CommandProvider 协议：组件自述命令，装配方逐个登记） */
  registerAll(commands: Iterable<Command>): void {
    for (const command of commands) this.register(command)
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
