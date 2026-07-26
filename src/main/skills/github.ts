// GitHub 仓库来源解析与 tarball 地址（codeload 直下无 API 限流）。

export interface RepoSource {
  owner: string
  repo: string
  /** 分支/标签/提交；null = 默认分支 */
  ref: string | null
  /** 仓库内子路径（/tree/<ref>/<subPath> 形态）；null = 整仓 */
  subPath: string | null
}

const SHORTHAND = /^[\w.-]+\/[\w.-]+$/

/** 支持 owner/repo、github.com/<owner>/<repo>、…/tree/<ref>[/<subPath>]；其余形态返回 null */
export function parseRepoSource(input: string): RepoSource | null {
  const raw = input.trim()
  if (raw === '') return null
  if (SHORTHAND.test(raw)) {
    const [owner, repo] = raw.split('/') as [string, string]
    return { owner, repo: stripGitSuffix(repo), ref: null, subPath: null }
  }
  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const owner = segments[0]
  const repo = segments[1]
  if (owner === undefined || repo === undefined) return null
  if (segments.length === 2) return { owner, repo: stripGitSuffix(repo), ref: null, subPath: null }
  // 已知限制：带 `/` 的分支名无法与子路径划界，取 tree 后首段为 ref
  if (segments[2] !== 'tree' || segments[3] === undefined) return null
  const subPath = segments.slice(4).join('/')
  return { owner, repo: stripGitSuffix(repo), ref: segments[3], subPath: subPath === '' ? null : subPath }
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo
}

/** ref 候选序列：显式 ref 只试它；否则 HEAD → main → master 兜底 */
export function refCandidates(source: RepoSource): string[] {
  return source.ref !== null ? [source.ref] : ['HEAD', 'main', 'master']
}

export function tarballUrl(source: RepoSource, ref: string): string {
  return `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(ref)}`
}

/** 展示用来源标签：owner/repo[@ref][/subPath] */
export function repoLabel(source: RepoSource): string {
  const base = `${source.owner}/${source.repo}`
  const withRef = source.ref === null ? base : `${base}@${source.ref}`
  return source.subPath === null ? withRef : `${withRef}/${source.subPath}`
}
