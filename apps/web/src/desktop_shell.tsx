import { useState } from 'react'
import type { User } from './db'
import { Sidebar, type DesktopModule } from './components/sidebar'
import { Topbar } from './components/topbar'
import { EquipmentSearch, SessionHistory } from './receiving'
import { DiagnosticsModule } from './modules/diagnostics'
import { OnboardingModule } from './modules/onboarding'
import { ReviewDesk } from './review'
import { AdminDesk } from './users'
import { BatchQueue } from './warehouse/batch_queue'
import { TechniciansModule } from './warehouse/technicians'
import { ReceiptDesk } from './warehouse/receipt_desk'

interface DesktopShellProps {
  user: User
  denied: () => void
  exit: () => Promise<void>
  connected: boolean
}

export function DesktopShell({ user, denied, exit, connected }: DesktopShellProps) {
  const [module, setModule] = useState<DesktopModule>('batches')
  const [receipt, setReceipt] = useState<{ id: string; from: DesktopModule }>()
  const [lookup, setLookup] = useState<{ query: string; sequence: number }>()
  const administrator = user.role === 'administrator'

  function navigate(next: DesktopModule) {
    setLookup(undefined)
    setReceipt(undefined)
    setModule(next)
  }

  function search(query: string) {
    setReceipt(undefined)
    setLookup((previous) => ({ query, sequence: (previous?.sequence ?? 0) + 1 }))
    setModule('search')
  }

  const open = (id: string) => setReceipt({ id, from: module })

  return (
    <div className="desktop-shell-layout">
      <Sidebar currentModule={module} onSelectModule={navigate} user={user} onLogout={() => void exit()} />
      <div className="desktop-main-column">
        {/* Durante a conferência, a busca global sairia do lote se recebesse um bipe. */}
        <Topbar connected={connected} onQuickSearch={receipt ? undefined : search} />
        <main className="desktop-main-wrapper">
          {receipt ? <ReceiptDesk key={receipt.id} owner={user.id} clerkName={user.name} id={receipt.id}
            denied={denied} back={() => setReceipt(undefined)} /> : <>
            {module === 'batches' && <BatchQueue owner={user.id} denied={denied} opened={open} />}
            {module === 'technicians' && <TechniciansModule owner={user.id} denied={denied} opened={open} />}
            {module === 'history' && <SessionHistory owner={user.id} denied={denied} opened={open} />}
            {module === 'search' && <EquipmentSearch key={lookup?.sequence} owner={user.id} denied={denied} initialCode={lookup?.query} />}
            {administrator && module === 'review' && <ReviewDesk admin={user} denied={denied} />}
            {administrator && module === 'users' && <AdminDesk admin={user} denied={denied} exit={exit} />}
            {module === 'scanner' && <DiagnosticsModule />}
            {module === 'help' && <OnboardingModule />}
          </>}
        </main>
      </div>
    </div>
  )
}
