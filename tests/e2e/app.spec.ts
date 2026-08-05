import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { NAV_ROUTES } from '../../src/shared/nav'

// 端到端：驱动真实 Electron 实例（隔离 SUSIE_CONFIG_DIR / SUSIE_USER_DATA_DIR，
// 不触碰真实配置，也不与正在运行的 dev 实例抢单实例锁）。
// 用例之间共享同一个应用实例，串行执行。
//
// 新增渠道走统一 AddBotForm：保存前真调 getMe 识别普通渠道 / manager，假 token 在
// 真实 API 必然失败——经 SUSIE_TG_API_BASE 把 raw 客户端（bot-api.ts）指到本地 stub。
// 普通渠道轮询走 node-telegram-bot-api（不经 stub），错误态本就被 UI 容忍。

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let win: Page
let configDir: string
let configPath: string
let tgStub: Server
/** e2e_bot 的 Telegram 隐私模式（getMe.can_read_all_group_messages = !此值）；群警告用例中途翻转它模拟用户在 BotFather 关闭 */
let e2eBotPrivacyMode = true

/**
 * 本地 Telegram Bot API stub：只实现 getMe，且只认识 e2e_bot 的 token——
 * 其余 token（hot_bot / conflict_bot）返回 401，用于验证身份拉取失败时 UI 回退渠道 id。
 */
