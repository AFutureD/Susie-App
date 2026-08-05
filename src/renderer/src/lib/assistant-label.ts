import { DEFAULT_ASSISTANT_ID, type AssistantConfig } from '../../../shared/config'

/** default 助手的固定展示名（不可改名；配置里的 name 对它不生效） */
export const DEFAULT_ASSISTANT_LABEL = '默认'

/** 助手的展示名：default 恒为「默认」；其余 name 缺省/全空白时回退 id（全应用统一入口） */
export function assistantLabel(assistant: Pick<AssistantConfig, 'id' | 'name'>): string {
  if (assistant.id === DEFAULT_ASSISTANT_ID) return DEFAULT_ASSISTANT_LABEL
  const name = assistant.name?.trim() ?? ''
  return name === '' ? assistant.id : name
}
