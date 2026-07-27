import fs from 'node:fs'
import path from 'node:path'
import type { AgentCliDetection } from '../../shared/messages'

// 本机 agent CLI 检测（onboarding 的「准备 Agent」步用）：检测到 codex/claude CLI
// 说明用户大概率已有对应账号登录，据此推荐安装对应 agent。只扫 PATH 不起子进程——
// 启动时 mergeLoginShellPath 已把 login shell 的 PATH 合并进 process.env。

/** which 的最小实现（POSIX；本应用只发 macOS）：返回首个可执行文件路径，找不到为 null */
export function findExecutable(cmd: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, cmd)
    try {
      if (!fs.statSync(candidate).isFile()) continue
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

export function detectAgentClis(pathEnv: string = process.env['PATH'] ?? ''): AgentCliDetection {
  return {
    codex: findExecutable('codex', pathEnv),
    claude: findExecutable('claude', pathEnv),
  }
}
