import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { filterSkills, type SkillEntry, type SkillScope } from '../../../../shared/skills'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Page } from '../../components/page'
import { assistantLabel } from '../../lib/assistant-label'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { useIpcQuery } from '../../lib/ipc-query'
import { toast } from '@/components/ui/toast'
import { SkillsAcquireModal } from './remote'

// 技能页（本地管理）：一级维度 全局/助手，二级列表 + 客户端搜索。
// 每行必显所在容器目录徽标；不展示 symlink 等文件系统细节（用户拍板）。

export function SkillsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [scope, setScope] = useState<SkillScope>('global')
  const [assistantId, setAssistantId] = useState('')
  const [query, setQuery] = useState('')
  const [acquireOpen, setAcquireOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null)

  // 助手维度默认取第一个助手；选中的助手被删除后同样回落
  const assistants = state?.config.assistants ?? []
  const effectiveAssistant =
    assistantId !== '' && assistants.some((assistant) => assistant.id === assistantId)
      ? assistantId
      : (assistants[0]?.id ?? '')
  const enabled = state !== null && (scope === 'global' || effectiveAssistant !== '')
  const local = useIpcQuery(
    `skills.local:${scope}:${scope === 'assistant' ? effectiveAssistant : ''}`,
    () => ipc.skills.listLocal({ scope, ...(scope === 'assistant' ? { assistantId: effectiveAssistant } : {}) }),
    { enabled },
  )

  if (!state) {
    return <Page titleId="page.skills.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const removeSkill = async (skill: SkillEntry) => {
    setDeleteTarget(null)
    const result = await ipc.skills.remove({
      scope,
      ...(scope === 'assistant' ? { assistantId: effectiveAssistant } : {}),
      dir: skill.dir,
      dirName: skill.dirName,
    })
    if (!result.ok) {
      toast.add({ title: result.message, type: 'error' })
      return
    }
    local.refetch()
  }

  const reveal = async (skill: SkillEntry) => {
    const result = await ipc.skills.reveal({ path: skill.path })
    if (!result.ok) toast.add({ title: result.message, type: 'error' })
  }

  const skills = local.data?.skills ?? []
  const filtered = filterSkills(skills, query)

  return (
    <Page
      titleId="page.skills.title"
      actions={
        <div className="flex gap-2">
          <Button onClick={() => setAcquireOpen(true)}>{intl.formatMessage({ id: 'skills.remote.open' })}</Button>
          <Button variant="outline" onClick={() => local.refetch()}>
            {intl.formatMessage({ id: 'skills.refresh' })}
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-2">
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[scope]}
          onValueChange={(value) => {
            const next = value[0]
            if (next === 'global' || next === 'assistant') setScope(next)
          }}
        >
          <ToggleGroupItem value="global">{intl.formatMessage({ id: 'skills.scope.global' })}</ToggleGroupItem>
          <ToggleGroupItem value="assistant">{intl.formatMessage({ id: 'skills.scope.assistant' })}</ToggleGroupItem>
        </ToggleGroup>
        {scope === 'assistant' && assistants.length > 0 && (
          <div className="w-44 shrink-0">
            <NativeSelect value={effectiveAssistant} onChange={(event) => setAssistantId(event.target.value)}>
              {assistants.map((assistant) => (
                <NativeSelectOption key={assistant.id} value={assistant.id}>
                  {assistantLabel(assistant)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <Input
            value={query}
            placeholder={intl.formatMessage({ id: 'skills.search' })}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {scope === 'assistant' && assistants.length === 0 ? (
        <Empty>
          <EmptyDescription>{intl.formatMessage({ id: 'skills.assistant.none' })}</EmptyDescription>
        </Empty>
      ) : (
        <>
          {local.data !== null && (
            <p className="mb-3 truncate font-mono text-xs text-ink-muted">
              {intl.formatMessage({ id: 'skills.root' }, { path: local.data.root })}
            </p>
          )}
          {local.error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{local.error}</AlertDescription>
            </Alert>
          )}
          {local.data === null && local.error === null ? (
            <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
          ) : skills.length === 0 ? (
            <Empty>
              <EmptyDescription>{intl.formatMessage({ id: 'skills.empty' })}</EmptyDescription>
            </Empty>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'skills.noMatch' })}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {filtered.map((skill) => (
                <Card key={`${skill.dir}/${skill.dirName}`}>
                  <CardContent>
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{skill.name}</span>
                          <Badge variant="secondary" className="font-mono">
                            {skill.dir}
                          </Badge>
                          {skill.error !== null && (
                            <Badge variant="destructive" title={skill.error}>
                              {intl.formatMessage({ id: 'skills.entry.error' })}
                            </Badge>
                          )}
                        </div>
                        {skill.description !== '' && (
                          <p className="mt-1 truncate text-xs text-ink-muted">{skill.description}</p>
                        )}
                      </div>
                      <Button variant="outline" onClick={() => void reveal(skill)}>
                        {intl.formatMessage({ id: 'skills.reveal' })}
                      </Button>
                      <Button variant="destructive" onClick={() => setDeleteTarget(skill)}>
                        {intl.formatMessage({ id: 'common.delete' })}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {acquireOpen && <SkillsAcquireModal onClose={() => setAcquireOpen(false)} onInstalled={() => local.refetch()} />}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{intl.formatMessage({ id: 'common.delete' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: 'skills.deleteConfirm' },
                { name: deleteTarget?.name ?? '', path: deleteTarget?.path ?? '' },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: 'common.cancel' })}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget !== null) void removeSkill(deleteTarget)
              }}
            >
              {intl.formatMessage({ id: 'common.delete' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
