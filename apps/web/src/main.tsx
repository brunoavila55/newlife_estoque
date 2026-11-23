import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveQuery } from 'dexie-react-hooks'
import { registerSW } from 'virtual:pwa-register'
import { ApiError, authenticated, clearAccess, enter, leave, lockDevice, resumeSession, type Inventory } from './api'
import { db, freeSpace, removeExpiredPhotos, storePhoto, type Capture, type Profile, type User } from './db'
import { preparePhoto, readBarcode, validBarcode } from './photo'
import { ReviewDesk } from './review'
import { ReceivingDesk } from './receiving'
import { refreshCapture, synchronize } from './sync'
import './style.css'

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

type InstallEvent = Event & { prompt(): Promise<void> }

function message(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return 'O navegador ficou sem espaço. A foto não foi salva. Sincronize as fotos antes de liberar espaço.'
  }
  if (error instanceof Error && (error.name === 'TypeError' || error.name === 'AbortError')) {
    return 'Não foi possível conectar ao servidor. Tente novamente.'
  }
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.'
}

function Login({ reauthenticate, done }: { reauthenticate: boolean; done: (user: User) => void }) {
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      done(await enter(String(form.get('login')), String(form.get('password'))))
    } catch (error) {
      setNotice(message(error))
    } finally {
      setBusy(false)
    }
  }

  return <section className="card login">
    <h1>{reauthenticate ? 'Entre novamente' : 'Entrar no Newlife Estoque'}</h1>
    <p>{reauthenticate
      ? 'As fotos salvas ficam vinculadas à conta que as registrou.'
      : 'Entre com a conta fornecida pelo administrador.'}</p>
    <form onSubmit={(event) => void submit(event)}>
      <label>Login<input name="login" autoComplete="username" autoCapitalize="none" required /></label>
      <label>Senha<input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
    </form>
    {notice && <p className="alert" role="alert">{notice}</p>}
  </section>
}

function captureLabel(capture: Capture): string {
  if (capture.state === 'UPLOADING') return 'Enviando'
  if (capture.state === 'ACTION_REQUIRED') return 'Ação necessária'
  if (capture.state === 'LOCAL_PENDING') return capture.error ? 'Erro de envio · nova tentativa pendente' : 'Aguardando envio'
  switch (capture.remoteStatus) {
    case 'OCR_PENDING': return 'Recebida · aguardando processamento'
    case 'OCR_PROCESSING': return 'Recebida · processando'
    case 'NEEDS_REVIEW': return 'Recebida · em revisão'
    case 'OCR_FAILED': return 'Recebida · erro no processamento'
    case 'IDENTIFIED': return 'Recebida · identificada'
    default: return 'Recebida'
  }
}

function InventoryPanel({ owner, denied }: { owner: string; denied: () => void }) {
  const [page, setPage] = useState<Inventory>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (cursor?: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await authenticated<Inventory>(owner, '/me/inventory' + (cursor ? '?after=' + cursor : ''))
      setPage((previous) => cursor && previous ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) denied()
      if (!cursor) setPage(undefined)
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [denied, owner])

  useEffect(() => { void load() }, [load])

  return <section className="card">
    <div className="section-head"><h2>Estoque particular</h2><button onClick={() => void load()} disabled={loading}>Atualizar</button></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading && !page && <p role="status">Consultando seu estoque…</p>}
    {page?.items.length === 0 && <p>Nenhum equipamento identificado em sua custódia.</p>}
    {!!page?.items.length && <ul className="items">{page.items.map((item) =>
      <li key={item.id}>
        <strong>Em posse · aguardando devolução</strong>
        <ul>{item.identifiers.map((identifier) =>
          <li key={identifier.kind + identifier.normalized_value}>{identifier.kind === 'SERIAL' ? 'Serial' : identifier.kind}: {identifier.raw_value}</li>
        )}</ul>
      </li>
    )}</ul>}
    {page?.next_cursor && <button onClick={() => void load(page.next_cursor!)} disabled={loading}>Carregar mais</button>}
  </section>
}

