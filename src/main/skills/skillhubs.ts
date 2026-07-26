import type { RegistrySkillEntry } from '../../shared/skills'

// skillhubs registry 客户端的纯部（地址与响应映射）；HTTP 交互在 manager.ts。
// API：GET /api/skills?search=<kw>、GET /api/skills/<name>（版本列表，[0] 最新）、
//      GET /api/skills/<name>/<version>/download（zip）。

/** skillhubs registry 固定地址（用户拍板；换址改这一行） */
export const SKILLHUBS_REGISTRY = 'https://skill.drojian.dev'

/** 搜索/详情行的字段级防御映射（registry 响应形状可能漂移）；无有效 name 返回 null */
export function mapRegistryEntry(raw: unknown): RegistrySkillEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const name = record['name']
  if (typeof name !== 'string' || name === '') return null
  return {
    name,
    version: typeof record['version'] === 'string' ? record['version'] : '',
    description: typeof record['description'] === 'string' ? record['description'] : '',
    author: typeof record['author'] === 'string' ? record['author'] : null,
    downloadCount: typeof record['download_count'] === 'number' ? record['download_count'] : null,
    tags: Array.isArray(record['tags']) ? record['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
  }
}

/** 版本接口响应 → 最新版本号（容忍裸数组或 { versions: [...] } 包裹；[0] 为最新） */
export function pickLatestVersion(raw: unknown): string | null {
  let list: unknown[] | null = null
  if (Array.isArray(raw)) {
    list = raw
  } else if (typeof raw === 'object' && raw !== null) {
    const versions = (raw as Record<string, unknown>)['versions']
    if (Array.isArray(versions)) list = versions
  }
  const first = list?.[0]
  if (typeof first !== 'object' || first === null) return null
  const version = (first as Record<string, unknown>)['version']
  return typeof version === 'string' && version !== '' ? version : null
}
