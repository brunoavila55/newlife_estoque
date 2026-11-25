import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon, type IconName } from '../components/icon'
import { db, freeSpace, type Capture, type Profile } from '../db'
import type { BatchDetail } from '../delivery'
import { CaptureTab } from './capture'
import { HoldingsTab } from './holdings'
import { BatchesTab } from './batches'

const remoteLabels: Record<string, string> = {
  OCR_PENDING: 'Recebida · lendo etiqueta',
  OCR_PROCESSING: 'Recebida · lendo etiqueta',
  IDENTIFIED: 'Recebida · identificada',
  NEEDS_REVIEW: 'Recebida · identificar no balcão',
  OCR_FAILED: 'Recebida · identificar no balcão',
}
const localLabels: Record<Capture['state'], string> = {
  LOCAL_PENDING: 'Aguardando envio',
  UPLOADING: 'Enviando',
  ACTION_REQUIRED: 'Ação necessária',
  UPLOADED: 'Recebida',
}
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

type Tab = 'CAPTURE' | 'HOLDINGS' | 'BATCHES' | 'QUEUE'

interface TechDeskProps {
  profile: Profile
  deny: () => void
  connected: boolean
  syncing: boolean
  run: (force: boolean) => Promise<void>
  leaveDesk: () => Promise<void>
}

