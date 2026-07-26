import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// 端到端：驱动真实 Electron 实例（隔离 SUSIE_CONFIG_DIR / SUSIE_USER_DATA_DIR，
// 不触碰真实配置，也不与正在运行的 dev 实例抢单实例锁）。
// 用例之间共享同一个应用实例，串行执行。

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let win: Page
let configDir: string
let configPath: string

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

  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
})

test('首次启动：出现 onboarding 引导，跳过后进入主界面', async () => {
  // 空配置 + 无完成标记 → 引导第 1 步（添加频道）
  await expect(win.getByText('欢迎使用 Susie')).toBeVisible()
  await expect(win.getByText('第 1 步 · 添加 Telegram Bot')).toBeVisible()
  await expect(win.getByText(/BotFather 创建 Bot/)).toBeVisible()

  await win.getByRole('button', { name: /跳过引导/ }).click()
  await expect(win.getByText('欢迎使用 Susie')).toHaveCount(0)

  // 主界面：侧边栏挂载，频道页为空态（与 app.tsx NAV_ITEMS 数量同步）
  await expect(win.locator('nav a')).toHaveCount(8)
  await expect(win.getByText('还没有配置任何频道')).toBeVisible()
})

test('UI 新建频道并落盘 config.toml；随即进入 Owner 绑定', async () => {
  await win.getByRole('button', { name: '新增频道' }).click()
  await win.getByPlaceholder('my_bot').fill('e2e_bot')
  await win.getByPlaceholder('123456:bot-token').fill('10001:e2e-token')
  await expect(win.getByPlaceholder('my_bot')).toHaveValue('e2e_bot')
  await expect(win.getByPlaceholder('123456:bot-token')).toHaveValue('10001:e2e-token')
  await win.getByRole('button', { name: '保存', exact: true }).click()

  // 新建成功 → 立即弹出 Owner 绑定（假 token 拿不到深链，但监听面板照常出现）；此处稍后再设
  await expect(win.getByRole('heading', { name: '绑定 Owner' })).toBeVisible()
  await expect(win.getByText('正在等待你的消息…')).toBeVisible()
  await win.getByRole('button', { name: '稍后在「用户」页设置' }).click()
  await expect(win.getByRole('heading', { name: '绑定 Owner' })).toHaveCount(0)

  await expect(win.getByText('e2e_bot', { exact: true })).toBeVisible()
  // token 打码展示
  await expect(win.getByText(/token 1000••••oken/)).toBeVisible()

  const text = readFileSync(configPath, 'utf-8')
  expect(text).toContain('[channels.e2e_bot]')
  expect(text).toContain('10001:e2e-token')
})

test('外部编辑 config.toml 热加载进 UI', async () => {
  appendFileSync(configPath, '\n[channels.hot_bot]\ntype = "telegram_bot"\ntoken = "1:hot"\n')
  await expect(win.getByText('hot_bot', { exact: true })).toBeVisible()
})

test('树形面板把「默认」会话指派给助手并落盘', async () => {
  await win.getByRole('link', { name: '助手' }).click()

  // 左栏树：频道行 + 每频道恒存的「默认」行（e2e_bot 先于 hot_bot 声明，取第一个）
  await expect(win.getByText('e2e_bot', { exact: true })).toBeVisible()
  const defaultRow = win.getByText('默认（其余会话）').first()
  await expect(defaultRow).toBeVisible()

  // 选中「默认」行 → 右栏详情选择助手
  await defaultRow.click()
  await win.getByLabel('助手').selectOption('default')

  // 通道默认绑定落盘为 chat_id = "*"（'*' 仅存在于数据层，UI 不出现）
  await expect.poll(() => readFileSync(configPath, 'utf-8')).toContain('[[bindings]]')
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

  // 运行态仍是 last-good：频道页数据完好
  await win.getByRole('link', { name: '频道' }).click()
  await expect(win.getByText('e2e_bot', { exact: true })).toBeVisible()
})

test('Agent 页：同构列表渲染 Codex 行与安装态', async () => {
  await win.getByRole('link', { name: 'Agent' }).click()
  // registry 里可能有同名 agent（codex-acp 的显示名也是 Codex）——用唯一的 id 徽标定位内置行
  await expect(win.getByText('codex', { exact: true })).toBeVisible()
  await expect(win.getByText(/可用（.+）|未安装/).first()).toBeVisible()
  await expect(win.getByRole('button', { name: '刷新' })).toBeVisible()
})

test('历史页：空态与会话列表骨架', async () => {
  await win.getByRole('link', { name: '历史' }).click()
  await expect(win.getByText('还没有任何消息记录')).toBeVisible()
  await expect(win.getByPlaceholder('搜索全部历史（回车）')).toBeVisible()
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
