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
              <td className="num">{user.role === 'technician' && <button className="small-btn" onClick={() => setSelected(user)}>Abrir técnico</button>}</td>
            </tr>)}
            {page?.items.length === 0 && <tr><td colSpan={5} className="empty-cell">Nenhum usuário cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {page?.next_cursor && <button disabled={loading} onClick={() => void load(page.next_cursor!)}>Carregar mais usuários</button>}
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
          <label>Senha inicial<input name="password" type="password" required minLength={12} autoComplete="new-password" aria-describedby="password-format" /></label>
          <small id="password-format">Use pelo menos 12 caracteres.</small>
          <button className="primary" type="submit">{saving ? 'Criando usuário…' : 'Criar usuário'}</button>
        </fieldset>
      </form>
      {formError && <p className="alert" role="alert">{formError}</p>}
      {created && <p className="success" role="status">{created}</p>}
    </section>
  )
}
