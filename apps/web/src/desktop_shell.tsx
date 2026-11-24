import { useState } from 'react'
import type { Profile, User } from './db'
import { Sidebar, type DesktopModule } from './components/sidebar'
import { Topbar } from './components/topbar'
import { DashboardModule } from './modules/dashboard'
import { ReceivingDesk } from './receiving'
import { BatchesModule } from './modules/batches'
import { CatalogModule } from './modules/catalog'
import { TriageModule } from './modules/triage'
import { DiscrepanciesModule } from './modules/discrepancies'
import { InventoryWarehouseModule } from './modules/inventory_warehouse'
import { ReportsModule } from './modules/reports'
import { DiagnosticsModule } from './modules/diagnostics'
import { ReviewDesk } from './review'
import { AdminDesk } from './users'
import { OnboardingModule } from './modules/onboarding'
import { TechDesk } from './technician/tech_desk'

interface DesktopShellProps {
  user: User
  denied: () => void
  exit: () => Promise<void>
  connected: boolean
}

export function DesktopShell({ user, denied, exit, connected }: DesktopShellProps) {
  const [currentModule, setCurrentModule] = useState<DesktopModule>('dashboard')
  const [isMobilePreview, setIsMobilePreview] = useState(false)

  function handleQuickSearch(query: string) {
    if (query.toUpperCase().startsWith('LOTE-') || query.toUpperCase().startsWith('REM-')) {
      setCurrentModule('batches')
    } else {
      setCurrentModule('catalog')
    }
  }

  const simulatedProfile: Profile = {
    id: user.id,
    name: user.name,
    login: user.login,
    role: user.role,
    slot: 'current',
    offlineUntil: Date.now() + 24 * 3600 * 1000,
  }

  return (
    <div className="desktop-shell-layout">
      <Sidebar
        currentModule={currentModule}
        onSelectModule={(mod) => {
          setIsMobilePreview(false)
          setCurrentModule(mod)
        }}
        user={user}
        onLogout={() => void exit()}
      />

      <div className="desktop-main-column">
        <Topbar
          user={user}
          connected={connected}
          onNavigate={(mod) => {
            setIsMobilePreview(false)
            setCurrentModule(mod)
          }}
          onQuickSearch={handleQuickSearch}
          isMobilePreview={isMobilePreview}
          onToggleMobilePreview={() => setIsMobilePreview(!isMobilePreview)}
        />

        <main className="desktop-main-wrapper">
          {isMobilePreview ? (
            <div className="mobile-simulator-wrapper">
              <div className="phone-mockup-frame">
                <TechDesk
                  profile={simulatedProfile}
                  deny={denied}
                  connected={connected}
                  syncing={false}
                  run={async () => {}}
                  leaveDesk={exit}
                />
              </div>
            </div>
          ) : (
            <>
              {currentModule === 'dashboard' && (
                <DashboardModule onNavigate={setCurrentModule} />
              )}

              {currentModule === 'receiving' && (
                <ReceivingDesk clerk={user} denied={denied} exit={exit} />
              )}

              {currentModule === 'batches' && (
                <BatchesModule
                  user={user}
                  onOpenSession={() => {
                    setCurrentModule('receiving')
                  }}
                />
              )}

              {currentModule === 'catalog' && <CatalogModule user={user} />}

              {currentModule === 'triage' && <TriageModule user={user} />}

              {currentModule === 'discrepancies' && <DiscrepanciesModule user={user} />}

              {currentModule === 'inventory_warehouse' && <InventoryWarehouseModule user={user} />}

              {currentModule === 'reports' && <ReportsModule user={user} />}

              {currentModule === 'diagnostics' && <DiagnosticsModule />}

              {currentModule === 'review' && <ReviewDesk admin={user} denied={denied} />}

              {currentModule === 'users' && <AdminDesk admin={user} denied={denied} exit={exit} />}

              {currentModule === 'onboarding' && <OnboardingModule />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
