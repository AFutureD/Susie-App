import { useState } from 'react'
import { useIntl } from 'react-intl'
import { filterSkills, type SkillEntry } from '../../../shared/skills'
import { ipc } from '../lib/ipc'
import { useIpcQuery } from '../lib/ipc-query'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'

/**
 * 助手可用技能弹窗：只列该 agent 能读取的技能（main 侧按 skillDirsForAgent 过滤——
 * 如 claude 不显示 .agents/skills 中的），工作目录/全局分组只读展示。
 */
export function AssistantSkillsModal({
  assistantId,
  label,
  onClose,
}: {
  assistantId: string
  /** 展示名（name ?? id）；缺省回退 id */
  label?: string
  onClose: () => void
}) {
  const intl = useIntl()
  const [query, setQuery] = useState('')
  const { data, loading, error } = useIpcQuery(
    `skills.forAssistant:${assistantId}`,
    () => ipc.skills.listForAssistant({ id: assistantId }),
    { invalidateOn: ['config.state'] },
  )

  const workspace = filterSkills(data?.workspace ?? [], query)
  const global = filterSkills(data?.global ?? [], query)
  const total = (data?.workspace.length ?? 0) + (data?.global.length ?? 0)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: 'assistants.skills.title' }, { id: label ?? assistantId })}
          </DialogTitle>
        </DialogHeader>
        {data !== null && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <Badge>{data.agentId}</Badge>
            {data.dirs.length === 0 ? (
              <span>{intl.formatMessage({ id: 'assistants.skills.noDirs' })}</span>
            ) : (
              data.dirs.map((dir) => (
                <Badge key={dir} variant="secondary">
                  {dir}
                </Badge>
              ))
            )}
          </div>
        )}
        <Input
          value={query}
          placeholder={intl.formatMessage({ id: 'skills.search' })}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : data === null && loading ? (
            <p className="py-2 text-xs text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
          ) : total === 0 ? (
            <Empty>
              <EmptyDescription>{intl.formatMessage({ id: 'assistants.skills.empty' })}</EmptyDescription>
            </Empty>
          ) : (
            <div className="flex flex-col gap-3">
              <SkillGroup
                label={intl.formatMessage({ id: 'assistants.skills.workspace' }, { path: data?.workDir ?? '' })}
                entries={workspace}
              />
              <SkillGroup label={intl.formatMessage({ id: 'assistants.skills.global' })} entries={global} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {intl.formatMessage({ id: 'assistants.skills.close' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SkillGroup({ label, entries }: { label: string; entries: SkillEntry[] }) {
  const intl = useIntl()
  if (entries.length === 0) return null
  return (
    <div>
      <p className="mb-1.5 truncate text-xs font-medium text-ink-muted">{label}</p>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <Card key={`${entry.dir}/${entry.dirName}`} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="truncate">{entry.name}</span>
                <Badge>{entry.dir}</Badge>
                {entry.error !== null && (
                  <Badge title={entry.error} variant="destructive">
                    {intl.formatMessage({ id: 'skills.entry.error' })}
                  </Badge>
                )}
              </CardTitle>
              {entry.description !== '' && <CardDescription>{entry.description}</CardDescription>}
            </CardHeader>
            <CardContent className="hidden" />
          </Card>
        ))}
      </div>
    </div>
  )
}
