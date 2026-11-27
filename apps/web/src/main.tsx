import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveQuery } from 'dexie-react-hooks'
import { registerSW } from 'virtual:pwa-register'
import { ApiError, clearAccess, enter, leave, lockDevice, restoreStaff, resumeSession } from './api'
import { db, type User } from './db'
import { TechDesk } from './technician/tech_desk'
import { DesktopShell } from './desktop_shell'
import { Icon } from './components/icon'
import './style.css'

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

function Login({ reauthenticate, connected, done, children }: {
  connected: boolean; reauthenticate: boolean; done: (user: User) => void; children?: ReactNode
}) {
  const [loginInput, setLoginInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function performLogin(loginVal: string, passVal: string) {
    setBusy(true)
    setNotice('')
    try {
      const user = await enter(loginVal, passVal)
      done(user)
    } catch (error) {
      setNotice(message(error))
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await performLogin(loginInput, passwordInput)
  }

  return (
    <div className="auth">
      <aside className="auth-brand" aria-hidden="true">
        <span className="auth-logo"><img src="/icons/new-life-logo.png" alt="" /></span>
        <div className="auth-copy">
          <h1>Gerenciador de estoque</h1>
          <p>Roteadores recolhidos em campo e chips da MVNO, rastreados em São Gabriel, Bagé e Passo Fundo.</p>
        </div>
        <ol className="auth-steps">
          <li><Icon name="camera" /><strong>Recolhimento</strong><span>O técnico fotografa a etiqueta do roteador, mesmo sem internet.</span></li>
          <li><Icon name="scan" /><strong>Conferência</strong><span>O estoque bipa cada roteador devolvido e emite o comprovante.</span></li>
          <li><Icon name="sim" /><strong>Chips</strong><span>O estoque bipa os chips entregues a cada técnico e envia a lista pelo WhatsApp.</span></li>
        </ol>
        <p className="auth-footnote">Portal de operações · New Life</p>
      </aside>
      <section className="auth-panel">
        <div className="auth-form-wrap">
          <header>
            <img className="auth-mobile-logo" src="/icons/new-life-logo.png" alt="New Life" />
            <span className="connection" data-online={connected}>{connected ? 'Conectado' : 'Sem conexão'}</span>
            <h2>{reauthenticate ? 'Entre novamente' : 'Entrar'}</h2>
            <p>{reauthenticate
              ? 'As fotos salvas neste aparelho continuam vinculadas à conta que as registrou.'
              : 'Use o login e a senha fornecidos pela sua unidade.'}</p>
          </header>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              Login
              <input name="login" value={loginInput} onChange={(e) => setLoginInput(e.target.value)}
                autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            </label>
            <label>
              Senha
              <input name="password" type="password" value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)} autoComplete="current-password" required />
            </label>
            <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
          </form>
          {notice && <p className="alert" role="alert">{notice}</p>}
        </div>
        {children}
      </section>
    </div>
  )
}

function App() {
  const [dbFailed, setDbFailed] = useState(false)
  const profile = useLiveQuery(
    () =>
      db.profiles
        .get('current')
        .catch(() => {
          setDbFailed(true)
          return null
        })
        .then((value) => value ?? null),
    [],
    undefined
  )
  const [connected, setConnected] = useState(navigator.onLine)
  const [authDenied, setAuthDenied] = useState(false)
  const [staff, setStaff] = useState<User>()
  const [restoringStaff, setRestoringStaff] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now())
  const [install, setInstall] = useState<InstallEvent>()
  const [offlineReady, setOfflineReady] = useState(false)
  const [update, setUpdate] = useState(false)
  const updater = useRef<(reload?: boolean) => Promise<void>>(async () => {})
  const running = useRef(false)
  const owner = staff || restoringStaff ? undefined : profile?.id

  const deny = useCallback(() => {
    setAuthDenied(true)
    setStaff(undefined)
    clearAccess()
  }, [])

  const run = useCallback(
    async (force: boolean) => {
      if (!owner || authDenied || running.current || document.visibilityState !== 'visible') return
      if (!force && !navigator.onLine) return
      running.current = true
      setSyncing(true)
      setError('')
      try {
        const { synchronize } = await import('./sync')
        await synchronize(owner, force)
        if (!force) {
          try {
            await resumeSession(owner)
          } catch (failure) {
            if (failure instanceof ApiError && failure.status === 401) {
              throw failure
            }
          }
        }
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) {
          deny()
        } else {
          setError(message(failure))
        }
      } finally {
        setSyncing(false)
        running.current = false
      }
    },
    [owner, authDenied, deny]
  )

  useEffect(() => {
    void restoreStaff().then(setStaff).finally(() => setRestoringStaff(false))
  }, [])

  useEffect(() => {
    updater.current = registerSW({
      onOfflineReady: () => setOfflineReady(true),
      onNeedRefresh: () => setUpdate(true),
      onRegisterError: () => setError('Não foi possível preparar o aplicativo para uso offline.'),
    })
    const installPrompt = (event: Event) => {
      event.preventDefault()
      setInstall(event as InstallEvent)
    }
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

  async function leaveDesk() {
    if (running.current) throw new Error('Aguarde o término da sincronização para sair.')
    if (navigator.onLine) await leave()
    else await lockDevice()
    setAuthDenied(false)
    setStaff(undefined)
  }

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone
  const appleMobile =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const needsLogin = !profile || authDenied || clock > profile.offlineUntil

  if (dbFailed) {
    return (
      <div className="card alert-box" style={{ margin: '2rem' }}>
        <h2>Armazenamento Indisponível</h2>
        <p>O navegador bloqueou o IndexedDB. Abra o aplicativo em uma janela com armazenamento habilitado.</p>
      </div>
    )
  }

  const updateNotice = update && (
    <aside className="card app-update-notice" aria-label="Atualização do aplicativo">
      <p>Há uma nova versão. As fotos salvas serão mantidas.</p>
      <button disabled={syncing} onClick={() => void updater.current(true)}>Atualizar aplicativo</button>
    </aside>
  )

  // 1. Usuário Administrador ou Estoquista ou Supervisor logado -> Shell Desktop
  if (staff) {
    return (
      <>
        {updateNotice}
        <DesktopShell
          user={staff}
          denied={deny}
          exit={async () => {
            await leave()
            setStaff(undefined)
          }}
          connected={connected}
        />
      </>
    )
  }

  // 2. Carregando perfil inicial
  if (profile === undefined || restoringStaff) {
    return (
      <div className="app-loading-screen">
        <p>Carregando…</p>
      </div>
    )
  }

  // 3. Usuário precisa entrar
  if (needsLogin) {
    return (
      <>
        {updateNotice}
        <main className="login-page">
          <Login
            reauthenticate={!!profile}
            connected={connected}
            done={(user) => {
              if (user.role === 'administrator' || user.role === 'warehouse_clerk') {
                setStaff(user)
              }
              setClock(Date.now())
              setAuthDenied(false)
            }}
          >
            {!standalone && install && (
              <button className="install" onClick={() => { void install.prompt(); setInstall(undefined) }}>
                Instalar aplicativo neste aparelho
              </button>
            )}
            {!standalone && appleMobile && (
              <p className="install">No iPhone, toque em Compartilhar e em Adicionar à Tela de Início.</p>
            )}
          </Login>
        </main>
      </>
    )
  }

  // 4. Usuário Técnico logado -> Interface Móvel Dedicada
  return (
    <>
      {updateNotice}
      <TechDesk
        profile={profile}
        deny={deny}
        connected={connected}
        syncing={syncing}
        run={run}
        leaveDesk={leaveDesk}
      />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
