// Telegram 跳转统一用 tg:// deeplink 直接唤起客户端（不经浏览器 t.me 中转）；
// openExternal 的协议白名单已包含 tg:。展示给用户看的地址仍写 t.me/<username>。

/** 打开某个 bot / 用户的对话：tg://resolve?domain=<username> */
export function tgResolveLink(username: string): string {
  return `tg://resolve?domain=${username}`
}
