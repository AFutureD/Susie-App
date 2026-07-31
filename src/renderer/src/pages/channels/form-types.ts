import type { ReactNode } from 'react'
import type { ChannelSettings, ConfigState } from '../../../../shared/config'

// 通道行内编辑的 per-type 注册协议：新增一种通道类型 = 新建 <type>-form.tsx + 在 index.tsx 的
// CHANNEL_UI 表登记一项。新增入口是统一的 AddBotForm（token → getMe 自动识别类型），
// 本协议只覆盖编辑态；列表/启停/删除等通用逻辑留在 index.tsx，不感知平台字段。

export interface ChannelFormProps {
  channelId: string
  /** 当前配置；类型由注册表按 settings.type 保证与表单匹配 */
  initial: ChannelSettings
  state: ConfigState
  onDone: () => void
}

export interface ChannelTypeUi {
  Form: (props: ChannelFormProps) => ReactNode
  /** 列表行的类型特有摘要（如 Telegram 的脱敏 token） */
  Summary: (props: { settings: ChannelSettings }) => ReactNode
}
