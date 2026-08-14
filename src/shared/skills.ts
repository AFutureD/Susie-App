// 技能领域的共享类型与纯函数（零依赖、零 zod：renderer 可安全做值引入）。
// skill = 容器目录的直接子目录且含 SKILL.md（YAML frontmatter 提供 name/description）。

/** 技能容器目录（v1 只认这三个；global 相对用户主目录，assistant 相对助手生效工作目录） */
export const SKILL_DIRS = ['.agents/skills', '.claude/skills', '.pi/skills'] as const
export type SkillDir = (typeof SKILL_DIRS)[number]

/** 技能作用域：global = 用户主目录；assistant = 助手生效工作目录 */
export const SKILL_SCOPES = ['global', 'assistant'] as const
export type SkillScope = (typeof SKILL_SCOPES)[number]

/** 本地技能行（扫描产物，IPC 透传；不含 symlink/realpath 等文件系统细节） */
export interface SkillEntry {
  /** frontmatter name；缺失/解析失败回退目录名 */
  name: string
  description: string
  /** 技能目录名（寻址/删除/任务引用的稳定标识，与 name 可能不同） */
  dirName: string
  dir: SkillDir
  /** 技能目录绝对路径 */
  path: string
  /** SKILL.md 读取失败原因；健康为 null */
  error: string | null
}

export interface LocalSkillList {
  /** 扫描根（用户主目录或助手生效工作目录） */
  root: string
  skills: SkillEntry[]
}

/** 某助手实际可读的技能（按 agent 支持目录过滤，工作目录与全局两层来源） */
export interface AssistantSkills {
  assistantId: string
  agentId: string
  /** 该 agent 可读的容器目录；可为空——agent 的技能目录不在 v1 支持范围 */
  dirs: SkillDir[]
  workDir: string
  workspace: SkillEntry[]
  global: SkillEntry[]
}

/** 远程仓库中发现的技能 */
export interface RemoteSkillEntry {
  name: string
  description: string
  dirName: string
  /** 相对已解包仓库根的 POSIX 路径（installFromRepo 凭此定位） */
  relPath: string
}

export type RepoSkillsResult =
  { ok: true; sessionId: string; repoLabel: string; skills: RemoteSkillEntry[] } | { ok: false; message: string }

export type SkillInstallResult =
  | { ok: true; path: string }
  | {
      ok: false
      message: string
      /** 目标目录已存在（UI 据此提供「覆盖安装」二次确认） */
      exists: boolean
    }

/**
 * agent id → 可读技能容器目录。数据源：vercel-labs/skills「Supported agents」表的 project 列
 * （https://github.com/vercel-labs/skills#supported-agents），取与 SKILL_DIRS 的交集：
 * - 目录在三者之内 → 对应目录（claude 只读 .claude/skills，不含 .agents/skills，用户拍板）；
 * - 表内但目录超出（goose → .goose/skills 等）→ []，如实显示无可用技能；
 * - 未收录 id → .agents/skills（表中 Universal 行）。
 * 键为 Susie 实际出现的 agent id（codex 内建 + ACP registry id）。
 */
const AGENT_SKILL_DIRS: Record<string, SkillDir[]> = {
  'claude-acp': ['.claude/skills'],
  'pi-acp': ['.pi/skills'],
  codex: ['.agents/skills'],
  'codex-acp': ['.agents/skills'],
  gemini: ['.agents/skills'],
  opencode: ['.agents/skills'],
  cursor: ['.agents/skills'],
  cline: ['.agents/skills'],
  'amp-acp': ['.agents/skills'],
  'github-copilot-cli': ['.agents/skills'],
  kimi: ['.agents/skills'],
  deepagents: ['.agents/skills'],
  goose: [],
  'qwen-code': [],
  devin: [],
  junie: [],
  kilo: [],
  'mistral-vibe': [],
  'grok-build': [],
  auggie: [],
  'factory-droid': [],
  qoder: [],
  'cortex-code': [],
  'codebuddy-code': [],
  autohand: [],
}

/** 未收录 agent 的默认容器目录（Supported agents 表的 Universal 行） */
const UNIVERSAL_SKILL_DIRS: SkillDir[] = ['.agents/skills']

export function skillDirsForAgent(agentId: string): SkillDir[] {
  return AGENT_SKILL_DIRS[agentId] ?? UNIVERSAL_SKILL_DIRS
}

/** 客户端搜索：name/dirName/description 不区分大小写包含匹配；空白查询返回全量 */
export function filterSkills<T extends { name: string; dirName: string; description: string }>(
  skills: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return skills
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skill.dirName.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle),
  )
}
