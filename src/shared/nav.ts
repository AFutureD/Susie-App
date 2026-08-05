/**
 * 侧边栏导航清单的唯一事实源：app.tsx 渲染、main 的 smoke 断言、e2e 断言三处同源。
 * 加/删页面只改这里（i18n key 为 `nav.<name>`，路由为 `/<name>`）。
 */
export const NAV_ROUTES = [
  'assistants',
  'channels',
  'users',
  'chats',
  'agents',
  'skills',
  'tasks',
  'intelligence',
  'logs',
  'settings',
] as const

export type NavRoute = (typeof NAV_ROUTES)[number]
