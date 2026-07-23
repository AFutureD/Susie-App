// 交互式登录句柄（对位 openai_codex _login.py）
import type { CodexClient } from './client'
import type { AccountLoginCompletedNotification } from './generated/v2/AccountLoginCompletedNotification'
import type { CancelLoginAccountResponse } from './generated/v2/CancelLoginAccountResponse'

async function waitForLoginCompleted(client: CodexClient, loginId: string): Promise<AccountLoginCompletedNotification> {
  client.registerLoginNotifications(loginId)
  try {
    for (;;) {
      const notification = await client.nextLoginNotification(loginId)
      if (notification.method === 'account/login/completed') {
        const payload = notification.params as unknown as AccountLoginCompletedNotification
        if (payload.loginId === loginId) return payload
      }
    }
  } finally {
    client.unregisterLoginNotifications(loginId)
  }
}

/** 浏览器 OAuth 登录：打开 authUrl，wait() 等待完成 */
export class ChatgptLoginHandle {
  private readonly client: CodexClient
  readonly loginId: string
  readonly authUrl: string

  constructor(client: CodexClient, loginId: string, authUrl: string) {
    this.client = client
    this.loginId = loginId
    this.authUrl = authUrl
  }

  wait(): Promise<AccountLoginCompletedNotification> {
    return waitForLoginCompleted(this.client, this.loginId)
  }

  cancel(): Promise<CancelLoginAccountResponse> {
    return this.client.accountLoginCancel(this.loginId)
  }
}

/** 设备码登录：向用户展示 verificationUrl + userCode，wait() 等待完成 */
export class DeviceCodeLoginHandle {
  private readonly client: CodexClient
  readonly loginId: string
  readonly verificationUrl: string
  readonly userCode: string

  constructor(client: CodexClient, loginId: string, verificationUrl: string, userCode: string) {
    this.client = client
    this.loginId = loginId
    this.verificationUrl = verificationUrl
    this.userCode = userCode
  }

  wait(): Promise<AccountLoginCompletedNotification> {
    return waitForLoginCompleted(this.client, this.loginId)
  }

  cancel(): Promise<CancelLoginAccountResponse> {
    return this.client.accountLoginCancel(this.loginId)
  }
}
