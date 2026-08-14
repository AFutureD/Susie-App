import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { IntlProvider } from 'react-intl'
import { HashRouter } from 'react-router'
import { App } from './app'
import { TooltipProvider } from '@/components/ui/tooltip'
import { zhHans } from './i18n/zh-Hans'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <IntlProvider locale="zh-Hans" defaultLocale="zh-Hans" messages={zhHans}>
      <HashRouter>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </HashRouter>
    </IntlProvider>
  </StrictMode>,
)
