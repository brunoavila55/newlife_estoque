import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { administrator, ApiError } from './api'
import type { User } from './db'
import { InventoryPanel } from './inventory'
import { ReviewDesk } from './review'

type ManagedUser = User & { active: boolean }
type UserPage = { items: ManagedUser[]; next_cursor: string | null }

const roleLabels: Record<string, string> = {
  technician: 'Técnico',
  warehouse_clerk: 'Estoquista',
  administrator: 'Administrador',
  supervisor: 'Supervisor',
  auditor: 'Auditor',
  platform_admin: 'Administrador SaaS',
}

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'Não foi possível conectar ao servidor. Tente novamente.'
}

export function AdminDesk({ admin, denied }: {
  admin: User; denied: () => void; exit?: () => Promise<void>
}) {
  const [tab, setTab] = useState<'users' | 'create'>('users')
  return <div className="module-container">
    <div className="section-head">
      <div>
        <h1>Usuários e permissões</h1>
        <p>Contas de técnicos, estoquistas e administradores.</p>
      </div>
    </div>
    <nav aria-label="Área administrativa" className="tabs">
      <button aria-current={tab === 'users' ? 'page' : undefined} onClick={() => setTab('users')}>Usuários</button>
      <button aria-current={tab === 'create' ? 'page' : undefined} onClick={() => setTab('create')}>Novo usuário</button>
    </nav>
    {tab === 'users' ? <UsersPanel owner={admin.id} denied={denied} /> : <UserRegistration owner={admin.id} denied={denied} />}
  </div>
}

function UsersPanel({ owner, denied }: { owner: string; denied: () => void }) {
  const [page, setPage] = useState<UserPage>()
  const [selected, setSelected] = useState<User>()
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [managing, setManaging] = useState<ManagedUser>()

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) denied()
    return errorMessage(failure)
  }, [denied])

  const load = useCallback(async (cursor?: string) => {
    setLoading(true)
    setListError('')
    try {
      const data = await administrator<UserPage>(owner, '/admin/users' + (cursor ? '?after=' + cursor : ''))
      setPage((previous) => cursor && previous ? { ...data, items: [...previous.items, ...data.items] } : data)
    } catch (failure) {
      setListError(fail(failure))
    } finally {
      setLoading(false)
    }
  }, [owner, fail])

  useEffect(() => { void load() }, [load])

  if (selected) {
    return <TechnicianProfile key={selected.id} owner={owner} denied={denied}
      technician={selected} back={() => setSelected(undefined)} />
  }

  return (
    <section className="work-list">
      <div className="section-head"><h2>Usuários cadastrados</h2>
        <button className="small-btn" disabled={loading} onClick={() => void load()}>Atualizar</button>
      </div>
      {listError && <p className="alert" role="alert">{listError}</p>}
      {loading && !page && <p role="status" className="muted">Consultando usuários…</p>}
      <div className="card table-card">
        <table className="data-table">
          <thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {page?.items.map((user) => <tr key={user.id} className={user.active ? '' : 'inactive'}>
              <td><strong>{user.name}</strong></td>
              <td className="mono">{user.login}</td>
              <td>{roleLabels[user.role ?? 'technician']}</td>
              <td><span className={'badge ' + (user.active ? 'badge-success' : 'badge-muted')}>{user.active ? 'Ativo' : 'Desativado'}</span></td>
              <td className="num"><div className="row-actions">
                {user.role === 'technician' && <button className="small-btn" onClick={() => setSelected(user)}>Abrir técnico</button>}
                {user.role !== 'administrator' && <button className="small-btn" onClick={() => setManaging(user)}>Gerenciar</button>}
              </div></td>
            </tr>)}
            {page?.items.length === 0 && <tr><td colSpan={5} className="empty-cell">Nenhum usuário cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {page?.next_cursor && <button disabled={loading} onClick={() => void load(page.next_cursor!)}>Carregar mais usuários</button>}
      {managing && <UserManager key={managing.id} owner={owner} user={managing} fail={fail}
        close={() => setManaging(undefined)}
        changed={(user) => {
          setManaging(user)
          setPage((previous) => previous && { ...previous, items: previous.items.map((item) => item.id === user.id ? user : item) })
        }} />}
    </section>
  )
}

