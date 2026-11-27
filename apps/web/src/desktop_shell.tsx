import { useCallback, useEffect, useState } from 'react'
import { ApiError, setActiveLocation, warehouse } from './api'
import type { User } from './db'
import { Sidebar, type DesktopModule } from './components/sidebar'
import { Topbar } from './components/topbar'
import { EquipmentSearch, SessionHistory } from './receiving'
import { DiagnosticsModule } from './modules/diagnostics'
import { OnboardingModule } from './modules/onboarding'
import { ReviewDesk } from './review'
import { AdminDesk } from './users'
import { BatchQueue } from './warehouse/batch_queue'
import { Overview } from './warehouse/overview'
import { SimDesk, SimHistory, SimLookup, SimStock, type City } from './warehouse/sims'
import { TechniciansModule } from './warehouse/technicians'
import { ReceiptDesk } from './warehouse/receipt_desk'

interface DesktopShellProps {
  user: User
  denied: () => void
  exit: () => Promise<void>
  connected: boolean
}

const cityKey = 'newlife-admin-city'

/** Um ICCID tem 19 ou 20 dígitos e começa com 89; serial e MAC seguem para o rastreio de equipamentos. */
function isIccid(query: string) {
  return /^89\d{17,18}F?$/i.test(query.replace(/[\s-]/g, ''))
}

export function DesktopShell({ user, denied, exit, connected }: DesktopShellProps) {
  const [module, setModule] = useState<DesktopModule>('overview')
  const [receipt, setReceipt] = useState<{ id: string; from: DesktopModule }>()
  const [lookup, setLookup] = useState<{ query: string; sequence: number }>()
  const [cities, setCities] = useState<City[]>()
  const [city, setCity] = useState<City>()
  const [cityError, setCityError] = useState('')
  const administrator = user.role === 'administrator'

  const choose = useCallback((next: City) => {
    // Antes de renderizar os módulos: as consultas deles já saem com a nova cidade.
    setActiveLocation(next.id)
    if (administrator) localStorage.setItem(cityKey, next.id)
    setReceipt(undefined)
    setCity(next)
  }, [administrator])

  useEffect(() => {
    warehouse<{ items: City[] }>(user.id, '/locations').then((data) => {
      setCities(data.items)
      const preferred = administrator ? localStorage.getItem(cityKey) ?? user.location_id : user.location_id
      const initial = data.items.find((item) => item.id === preferred) ?? (administrator ? data.items[0] : undefined)
      if (initial) choose(initial)
      else setCityError('Sua conta não tem cidade definida. Peça ao administrador para escolher a cidade em Usuários.')
    }, (failure) => {
      if (failure instanceof ApiError && failure.status === 401) denied()
      setCityError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Recarregue a página.')
    })
    return () => setActiveLocation(undefined)
  }, [administrator, choose, denied, user.id, user.location_id])

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
        <Topbar connected={connected} onQuickSearch={receipt || module === 'sim-desk' ? undefined : search}
          city={city} cities={administrator && !receipt ? cities : undefined}
          onCity={(id) => { const next = cities?.find((item) => item.id === id); if (next) choose(next) }} />
        <main className="desktop-main-wrapper">
          {cityError && <p className="alert" role="alert">{cityError}</p>}
          {city && (receipt ? <ReceiptDesk key={receipt.id} owner={user.id} clerkName={user.name} id={receipt.id}
            denied={denied} back={() => setReceipt(undefined)} /> : <div key={city.id} className="city-scope">
            {module === 'overview' && <Overview owner={user.id} denied={denied} current={city}
              choose={administrator ? choose : undefined} go={navigate} />}
            {module === 'batches' && <BatchQueue owner={user.id} denied={denied} opened={open} />}
            {module === 'technicians' && <TechniciansModule owner={user.id} denied={denied} opened={open} />}
            {module === 'history' && <SessionHistory owner={user.id} denied={denied} opened={open} />}
            {module === 'search' && (lookup && isIccid(lookup.query)
              ? <SimLookup key={lookup.sequence} owner={user.id} denied={denied} code={lookup.query} />
              : <EquipmentSearch key={lookup?.sequence} owner={user.id} denied={denied} initialCode={lookup?.query} />)}
            {module === 'sim-desk' && <SimDesk owner={user.id} clerkName={user.name} city={city} denied={denied} />}
            {module === 'sim-stock' && <SimStock owner={user.id} city={city} denied={denied} />}
            {module === 'sim-history' && <SimHistory owner={user.id} city={city} denied={denied} />}
            {administrator && module === 'review' && <ReviewDesk admin={user} denied={denied} />}
            {administrator && module === 'users' && <AdminDesk admin={user} denied={denied} exit={exit} />}
            {module === 'scanner' && <DiagnosticsModule />}
            {module === 'help' && <OnboardingModule />}
          </div>)}
        </main>
      </div>
    </div>
  )
}