function Desk({ profile, deny, syncing, run, leaveDesk }: {
  profile: Profile; deny: () => void; syncing: boolean
  run: (force: boolean) => Promise<void>; leaveDesk: () => Promise<void>
}) {
  const [notice, setNotice] = useState('')
  const [success, setSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [tab, setTab] = useState<'captures' | 'inventory'>('captures')
  const [lowSpace, setLowSpace] = useState(false)
  const [checking, setChecking] = useState<string>()
  const [barcode, setBarcode] = useState('')
  const [scanBarcode, setScanBarcode] = useState(false)
  const camera = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const captures = useLiveQuery(async () => (await db.captures.where('owner').equals(profile.id).sortBy('capturedAt')).reverse(),
    [profile.id])
  const pending = captures?.filter((capture) => capture.state !== 'UPLOADED').length
  const checkSpace = useCallback(async () => {
    const free = await freeSpace()
    setLowSpace(free !== null && free < 40 * 1024 * 1024)
  }, [])

  useEffect(() => { void checkSpace() }, [checkSpace])

  async function save(file?: File) {
    if (!file) return
    const capturedAt = new Date().toISOString()
    setNotice('')
    setSuccess('')
    setSaving(true)
    try {
      void navigator.storage?.persist?.().catch(() => false)
      const photo = await preparePhoto(file)
      const manual = barcode.trim()
      if (manual && !validBarcode(manual)) throw new Error('Use um código de até 128 bytes.')
      const evidence = manual ? { raw_value: manual, source: 'MANUAL' as const }
        : scanBarcode ? await readBarcode(photo) : undefined
      await storePhoto(profile.id, photo, capturedAt, evidence)
      setBarcode('')
      setSuccess(scanBarcode && !evidence ? 'Foto salva. Nenhum código legível foi encontrado.' : 'Foto salva no dispositivo.')
      void run(false)
    } catch (error) {
      setNotice(message(error))
    } finally {
      setSaving(false)
      void checkSpace()
    }
  }

  async function exit() {
    setLeaving(true)
    setNotice('')
    try { await leaveDesk() } catch (error) { setNotice(message(error)) }
    finally { setLeaving(false) }
  }

  async function check(capture: Capture) {
    setNotice('')
    setChecking(capture.id)
    try { await refreshCapture(capture) }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) deny()
      setNotice(message(error))
    }
    finally { setChecking(undefined) }
  }

  return <>
    <div className="workspace-head">
      <div><p className="eyebrow">Área do técnico</p><h1>Recolhimentos</h1><p className="muted">{profile.name}</p></div>
      <button disabled={leaving || syncing || saving || pending === undefined}
        onClick={() => pending ? setConfirmLeave(true) : void exit()}>{navigator.onLine ? 'Sair' : 'Bloquear aplicativo'}</button>
    </div>
    {confirmLeave && <section className="card" aria-label="Encerrar sessão">
      <p>Há {pending ?? 0} foto(s) a enviar. Elas ficarão neste dispositivo e só poderão ser enviadas quando você entrar novamente com esta conta.</p>
      <div className="actions">
        <button onClick={() => setConfirmLeave(false)} disabled={leaving}>Continuar na conta</button>
        <button onClick={() => void exit()} disabled={leaving || syncing || saving}>{navigator.onLine ? 'Sair e manter fotos' : 'Bloquear e manter fotos'}</button>
      </div>
    </section>}
    <nav aria-label="Área do técnico" className="tabs">
      <button aria-current={tab === 'captures' ? 'page' : undefined} onClick={() => setTab('captures')}>Capturas</button>
      <button aria-current={tab === 'inventory' ? 'page' : undefined} onClick={() => setTab('inventory')}>Estoque particular</button>
    </nav>
    {notice && <p role="alert" className="alert">{notice}</p>}
    {tab === 'inventory' ? <InventoryPanel owner={profile.id} denied={deny} /> : <>
      <section className="card capture-card">
        <h2>Fotografar etiqueta</h2>
        <p>Enquadre a etiqueta inteira e confira se o serial e os MACs estão legíveis.</p>
        <div className="actions">
          <button className="primary" disabled={saving || leaving}
            onClick={() => camera.current?.click()}>Abrir câmera</button>
          <button disabled={saving || leaving} onClick={() => picker.current?.click()}>Escolher foto</button>
        </div>
        <details>
          <summary>Código da etiqueta (opcional)</summary>
          <label className="field">Digitar código<input value={barcode} disabled={saving} onChange={(event) => setBarcode(event.target.value)} maxLength={128} /></label>
          <label className="check"><input type="checkbox" checked={scanBarcode} disabled={saving || !!barcode.trim()}
            onChange={(event) => setScanBarcode(event.target.checked)} /> Buscar código na foto</label>
        </details>
        <input ref={camera} aria-label="Foto da câmera" type="file" accept="image/*" capture="environment" hidden
          onChange={(event) => { void save(event.target.files?.[0]); event.target.value = '' }} />
        <input ref={picker} aria-label="Arquivo da foto" type="file" accept="image/*" hidden
          onChange={(event) => { void save(event.target.files?.[0]); event.target.value = '' }} />
        {saving && <p role="status">Salvando foto no dispositivo…</p>}
        {success && <p role="status" className="success">{success}</p>}
        {lowSpace && <p role="alert" className="alert">Pouco espaço disponível. Sincronize antes de liberar espaço.</p>}
      </section>
      <section className="card">
        <div className="section-head">
          <div><h2>Fila de fotos</h2><p className="muted" aria-live="polite">{pending === undefined ? 'Consultando fila…' : `${pending} pendente(s)`}</p></div>
          <button className="primary" disabled={syncing || leaving} onClick={() => void run(true)}>
            {syncing ? 'Sincronizando…' : 'Sincronizar agora'}
          </button>
        </div>
        {captures?.length === 0 && <p>Nenhuma foto registrada neste dispositivo.</p>}
        {!!captures?.length && <ul className="items">{captures.map((capture) => <li key={capture.id} className="queue-row">
          <div><strong>{captureLabel(capture)}</strong><br /><time dateTime={capture.capturedAt}>{dateTime.format(new Date(capture.capturedAt))}</time>
            {capture.lastAttemptAt && capture.state !== 'UPLOADED' && <p className="muted">Última tentativa em {dateTime.format(capture.lastAttemptAt)}</p>}
            {capture.barcode && <p className="muted">Código informado: {capture.barcode.raw_value}</p>}
            {capture.error && <p className="alert">{capture.error}</p>}</div>
          {capture.remoteId && <button disabled={checking !== undefined || leaving}
            onClick={() => void check(capture)}>{checking === capture.id ? 'Consultando…' : 'Consultar status'}</button>}
        </li>)}</ul>}
        {!!pending && <p className="muted">Mantenha o aplicativo aberto para enviar. Limpar os dados do site, desinstalar o app ou perder o armazenamento do navegador pode apagar fotos pendentes.</p>}
      </section>
    </>}
  </>
}