function TechnicianProfile({ technician, owner, denied, back }: {
  technician: User; owner: string; denied: () => void; back: () => void
}) {
  const [tab, setTab] = useState<'inventory' | 'deliveries'>('inventory')
  return <section className="module-container">
    <div className="section-head">
      <div><button className="small-btn" onClick={back}>← Voltar aos usuários</button>
        <h2>{technician.name}</h2><p className="mono">{technician.login}</p></div>
    </div>
    <nav aria-label="Perfil do técnico" className="tabs">
      <button aria-current={tab === 'inventory' ? 'page' : undefined} onClick={() => setTab('inventory')}>Em posse</button>
      <button aria-current={tab === 'deliveries' ? 'page' : undefined} onClick={() => setTab('deliveries')}>Já entregues</button>
    </nav>
    <InventoryPanel key={tab} owner={owner} denied={denied} technician={technician} deliveries={tab === 'deliveries'} />
  </section>
}

function UserRegistration({ owner, denied }: { owner: string; denied: () => void }) {
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [created, setCreated] = useState('')

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const form = event.currentTarget
    const fields = new FormData(form)
    setSaving(true)
    setFormError('')
    setCreated('')
    try {
      const user = await administrator<User>(owner, '/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fields.get('name'), login: fields.get('login'),
          role: fields.get('role'), password: fields.get('password'),
        }),
      })
      form.reset()
      setCreated('Conta criada para ' + user.name + ' (' + user.login + ').')
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) denied()
      setFormError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card task-panel">
      <h2>Novo usuário</h2>
      <p className="muted">Entregue a senha inicial à pessoa por um canal seguro.</p>
      <form onSubmit={(event) => void create(event)}>
        <fieldset className="user-fields" disabled={saving}>
          <label>Nome<input name="name" required maxLength={120} /></label>
          <label>Login<input name="login" required minLength={3} maxLength={64} pattern={String.raw`[A-Za-z0-9_.\x2d]{3,64}`} autoCapitalize="none" autoComplete="off" aria-describedby="login-format" /></label>
          <small id="login-format">Use letras sem acento, números, ponto, hífen ou sublinhado.</small>
          <label>Perfil<select name="role"><option value="technician">Técnico</option><option value="warehouse_clerk">Estoquista</option></select></label>
          <label>Senha inicial<input name="password" type="password" required minLength={6} autoComplete="new-password" aria-describedby="password-format" /></label>
          <small id="password-format">Use pelo menos 6 caracteres.</small>
          <button className="primary" type="submit">{saving ? 'Criando usuário…' : 'Criar usuário'}</button>
        </fieldset>
      </form>
      {formError && <p className="alert" role="alert">{formError}</p>}
      {created && <p className="success" role="status">{created}</p>}
    </section>
  )
}

function generatedPassword() {
  // Sem caracteres ambíguos (0/O, 1/l/I) para facilitar o repasse verbal.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint32Array(16))
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('')
}