export function TechDesk({ profile, deny, connected, syncing, run, leaveDesk }: TechDeskProps) {
  const [tab, setTab] = useState<Tab>('CAPTURE')
  const [openedBatch, setOpenedBatch] = useState<BatchDetail>()
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [lowSpace, setLowSpace] = useState(false)
  const [usedMB, setUsedMB] = useState<string>()
  const [leaveError, setLeaveError] = useState('')

  const captures = useLiveQuery(
    async () => (await db.captures.where('owner').equals(profile.id).sortBy('capturedAt')).reverse(),
    [profile.id]
  )
  const pending = captures?.filter((capture) => capture.state !== 'UPLOADED').length ?? 0
  const attention = captures?.filter((capture) => capture.state === 'ACTION_REQUIRED').length ?? 0
  const today = new Date().toDateString()
  const savedToday = captures?.filter((capture) => new Date(capture.capturedAt).toDateString() === today).length ?? 0

  const checkSpace = useCallback(async () => {
    try {
      const estimate = await navigator.storage?.estimate()
      if (estimate?.usage !== undefined) setUsedMB((estimate.usage / (1024 * 1024)).toFixed(1))
      const free = await freeSpace()
      setLowSpace(free !== null && free < 40 * 1024 * 1024)
    } catch { /* A cota ainda é verificada ao salvar. */ }
  }, [])
  useEffect(() => { void checkSpace() }, [checkSpace, captures?.length])

  async function leave() {
    try {
      await leaveDesk()
    } catch (failure) {
      setLeaveError(failure instanceof Error ? failure.message : 'Não foi possível sair.')
    }
  }

  const tabs: { id: Tab; label: string; icon: IconName; badge?: number }[] = [
    { id: 'CAPTURE', label: 'Coletar', icon: 'camera' },
    { id: 'HOLDINGS', label: 'Comigo', icon: 'box' },
    { id: 'BATCHES', label: 'Lotes', icon: 'list' },
    { id: 'QUEUE', label: 'Envios', icon: 'sync', badge: pending || undefined },
  ]

  return <div className="mobile-app-shell tech-shell">
    <header className="mobile-system-header">
      <div className="mobile-app-bar">
        <div className="user-tech-badge">
          <img className="tech-avatar" src="/icons/new-life-logo.png" alt="New Life" />
          <div className="tech-meta">
            <strong className="tech-name">{profile.name}</strong>
            <span className={`network-pill ${connected ? 'online' : 'offline'}`}>
              <span className="dot" /> {connected ? 'Conectado' : 'Sem conexão'}
            </span>
          </div>
        </div>
        <button type="button" className="mobile-exit-btn"
          onClick={() => (pending > 0 ? setConfirmLeave(true) : void leave())}>
          {connected ? 'Sair' : 'Bloquear'}
        </button>
      </div>
    </header>

    {confirmLeave && <section className="mobile-alert-banner warning">
      <p>Você tem <strong>{pending} foto{pending > 1 ? 's' : ''} não enviada{pending > 1 ? 's' : ''}</strong>. Elas ficam guardadas neste celular, mas só entram no seu estoque depois de enviadas.</p>
      <div className="banner-actions">
        <button className="small-btn" onClick={() => setConfirmLeave(false)}>Continuar</button>
        <button className="small-btn danger-btn" onClick={() => void leave()}>Sair mesmo assim</button>
      </div>
    </section>}
    {leaveError && <p className="mobile-toast alert" role="alert">{leaveError}</p>}
    {lowSpace && <p className="mobile-toast alert" role="alert">Pouco espaço no celular. Envie as fotos pendentes.</p>}
    {attention > 0 && tab !== 'QUEUE' && <button type="button" className="mobile-toast alert tech-attention"
      onClick={() => setTab('QUEUE')}>{attention} foto{attention > 1 ? 's precisam' : ' precisa'} de atenção. Toque para ver.</button>}

    <div className="mobile-scrollable-body">
      {tab === 'CAPTURE' && <CaptureTab owner={profile.id} savedToday={savedToday} saved={() => void run(false)} />}
      {tab === 'HOLDINGS' && <HoldingsTab owner={profile.id} connected={connected} localPending={pending}
        deny={deny} sync={() => void run(true)} syncing={syncing}
        created={(batch) => { setOpenedBatch(batch); setTab('BATCHES') }} />}
      {tab === 'BATCHES' && <BatchesTab owner={profile.id} connected={connected} deny={deny}
        opened={openedBatch} open={setOpenedBatch} />}
      {tab === 'QUEUE' && <div className="tech-view">
        <header className="tech-view-head">
          <h1>Envios</h1>
          <p className="muted">Fotos salvas neste celular e a situação de cada envio.</p>
        </header>
        <div className="tech-sync-card">
          <div>
            <strong>{pending ? `${pending} foto${pending > 1 ? 's' : ''} para enviar` : 'Tudo enviado'}</strong>
            {usedMB && <p className="muted small-text">{usedMB} MB usados no celular</p>}
          </div>
          <button type="button" className="primary" disabled={syncing} onClick={() => void run(true)}>
            {syncing ? 'Enviando…' : 'Sincronizar agora'}
          </button>
        </div>
        {pending > 0 && <p className="muted small-text">Mantenha o aplicativo aberto durante o envio. Limpar os dados do navegador apaga fotos ainda não enviadas.</p>}
        {captures?.length === 0 && <p className="empty-state">Nenhuma foto neste celular.</p>}
        <ul className="tech-list">{captures?.map((capture) => <li key={capture.id} className="tech-row">
          <span className="mono">{capture.barcode?.raw_value || 'Sem código digitado'}</span>
          <span className="tech-pick-meta">
            <span className={'badge ' + (capture.state === 'UPLOADED' ? 'badge-success'
              : capture.state === 'ACTION_REQUIRED' ? 'badge-danger' : 'badge-warning')}>
              {(capture.state === 'UPLOADED' && remoteLabels[capture.remoteStatus ?? '']) || localLabels[capture.state]}
            </span>
            <span className="muted">{dateTime.format(new Date(capture.capturedAt))}</span>
          </span>
          {capture.error && capture.state !== 'UPLOADED' && <span className="muted small-text">{capture.error}</span>}
        </li>)}</ul>
      </div>}
    </div>

    <nav className="mobile-bottom-dock" aria-label="Área do técnico">
      {tabs.map((item) => <button key={item.id} type="button"
        className={`dock-btn ${tab === item.id ? 'active' : ''}`}
        aria-current={tab === item.id ? 'page' : undefined}
        onClick={() => { setTab(item.id); if (item.id === 'BATCHES') setOpenedBatch(undefined) }}>
        <span className="dock-icon relative">
          <Icon name={item.icon} />
          {item.badge && <span className="dock-badge" aria-hidden="true">{item.badge}</span>}
        </span>
        <span className="dock-label">{item.label}</span>
      </button>)}
    </nav>
  </div>
}