function App() {
  const [dbFailed, setDbFailed] = useState(false)
  const profile = useLiveQuery(() => db.profiles.get('current').catch(() => {
    setDbFailed(true)
    return null
  }).then((value) => value ?? null), [], undefined)
  const [connected, setConnected] = useState(navigator.onLine)
  const [authDenied, setAuthDenied] = useState(false)
  const [staff, setStaff] = useState<User>()
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now())
  const [install, setInstall] = useState<InstallEvent>()
  const [offlineReady, setOfflineReady] = useState(false)
  const [update, setUpdate] = useState(false)
  const updater = useRef<(reload?: boolean) => Promise<void>>(async () => {})
  const running = useRef(false)
  const owner = staff ? undefined : profile?.id
  const deny = useCallback(() => { setAuthDenied(true); setStaff(undefined); clearAccess() }, [])

  const run = useCallback(async (force: boolean) => {
    if (!owner || authDenied || running.current || document.visibilityState !== 'visible') return
    if (!force && !navigator.onLine) return
    running.current = true
    setSyncing(true)
    setError('')
    try {
      await synchronize(owner, force)
      if (!force) {
        try { await resumeSession(owner) }
        catch (failure) {
          if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) throw failure
          // Uma falha de rede preserva a janela de captura offline.
        }
      }
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) deny()
      else setError(message(failure))
    } finally {
      setSyncing(false)
      running.current = false
    }
  }, [owner, authDenied, deny])

  useEffect(() => {
    updater.current = registerSW({
      onOfflineReady: () => setOfflineReady(true),
      onNeedRefresh: () => setUpdate(true),
      onRegisterError: () => setError('Não foi possível preparar o aplicativo para uso offline.'),
    })
    const installPrompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent) }
    window.addEventListener('beforeinstallprompt', installPrompt)
    return () => window.removeEventListener('beforeinstallprompt', installPrompt)
  }, [])

  useEffect(() => {
    const resume = () => {
      setConnected(navigator.onLine)
      setClock(Date.now())
      void run(false)
    }
    resume()
    window.addEventListener('online', resume)
    window.addEventListener('offline', resume)
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', resume)
    const interval = window.setInterval(resume, 8_000)
    return () => {
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', resume)
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', resume)
      window.clearInterval(interval)
    }
  }, [run])

  useEffect(() => {
    if (owner) void removeExpiredPhotos(owner).catch(() => {})
  }, [owner])

  async function leaveDesk() {
    if (running.current) throw new Error('Aguarde o término da sincronização para sair.')
    if (navigator.onLine) await leave()
    else await lockDevice()
    setAuthDenied(false)
  }

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone
  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const needsLogin = !profile || authDenied || clock > profile.offlineUntil
  return <>
    <header className="topbar"><div className="topbar-content">
      <div className="brand"><img src="/icons/icon-192.png" alt="" width="42" height="42" /><span>Newlife Estoque</span></div>
      <span className="connectivity" data-online={connected}><i aria-hidden="true" />{connected ? 'Rede disponível' : 'Sem conexão'}</span>
    </div></header>
    <main>
      {update && <div className="card section-head"><p>Há uma nova versão. As fotos salvas serão mantidas.</p>
        <button disabled={syncing} onClick={() => void updater.current(true)}>Atualizar aplicativo</button></div>}
      {offlineReady && !standalone && !staff && <p className="notice" role="status">Aplicativo preparado para abrir offline.</p>}
      {error && <p className="alert" role="alert">{error}</p>}
      {dbFailed ? <p className="alert" role="alert">O armazenamento do navegador está indisponível. Abra o aplicativo em uma janela com armazenamento habilitado.</p>
        : staff?.role === 'administrator' ? <ReviewDesk admin={staff} denied={deny} exit={async () => { await leave(); setStaff(undefined) }} />
        : staff?.role === 'warehouse_clerk' ? <ReceivingDesk clerk={staff} denied={deny} exit={async () => { await leave(); setStaff(undefined) }} />
        : profile === undefined ? <p role="status">Abrindo aplicativo…</p>
        : needsLogin ? <Login reauthenticate={!!profile} done={(user) => {
          if (user.role === 'administrator' || user.role === 'warehouse_clerk') setStaff(user)
          setClock(Date.now())
          setAuthDenied(false)
        }} />
        : <Desk key={profile.id} profile={profile} deny={deny}
          syncing={syncing} run={run} leaveDesk={leaveDesk} />}
      {!standalone && install && <button className="install" onClick={() => { void install.prompt(); setInstall(undefined) }}>Instalar aplicativo</button>}
      {!standalone && appleMobile && <p className="muted install">No Safari, toque em Compartilhar e em Adicionar à Tela de Início.</p>}
    </main>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