function UserManager({ owner, user, fail, close, changed }: {
  owner: string; user: ManagedUser; fail: (failure: unknown) => string
  close: () => void; changed: (user: ManagedUser) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState(user.name)
  const [role, setRole] = useState(user.role ?? 'technician')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)

  async function run(work: () => Promise<string>) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setNotice(await work())
    } catch (failure) {
      setError(fail(failure))
    } finally {
      setBusy(false)
    }
  }

  const path = '/admin/users/' + user.id
  const json = { 'Content-Type': 'application/json' }
  const roleChanged = role !== user.role

  function save(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const updated = await administrator<ManagedUser>(owner, path, {
        method: 'PATCH', headers: json,
        body: JSON.stringify({ name, ...(roleChanged ? { role } : {}) }),
      })
      changed(updated)
      return roleChanged
        ? 'Dados salvos. O perfil agora é ' + roleLabels[updated.role ?? 'technician'] + ' e as sessões abertas foram encerradas.'
        : 'Dados salvos.'
    })
  }

  function reset(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      await administrator<void>(owner, path + '/reset-password', {
        method: 'POST', headers: json, body: JSON.stringify({ password }),
      })
      return 'Senha redefinida. As sessões abertas de ' + user.name + ' foram encerradas; entregue a nova senha por um canal seguro.'
    })
  }

  function toggleActive() {
    void run(async () => {
      await administrator<void>(owner, path + (user.active ? '/disable' : '/enable'), { method: 'POST' })
      changed({ ...user, active: !user.active })
      setConfirmDisable(false)
      return user.active ? 'Conta desativada e sessões encerradas.' : 'Conta reativada. A pessoa já pode entrar com a senha atual.'
    })
  }

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="user-manager-title"
    onClick={(event) => { if (event.target === event.currentTarget && !busy) close() }}
    onKeyDown={(event) => { if (event.key === 'Escape' && !busy) close() }}>
    <section className="card modal-panel">
      <div className="section-head">
        <div>
          <h2 id="user-manager-title">{user.name}</h2>
          <p><span className="mono">{user.login}</span> · {roleLabels[user.role ?? 'technician']} · {user.active ? 'Ativo' : 'Desativado'}</p>
        </div>
        <button type="button" className="small-btn" onClick={close} disabled={busy} autoFocus>Fechar</button>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}

      <form className="task-panel" onSubmit={save}>
        <h3>Dados e permissões</h3>
        <fieldset className="user-fields" disabled={busy}>
          <label>Nome<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
          <label>Perfil<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="technician">Técnico</option>
            <option value="warehouse_clerk">Estoquista</option>
          </select></label>
          {roleChanged && <small>Trocar o perfil encerra as sessões da pessoa. Técnicos com equipamentos em posse, capturas sem identificação, lotes ou sessões de recebimento em aberto não podem mudar de perfil até a pendência ser resolvida.</small>}
          <button className="primary" type="submit" disabled={name.trim() === user.name && !roleChanged}>{busy ? 'Salvando…' : 'Salvar alterações'}</button>
        </fieldset>
      </form>

      <form className="task-panel" onSubmit={reset}>
        <h3>Redefinir senha</h3>
        <p className="muted">A nova senha passa a valer imediatamente e todas as sessões da pessoa são encerradas.</p>
        <fieldset className="user-fields" disabled={busy}>
          <label>Nova senha<input type={revealed ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)}
            required minLength={6} autoComplete="new-password" aria-describedby="reset-format" /></label>
          <small id="reset-format">Use pelo menos 6 caracteres.</small>
          <div className="actions">
            <button type="button" className="small-btn" onClick={() => { setPassword(generatedPassword()); setRevealed(true) }}>Gerar senha</button>
            <button type="button" className="small-btn" onClick={() => setRevealed(!revealed)}>{revealed ? 'Ocultar' : 'Mostrar'}</button>
          </div>
          <button className="primary" type="submit">{busy ? 'Redefinindo…' : 'Redefinir senha'}</button>
        </fieldset>
      </form>

      <div className="task-panel">
        <h3>Acesso</h3>
        {user.active
          ? <p className="muted">Desativar impede novos acessos e encerra as sessões abertas. Equipamentos em posse e o histórico são preservados.</p>
          : <p className="muted">A conta está desativada. Reativar permite entrar novamente com a senha atual.</p>}
        <div className="actions">
          {user.active && !confirmDisable && <button type="button" className="danger-btn" disabled={busy} onClick={() => setConfirmDisable(true)}>Desativar conta</button>}
          {user.active && confirmDisable && <>
            <button type="button" className="danger-btn" disabled={busy} onClick={toggleActive}>Confirmar desativação</button>
            <button type="button" className="small-btn" disabled={busy} onClick={() => setConfirmDisable(false)}>Cancelar</button>
          </>}
          {!user.active && <button type="button" className="primary" disabled={busy} onClick={toggleActive}>Reativar conta</button>}
        </div>
      </div>
    </section>
  </div>
}
