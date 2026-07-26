import { describe, expect, expectTypeOf, it } from 'vitest'
import { eventChannel, invokeChannel } from './channel'
import type { ActionResult, AppInfo, IpcClient } from './contract'

describe('ipc 契约', () => {
  it('通道名派生：susie:<group>.<method> / susie-evt:<name>', () => {
    expect(invokeChannel('app', 'getInfo')).toBe('susie:app.getInfo')
    expect(eventChannel('config.state')).toBe('susie-evt:config.state')
  })

  it('类型断言：void req 零参、object req 取 z.input、res 提取为 Promise 值', () => {
    expectTypeOf<IpcClient['app']['getInfo']>().toEqualTypeOf<() => Promise<AppInfo>>()
    expectTypeOf<IpcClient['app']['setLoginItem']>().parameters.toEqualTypeOf<[{ enabled: boolean }]>()
    expectTypeOf<IpcClient['app']['setLoginItem']>().returns.toEqualTypeOf<Promise<ActionResult>>()
    expectTypeOf<IpcClient['app']['pickDirectory']>().toEqualTypeOf<() => Promise<string | null>>()
  })
})