function startTgStub(): Promise<string> {
  tgStub = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/bot10001:e2e-token/getMe') {
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            id: 10001,
            is_bot: true,
            first_name: 'E2E Bot',
            username: 'e2e_bot',
            can_manage_bots: false,
            can_read_all_group_messages: !e2eBotPrivacyMode,
          },
        }),
      )
      return
    }
    if (/^\/bot[^/]+\/getMe$/.test(req.url ?? '')) {
      res.statusCode = 401
      res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
  })
  return new Promise((resolve) => {
    tgStub.listen(0, '127.0.0.1', () => {
      const { port } = tgStub.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

test.beforeAll(async () => {
  configDir = mkdtempSync(path.join(tmpdir(), 'susie-e2e-config-'))
  configPath = path.join(configDir, 'config.toml')

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env['VITE_DEV_SERVER_URL'] // 强制加载打包后的 renderer
  delete env['SUSIE_SMOKE']
  env['SUSIE_CONFIG_DIR'] = configDir
  env['SUSIE_USER_DATA_DIR'] = mkdtempSync(path.join(tmpdir(), 'susie-e2e-userdata-'))
  env['SUSIE_TG_API_BASE'] = await startTgStub()

  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise((resolve) => tgStub?.close(resolve))
})

test('首次启动：出现 onboarding 引导（Agent 最先），跳过后进入主界面', async () => {
  // 启动时 config.toml 不存在（firstRun）→ 引导第 1 步（准备 Agent——Agent 是核心第一步）
  await expect(win.getByText('欢迎使用 Susie')).toBeVisible()
  await expect(win.getByRole('heading', { name: '准备 Agent' })).toBeVisible()

  // 第 2 步：添加 Manager Bot（含示范视频）
  await win.getByRole('button', { name: '下一步' }).click()
  await expect(win.getByRole('heading', { name: '添加 Manager Bot' })).toBeVisible()
  await expect(win.getByText(/Bot Management Mode/)).toBeVisible()
  await expect(win.locator('video')).toBeVisible()

  await win.getByRole('button', { name: /跳过引导/ }).click()
  await expect(win.getByText('欢迎使用 Susie')).toHaveCount(0)

  // 主界面：侧边栏挂载，首页为 NAV_ROUTES[0]（助手页，导航清单同源 shared/nav.ts）；
  // default 助手随默认配置存在且不可删除（无删除按钮）
  await expect(win.locator('nav a')).toHaveCount(NAV_ROUTES.length)
  await expect(win.getByText('default', { exact: true }).first()).toBeVisible()
})

test('UI 新建渠道并落盘 config.toml；随即进入 Owner 绑定与默认助手绑定', async () => {
  await win.getByRole('link', { name: '渠道' }).click()
  await win.getByRole('button', { name: '新增', exact: true }).click()
  await win.getByPlaceholder('my_bot').fill('e2e_bot')
  await win.getByPlaceholder('123456:bot-token').fill('10001:e2e-token')
  await expect(win.getByPlaceholder('my_bot')).toHaveValue('e2e_bot')
  await expect(win.getByPlaceholder('123456:bot-token')).toHaveValue('10001:e2e-token')
  await win.getByRole('button', { name: '保存', exact: true }).click()

  // 保存前 getMe 打到本地 stub（非 manager → 普通渠道）→ 立即弹出 Owner 绑定；此处稍后再设
  await expect(win.getByRole('heading', { name: '绑定 Owner' })).toBeVisible()
  await expect(win.getByText('t.me/e2e_bot')).toBeVisible()
  await expect(win.getByText('正在等待你的消息…')).toBeVisible()
  await win.getByRole('button', { name: '稍后在「用户」页设置' }).click()
  await expect(win.getByRole('heading', { name: '绑定 Owner' })).toHaveCount(0)

  // Owner 之后必弹「绑定默认助手」；直接关闭 → 回落 default 助手 + 默认不响应
  await expect(win.getByRole('heading', { name: '绑定默认助手' })).toBeVisible()
  await win.getByRole('button', { name: /暂不选择/ }).click()
  await expect(win.getByRole('heading', { name: '绑定默认助手' })).toHaveCount(0)
  await expect.poll(() => readFileSync(configPath, 'utf-8')).toContain('[[bindings]]')

  // 渠道行：getMe 身份 → 标题 display name、副标题 @username（token 不再出现在列表）
  await expect(win.getByText('E2E Bot', { exact: true })).toBeVisible()
  await expect(win.getByText('@e2e_bot')).toBeVisible()

  const text = readFileSync(configPath, 'utf-8')
  expect(text).toContain('[channels.e2e_bot]')
  expect(text).toContain('10001:e2e-token')
  // 回落绑定：通道默认 + default 助手 + respond=false
  expect(text).toContain('channel = "e2e_bot"')
  expect(text).toContain('chat_id = "*"')
  expect(text).toContain('assistant_id = "default"')
  expect(text).toContain('respond = false')
})

test('外部编辑 config.toml 热加载进 UI', async () => {
  appendFileSync(configPath, '\n[channels.hot_bot]\ntype = "telegram_bot"\ntoken = "1:hot"\n')
  // stub 不认识该 token → 无身份，标题回退渠道 id
  await expect(win.getByText('hot_bot', { exact: true })).toBeVisible()
})

test('会话页树形面板：切换通道默认的「是否响应」并落盘', async () => {
  await win.getByRole('link', { name: '会话', exact: true }).click()

  // 左栏树：渠道行（display name）+ 每渠道恒存的「默认」行（e2e_bot 的默认绑定由上一步回落写入）
  await expect(win.getByText('E2E Bot', { exact: true })).toBeVisible()
  const defaultRow = win.getByText('默认（其余会话）').first()
  await expect(defaultRow).toBeVisible()

  // 选中「默认」行 → 右栏详情：助手已是 default（回落写入），打开「响应未列出的会话」。
  // 受控 checkbox 经 IPC 写盘 + config 广播后才更新，用 click + 重试断言而非 check()
  await defaultRow.click()
  await expect(win.getByLabel('助手')).toHaveValue('default')
  await win.getByLabel('响应未列出的会话').click()
  await expect(win.getByLabel('响应未列出的会话')).toBeChecked()

  // respond 翻转落盘（canonical 序列化省写默认值 true 与否取决于 schema——此处断言不再是 false）
  await expect.poll(() => readFileSync(configPath, 'utf-8')).not.toContain('respond = false')
  const text = readFileSync(configPath, 'utf-8')
  expect(text).toContain('channel = "e2e_bot"')
  expect(text).toContain('assistant_id = "default"')
  expect(text).toContain('chat_id = "*"')
})

test('用户页：无 Owner 警示、空名单与绑定入口', async () => {
  await win.getByRole('link', { name: '用户' }).click()
  // 两个频道卡片都渲染，且都提示未绑定 Owner + 直达绑定入口
  await expect(win.getByText(/未绑定 Owner/).first()).toBeVisible()
  await expect(win.getByRole('button', { name: '绑定 Owner' }).first()).toBeVisible()
  await expect(win.getByText('暂无登记用户').first()).toBeVisible()
  await expect(win.getByRole('button', { name: '添加用户' }).first()).toBeVisible()
})

test('Raw 编辑器：非法配置被拒绝，不影响运行态', async () => {
  await win.getByRole('link', { name: '设置' }).click()
  const editor = win.locator('textarea')
  await expect(editor).toHaveValue(/\[channels\.e2e_bot\]/)

  await editor.fill('channels = 1')
  await win.getByRole('button', { name: '校验并保存' }).click()
  await expect(win.getByText(/配置校验失败|TOML 解析失败/)).toBeVisible()

  // 运行态仍是 last-good：渠道页数据完好
  await win.getByRole('link', { name: '渠道' }).click()
  await expect(win.getByText('E2E Bot', { exact: true })).toBeVisible()
})

test('Agent 页：同构列表渲染 Codex 行与安装态', async () => {
  await win.getByRole('link', { name: 'Agent' }).click()
  // registry 里可能有同名 agent（codex-acp 的显示名也是 Codex）——用唯一的 id 徽标定位内置行
  await expect(win.getByText('codex', { exact: true })).toBeVisible()
  await expect(win.getByText(/可用（.+）|未安装/).first()).toBeVisible()
  await expect(win.getByRole('button', { name: '刷新' })).toBeVisible()
})

test('技能页：维度切换、搜索与获取入口', async () => {
  await win.getByRole('link', { name: '技能' }).click()
  // 列表内容依赖真实 HOME（只读扫描），断言只做 presence，不做数量/空态
  await expect(win.getByRole('button', { name: '全局' })).toBeVisible()
  await expect(win.getByRole('button', { name: '助手', exact: true })).toBeVisible()
  await expect(win.getByPlaceholder('搜索技能')).toBeVisible()
  await expect(win.getByText(/^目录 /)).toBeVisible()

  // 获取技能弹窗：GitHub 与 skillhubs 两个来源
  await win.getByRole('button', { name: '获取技能' }).click()
  await expect(win.getByText('从 GitHub 仓库')).toBeVisible()
  await expect(win.getByPlaceholder('owner/repo 或 https://github.com/...')).toBeVisible()
  await expect(win.getByText('从 skillhubs registry')).toBeVisible()
  await expect(win.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  await win.getByRole('button', { name: '关闭' }).click()
  await expect(win.getByText('从 GitHub 仓库')).not.toBeVisible()
  await expect(win.getByPlaceholder('搜索技能')).toBeVisible()
})

test('会话页：绑定为主页面，会话历史降为二级页面', async () => {
  await win.getByRole('link', { name: '会话', exact: true }).click()
  // 主页面 = 会话绑定树
  await expect(win.getByText('默认（其余会话）').first()).toBeVisible()

  // 二级页面 = 会话历史（空态 + 搜索框），可返回
  await win.getByRole('link', { name: '会话历史' }).click()
  await expect(win.getByText('还没有任何消息记录')).toBeVisible()
  await expect(win.getByPlaceholder('搜索全部历史（回车）')).toBeVisible()
  await win.getByRole('link', { name: '← 返回会话' }).click()
  await expect(win.getByText('默认（其余会话）').first()).toBeVisible()
})

test('会话页：添加会话即落盘（跟随渠道默认助手）', async () => {
  // e2e_bot 的 ＋ 按钮 → 无历史会话 → 手动输入兜底
  await win.getByRole('button', { name: '添加会话' }).first().click()
  await expect(win.getByText(/添加会话到/)).toBeVisible()
  await win.getByPlaceholder('P:123456').fill('P:77')
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect(win.getByText(/添加会话到/)).toHaveCount(0)

  // 添加即写入精确绑定：chat_id 落盘、assistant_id 省写（跟随渠道默认）
  await expect.poll(() => readFileSync(configPath, 'utf-8')).toContain('chat_id = "P:77"')
  const section = readFileSync(configPath, 'utf-8')
    .split('[[bindings]]')
    .find((part) => part.includes('chat_id = "P:77"'))
  expect(section).toBeDefined()
  expect(section).not.toContain('assistant_id')

  // 右栏详情默认选中新会话：跟随渠道默认 + 响应开启
  await expect(win.getByLabel('助手')).toHaveValue('')
  await expect(win.getByLabel('响应此会话')).toBeChecked()
})

test('会话页：群会话显示隐私模式警告，教程视频可弹出，重新检测后翻转', async () => {
  await win.getByRole('link', { name: '会话', exact: true }).click()
  await win.getByRole('button', { name: '添加会话' }).first().click()
  await expect(win.getByText(/添加会话到/)).toBeVisible()
  await win.getByPlaceholder('P:123456').fill('S:-100999')
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect(win.getByText(/添加会话到/)).toHaveCount(0)

  // 群类型 + stub getMe 的 can_read_all_group_messages=false → amber 警告
  await expect(win.getByText('Bot 暂时无法响应群里的普通消息')).toBeVisible()

  // 教程视频弹窗（onboarding 已关闭，此时页面上只有这一个 video）
  await win.getByRole('button', { name: '查看设置教程' }).click()
  await expect(win.getByText('在 BotFather 关闭隐私模式')).toBeVisible()
  await expect(win.locator('video')).toBeVisible()
  await win.locator('div.fixed.inset-0').click({ position: { x: 10, y: 10 } })
  await expect(win.getByText('在 BotFather 关闭隐私模式')).toHaveCount(0)

  // 模拟用户在 BotFather 关闭隐私模式 → 重新检测 → 警告翻转为正向状态行
  e2eBotPrivacyMode = false
  await win.getByRole('button', { name: '重新检测' }).click()
  await expect(win.getByText('隐私模式已关闭，Bot 可读取群内全部消息。')).toBeVisible()
  await expect(win.getByText('Bot 暂时无法响应群里的普通消息')).toHaveCount(0)
})

test('任务页：新建定时任务（默认调度 + 弹窗选会话）并落盘', async () => {
  await win.getByRole('link', { name: '任务' }).click()
  await expect(win.getByText('还没有定时任务。')).toBeVisible()

  await win.getByRole('button', { name: '新建任务' }).click()
  await win.getByLabel('名称').fill('E2E 日报')
  await win.getByLabel('任务内容').fill('输出一句 e2e 测试结果')
  await expect(win.getByLabel('名称')).toHaveValue('E2E 日报')
  await expect(win.getByLabel('任务内容')).toHaveValue('输出一句 e2e 测试结果')

  // 调度默认预设的预览态（不出现 cron 表达式）
  await expect(win.getByText('每天 09:00')).toBeVisible()

  // 「添加会话」弹窗（复用会话绑定的选择器）；无历史会话 → 手动输入兜底
  await win.getByRole('button', { name: '添加会话' }).click()
  await expect(win.getByText(/添加会话到/)).toBeVisible()
  await win.getByPlaceholder('P:123456').fill('P:42')
  await expect(win.getByPlaceholder('P:123456')).toHaveValue('P:42')
  await win.getByRole('button', { name: '添加', exact: true }).click()
  await expect(win.getByText(/添加会话到/)).toHaveCount(0)
  await win.getByRole('button', { name: '保存', exact: true }).click()

  // 卡片出现
  await expect(win.getByText('E2E 日报')).toBeVisible()
  await expect(win.getByText('→ P:42')).toBeVisible()
  await expect(win.getByText('尚未执行过')).toBeVisible()

  // 执行历史在子页面
  await win.getByRole('link', { name: '执行历史' }).click()
  await expect(win.getByText('还没有执行记录。')).toBeVisible()
  await win.getByRole('link', { name: '← 返回定时任务' }).click()
  await expect(win.getByText('E2E 日报')).toBeVisible()

  const text = readFileSync(configPath, 'utf-8')
  expect(text).toContain('[[scheduled_tasks]]')
  expect(text).toContain('name = "E2E 日报"')
  expect(text).toContain('schedule = "0 9 * * *"')
  expect(text).toContain('chat_id = "P:42"')
})

test('Raw 编辑器：外部变更后提示版本冲突', async () => {
  await win.getByRole('link', { name: '设置' }).click()
  await win.getByRole('button', { name: '重新载入' }).click()
  await expect(win.locator('textarea')).toHaveValue(/\[channels\.e2e_bot\]/)

  // 外部再改一笔，令 raw 编辑器持有的版本过期
  appendFileSync(configPath, '\n[channels.conflict_bot]\ntype = "telegram_bot"\ntoken = "1:c"\n')
  await expect(win.getByText('配置已在外部发生变化')).toBeVisible()

  // 过期版本保存会被乐观并发拒绝
  await win.getByRole('button', { name: '校验并保存' }).click()
  await expect(win.getByText(/配置已被其他修改更新/)).toBeVisible()

  await win.screenshot({ path: 'test-results/app-settings.png' })
})
