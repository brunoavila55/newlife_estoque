import { useState } from 'react'
import type { User } from './db'
import { Sidebar, type DesktopModule } from './components/sidebar'
import { Topbar } from './components/topbar'
import { DashboardModule } from './modules/dashboard'
import { ReceivingDesk, EquipmentSearch, ReceiptExceptions } from './receiving'
import { DiagnosticsModule } from './modules/diagnostics'
import { ReviewDesk } from './review'
import { AdminDesk } from './users'
import { OnboardingModule } from './modules/onboarding'

interface DesktopShellProps {
  user: User
  denied: () => void
  exit: () => Promise<void>
  connected: boolean
}

export function DesktopShell({ user, denied, exit, connected }: DesktopShellProps) {
  const [currentModule, setCurrentModule] = useState<DesktopModule>('dashboard')
  const [lookup, setLookup] = useState<{ query: string; sequence: number }>()
  const administrator = user.role === 'administrator'

  function navigate(module: DesktopModule) {
    setLookup(undefined)
    setCurrentModule(module)
  }

  function search(query: string) {
    setLookup(previous => ({ query, sequence: (previous?.sequence ?? 0) + 1 }))
    setCurrentModule('catalog')
  }

  return (
    <div className="desktop-shell-layout">
      <Sidebar currentModule={currentModule} onSelectModule={navigate} user={user} onLogout={() => void exit()} />
      <div className="desktop-main-column">
        <Topbar connected={connected} onQuickSearch={search} />
        <main className="desktop-main-wrapper">
          {currentModule === 'dashboard' && <DashboardModule administrator={administrator} onNavigate={navigate} />}
          {(currentModule === 'receiving' || currentModule === 'history') &&
            <ReceivingDesk key={currentModule} clerk={user} denied={denied} exit={exit}
              initialModule={currentModule === 'history' ? 'history' : 'receive'} />}
          {currentModule === 'catalog' && <>
            <h1>Rastreamento de equipamentos</h1>
            <EquipmentSearch key={lookup?.sequence} owner={user.id} denied={denied} initialCode={lookup?.query} />
          </>}
          {currentModule === 'discrepancies' && <>
            <h1>Divergências</h1>
            <ReceiptExceptions owner={user.id} denied={denied} />
          </>}
          {currentModule === 'diagnostics' && <DiagnosticsModule />}
          {administrator && currentModule === 'review' && <ReviewDesk admin={user} denied={denied} />}
          {administrator && currentModule === 'users' && <AdminDesk admin={user} denied={denied} exit={exit} />}
          {currentModule === 'onboarding' && <OnboardingModule />}
        </main>
      </div>
    </div>
  )
}
