import fs from 'node:fs'
import { shell } from 'electron'
import { z } from 'zod'
import {
  assistantSchema,
  autoReviewSchema,
  bindingSchema,
  channelSettingsSchema,
  scheduledTaskSchema,
  userSchema,
  type ConfigMutationResult,
} from '../../../shared/config'
import { errorMessage } from '../../../shared/errors'
import { getWorkspaceDir } from '../../config/paths'
import type { ConfigStore } from '../../config/store'
import type { IpcHandlers } from '../router'

export interface ConfigHandlerDeps {
  config: ConfigStore
}

/** 用户可编辑载荷的语义校验失败：取第一条 issue 供表单内联展示（UI 反馈路径，不走异常） */
function invalid(message: string | undefined): ConfigMutationResult {
  return { ok: false, conflict: false, message: message ?? '入参不合法' }
}

export function configHandlers({ config }: ConfigHandlerDeps): IpcHandlers['config'] {
  return {
    get: () => config.state(),
    getRaw: () => ({ text: config.readRawText(), version: config.currentVersion }),
    saveRaw: ({ text, expectedVersion }) => config.saveRaw(text, expectedVersion),

    upsertChannel: ({ id, settings, expectedVersion }) => {
      const parsed = channelSettingsSchema.safeParse(settings)
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message)
      return config.upsertChannel(id, parsed.data, expectedVersion)
    },
    deleteChannel: ({ id, expectedVersion }) => config.deleteChannel(id, expectedVersion),

    upsertAssistant: ({ assistant, expectedVersion }) => {
      const parsed = assistantSchema.safeParse(assistant)
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message)
      return config.upsertAssistant(parsed.data, expectedVersion)
    },
    deleteAssistant: ({ id, expectedVersion }) => config.deleteAssistant(id, expectedVersion),

    setBindings: ({ bindings, expectedVersion }) => {
      const parsed = z.array(bindingSchema).safeParse(bindings)
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message)
      return config.setBindings(parsed.data, expectedVersion)
    },

    setUsers: ({ users, expectedVersion }) => {
      const parsed = z.array(userSchema).safeParse(users)
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message)
      return config.setUsers(parsed.data, expectedVersion)
    },

    setAutoReview: ({ autoReview, expectedVersion }) => {
      const parsed = autoReviewSchema.safeParse(autoReview)
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message)
      return config.setAutoReview(parsed.data, expectedVersion)
    },

    upsertScheduledTask: ({ task, expectedVersion }) => {
      const parsed = scheduledTaskSchema.safeParse(task)
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message)
      return config.upsertScheduledTask(parsed.data, expectedVersion)
    },
    deleteScheduledTask: ({ id, expectedVersion }) => config.deleteScheduledTask(id, expectedVersion),
  }
}

export function assistantsHandlers({ config }: ConfigHandlerDeps): IpcHandlers['assistants'] {
  return {
    openWorkdir: async ({ id }) => {
      const assistant = config.state().config.assistants.find((item) => item.id === id)
      if (assistant === undefined) return { ok: false, message: `assistant 不存在：${id}` }
      const dir = assistant.work_dir ?? getWorkspaceDir(assistant.id)
      try {
        fs.mkdirSync(dir, { recursive: true })
        const failure = await shell.openPath(dir)
        return failure === '' ? { ok: true } : { ok: false, message: failure }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
  }
}
