import type { ReactNode } from 'react'
import type { ChannelSettings, ConfigState } from '../../../../shared/config'

// 通道表单的 per-type 注册协议：新增一种通道类型 = 新建 <type>-form.tsx + 在 index.tsx 的
// CHANNEL_FORMS 表登记一项。列表/启停/删除等通用逻辑留在 index.tsx，不感知平台字段。

export interface ChannelFormProps {
  /** 编辑既有通道时的 id；新建时缺省 */
  channelId?: string
  /** 编辑时的当前配置；类型由注册表按 settings.type 保证与表单匹配 */
  initial?: ChannelSettings
  state: ConfigState
  onDone: () => void
  /** 仅新建成功时回调（进入 owner 绑定） */
  onCreated?: (id: string) => void
}

export interface ChannelTypeUi {
  Form: (props: ChannelFormProps) => ReactNode
  /** 列表行的类型特有摘要（如 Telegram 的脱敏 token） */
  Summary: (props: { settings: ChannelSettings }) => ReactNode
}
