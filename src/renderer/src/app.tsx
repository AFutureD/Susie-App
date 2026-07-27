import { useEffect } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { useAtomValue, useSetAtom } from 'jotai'
import { NavLink, Navigate, Route, Routes } from 'react-router'
import { OnboardingOverlay } from './components/onboarding/onboarding'
import { NAV_ROUTES } from '../../shared/nav'
import { configStateAtom } from './lib/config-atoms'
import { ToastHost } from './lib/toast'
import { ipc, onIpcEvent } from './lib/ipc'
import { channelStatusesAtom } from './lib/service-atoms'
import { updateStateAtom } from './lib/update-atoms'
import { AgentsPage } from './pages/agents'
import { AssistantsPage } from './pages/assistants'
import { ChannelsPage } from './pages/channels'
import { HistoryPage } from './pages/history'
import { IntelligencePage } from './pages/intelligence'
import { AutoReviewHistoryPage } from './pages/intelligence/history'
import { LogsPage } from './pages/logs'
import { SettingsPage } from './pages/settings'
import { SkillsPage } from './pages/skills'
import { TasksPage } from './pages/tasks'
import { TaskHistoryPage } from './pages/tasks/history'
import { UsersPage } from './pages/users'

const NAV_ITEMS = NAV_ROUTES.map((name) => ({ to: `/${name}`, id: `nav.${name}` }))

/** 把主进程 ConfigStore / ChannelHub 状态镜像到 atoms */
function ConfigBootstrap() {
  const setState = useSetAtom(configStateAtom)
  const setStatuses = useSetAtom(channelStatusesAtom)
  const setUpdateState = useSetAtom(updateStateAtom)

  useEffect(() => {
    let alive = true
    void ipc.config.get().then((state) => {
      if (alive) setState(state)
    })
    void ipc.channels.statuses().then((statuses) => {
      if (alive) setStatuses(statuses)
    })
    void ipc.update.getState().then((state) => {
      if (alive) setUpdateState(state)
    })
    const offConfig = onIpcEvent('config.state', setState)
    const offStatus = onIpcEvent('channels.status', setStatuses)
    const offUpdate = onIpcEvent('update.state', setUpdateState)
    return () => {
      alive = false
      offConfig()
      offStatus()
      offUpdate()
    }
  }, [setState, setStatuses, setUpdateState])

  return null
}

function ConfigErrorBanner() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  if (!state?.lastError) return null
  return (
    <div className="mx-8 mb-4 rounded-lg bg-red-500/10 px-4 py-2.5 text-xs leading-5 text-red-500">
      <span className="font-medium">{intl.formatMessage({ id: 'config.errorBanner' })}</span> {state.lastError}
    </div>
  )
}

export function App() {
  return (
    <div className="flex h-full">
      <ConfigBootstrap />
      <OnboardingOverlay />
      <aside className="app-drag flex w-52 shrink-0 flex-col border-r border-line bg-surface">
        {/* 顶部留白给 hiddenInset 红绿灯 */}
        <div className="flex items-center gap-2 px-4 pt-12 pb-4">
          <span className="text-xl">🐾</span>
          <span className="text-sm font-semibold">Susie</span>
        </div>
        <nav className="app-no-drag flex flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm transition-colors ${
                  isActive ? 'bg-raised font-medium text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                }`
              }
            >
              <FormattedMessage id={item.id} />
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-drag h-12 shrink-0" />
        <ConfigErrorBanner />
        <main className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
          <Routes>
            <Route path="/" element={<Navigate to={`/${NAV_ROUTES[0]}`} replace />} />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/assistants" element={<AssistantsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/intelligence" element={<IntelligencePage />} />
            <Route path="/intelligence/history" element={<AutoReviewHistoryPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/history" element={<TaskHistoryPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
        <ToastHost />
      </div>
    </div>
  )
}
