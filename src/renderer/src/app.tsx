import { useEffect, type CSSProperties } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { useAtomValue, useSetAtom } from 'jotai'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/toast'
import { OnboardingOverlay } from './components/onboarding/onboarding'
import { NAV_ROUTES } from '../../shared/nav'
import { configStateAtom } from './lib/config-atoms'
import { ipc, onIpcEvent } from './lib/ipc'
import { channelStatusesAtom, managerStatusesAtom } from './lib/service-atoms'
import { updateStateAtom } from './lib/update-atoms'
import { AgentsPage } from './pages/agents'
import { AssistantsPage } from './pages/assistants'
import { ChannelsPage } from './pages/channels'
import { ChatsPage } from './pages/chats'
import { ChatHistoryPage } from './pages/chats/history'
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
  const setManagerStatuses = useSetAtom(managerStatusesAtom)
  const setUpdateState = useSetAtom(updateStateAtom)

  useEffect(() => {
    let alive = true
    void ipc.config.get().then((state) => {
      if (alive) setState(state)
    })
    void ipc.channels.statuses().then((statuses) => {
      if (alive) setStatuses(statuses)
    })
    void ipc.managerBots.statuses().then((statuses) => {
      if (alive) setManagerStatuses(statuses)
    })
    void ipc.update.getState().then((state) => {
      if (alive) setUpdateState(state)
    })
    const offConfig = onIpcEvent('config.state', setState)
    const offStatus = onIpcEvent('channels.status', setStatuses)
    const offManagerStatus = onIpcEvent('managerBots.status', setManagerStatuses)
    const offUpdate = onIpcEvent('update.state', setUpdateState)
    return () => {
      alive = false
      offConfig()
      offStatus()
      offManagerStatus()
      offUpdate()
    }
  }, [setState, setStatuses, setManagerStatuses, setUpdateState])

  return null
}

function ConfigErrorBanner() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  if (!state?.lastError) return null
  return (
    <Alert variant="destructive" className="mx-8 mb-4 w-auto">
      <AlertTitle>{intl.formatMessage({ id: 'config.errorBanner' })}</AlertTitle>
      <AlertDescription>{state.lastError}</AlertDescription>
    </Alert>
  )
}

export function App() {
  const location = useLocation()
  const intl = useIntl()

  return (
    <SidebarProvider className="h-full min-h-0" style={{ '--sidebar-width': '13rem' } as CSSProperties}>
      <ConfigBootstrap />
      <OnboardingOverlay />
      <Sidebar collapsible="none">
        <SidebarHeader className="app-drag flex-row items-center gap-2 px-4 pt-12 pb-4">
          <span className="text-xl">🐾</span>
          <span className="text-sm font-semibold">Susie</span>
        </SidebarHeader>
        <SidebarContent className="app-no-drag">
          <SidebarGroup>
            <SidebarGroupContent>
              <nav aria-label={intl.formatMessage({ id: 'nav.ariaLabel' })}>
                <SidebarMenu>
                  {NAV_ITEMS.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        render={<NavLink to={item.to} />}
                        isActive={
                          location.pathname === item.to ||
                          (item.to !== `/${NAV_ROUTES[0]}` && location.pathname.startsWith(`${item.to}/`))
                        }
                      >
                        <FormattedMessage id={item.id} />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

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
            <Route path="/chats" element={<ChatsPage />} />
            <Route path="/chats/history" element={<ChatHistoryPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </SidebarProvider>
  )
}
