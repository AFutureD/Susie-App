import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentProgress } from '../../../shared/messages'
import { useIpcEvent } from '../lib/ipc'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress, ProgressLabel } from '@/components/ui/progress'

// agent 安装进度共享件（Agent 页与 onboarding 的「准备 Agent」步共用）：
// 订阅 agents.progress 事件流 + 单行进度渲染。

/** 订阅 agents.progress：done 撤掉进度行（刷新后卡片自然切到已安装态）；done/error 触发 onSettled */
export function useAgentProgress(onSettled: () => void): {
  progress: Record<string, AgentProgress>
  /** 进度事件之前就失败（如 registry 拉取失败）也要在卡片上可见 */
  fail: (id: string, detail: string) => void
} {
  const [progress, setProgress] = useState<Record<string, AgentProgress>>({})

  useIpcEvent('agents.progress', (event) => {
    setProgress((prev) => {
      if (event.phase === 'done') {
        const next = { ...prev }
        delete next[event.id]
        return next
      }
      return { ...prev, [event.id]: event }
    })
    if (event.phase === 'done' || event.phase === 'error') onSettled()
  })

  const fail = (id: string, detail: string): void =>
    setProgress((prev) => ({ ...prev, [id]: { id, phase: 'error', detail } }))

  return { progress, fail }
}

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 安装进度：下载中显示字节进度条（无 content-length 时为不确定态），解压为不确定态，失败为红字 */
export function AgentProgressLine({ progress }: { progress: AgentProgress }) {
  const intl = useIntl()

  if (progress.phase === 'error') {
    return (
      <Alert variant="destructive" className="mt-3">
        <AlertDescription>
          {intl.formatMessage({ id: 'agents.progress.error' }, { detail: progress.detail ?? '?' })}
        </AlertDescription>
      </Alert>
    )
  }

  const received = progress.received ?? 0
  const total = progress.total ?? null
  const percent =
    progress.phase === 'downloading' && total !== null ? Math.min(100, Math.round((received / total) * 100)) : null

  const label =
    progress.phase === 'downloading'
      ? total !== null
        ? intl.formatMessage(
            { id: 'agents.progress.downloading' },
            { received: formatMB(received), total: formatMB(total), percent: String(percent) },
          )
        : intl.formatMessage({ id: 'agents.progress.downloading.indeterminate' }, { received: formatMB(received) })
      : progress.phase === 'probing'
        ? intl.formatMessage({ id: 'agents.progress.probing' })
        : intl.formatMessage({ id: 'agents.progress.extracting' })

  return (
    <Progress value={percent} className="mt-3">
      <ProgressLabel>{label}</ProgressLabel>
    </Progress>
  )
}
