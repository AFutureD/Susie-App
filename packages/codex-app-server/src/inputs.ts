// 输入归一化（对位 openai_codex _inputs.py）：字符串 / 单项 / 数组 → wire UserInput[]。
// item 形状即 wire 格式子集（text 变体的 text_elements 交给 serde 默认值）。
import type { UserInput } from './generated/v2/UserInput'

export interface TextInput {
  type: 'text'
  text: string
}

export interface ImageInput {
  type: 'image'
  url: string
}

export interface LocalImageInput {
  type: 'localImage'
  path: string
}

export interface SkillInput {
  type: 'skill'
  name: string
  path: string
}

export interface MentionInput {
  type: 'mention'
  name: string
  path: string
}

export type InputItem = TextInput | ImageInput | LocalImageInput | SkillInput | MentionInput
export type RunInput = string | InputItem | InputItem[]

export function toWireInput(input: RunInput): UserInput[] {
  const items = typeof input === 'string' ? [{ type: 'text', text: input } satisfies TextInput] : [input].flat()
  return items.map((item) => {
    switch (item.type) {
      case 'text':
        // text_elements 可选（serde default），生成类型标记为必填 → 显式补空数组
        return { type: 'text', text: item.text, text_elements: [] }
      case 'image':
        return { type: 'image', url: item.url }
      case 'localImage':
        return { type: 'localImage', path: item.path }
      case 'skill':
        return { type: 'skill', name: item.name, path: item.path }
      case 'mention':
        return { type: 'mention', name: item.name, path: item.path }
    }
  })
}
