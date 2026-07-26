// codex 模型枚举：起一个一次性的 app-server 连接走 model/list，拿到即关。
// UI 下拉（service.listAgentModels）在没有常驻 runtime 时使用；
// runtime 内部枚举复用自身常驻连接（见 codex.ts fetchModelOptions）。
import { Codex, type Model } from '@susie/codex-app-server'
import type { AgentModelOption } from '../types'

/** model/list data → 候选列表（过滤 hidden，displayName/description 缺省回退） */
export function mapAppServerModels(data: Model[]): AgentModelOption[] {
  const options: AgentModelOption[] = []
  for (const model of data) {
    if (model.hidden) continue
    if (model.model === '') continue
    options.push({
      value: model.model,
      name: model.displayName !== '' ? model.displayName : model.model,
      ...(model.description !== '' ? { description: model.description } : {}),
    })
  }
  return options
}

export interface FetchCodexModelsOptions {
  /** codex 可执行文件路径；'codex' 表示交给 PATH */
  codexPath: string
  /** 前置到 PATH 的目录（vendor codex-path） */
  pathDirs?: string[]
  timeoutMs?: number
}

export async function fetchCodexModels(options: FetchCodexModelsOptions): Promise<AgentModelOption[]> {
  const codex = new Codex({
    codexPath: options.codexPath,
    pathDirs: options.pathDirs ?? [],
    clientName: 'susie',
    clientTitle: 'Susie',
  })
  const timeoutMs = options.timeoutMs ?? 15_000
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('codex app-server model/list 超时')), timeoutMs)
  })
  try {
    const response = await Promise.race([codex.models(), timeout])
    return mapAppServerModels(response.data)
  } finally {
    clearTimeout(timer)
    codex.close()
  }
}
