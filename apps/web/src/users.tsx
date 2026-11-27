import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { administrator, ApiError } from './api'
import type { User } from './db'
import { InventoryPanel } from './inventory'
import { ReviewDesk } from './review'

type ManagedUser = User & { active: boolean; whatsapp: string | null; location_id: string | null }
type City = { id: string; name: string }

/** Cidades cadastradas, para escolher onde cada técnico e estoquista atua. */
function useCities(owner: string): City[] {
  const [cities, setCities] = useState<City[]>([])
  useEffect(() => {
    administrator<{ items: City[] }>(owner, '/locations').then((data) => setCities(data.items), () => setCities([]))
  }, [owner])
  return cities
}

/** Exibe 5511987654321 como +55 (11) 98765-4321. */
export function formatWhatsapp(digits: string | null | undefined) {
  if (!digits) return ''
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits)
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : '+' + digits
}
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
  const [removed, setRemoved] = useState('')
  const [cityFilter, setCityFilter] = useState('')
  const cities = useCities(owner)
  const cityName = (id: string | null) => cities.find((city) => city.id === id)?.name

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
        <div className="actions">
          <select aria-label="Filtrar por cidade" value={cityFilter} onChange={(event) => setCityFilter(event.target.value)}>
            <option value="">Todas as cidades</option>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
          <button className="small-btn" disabled={loading} onClick={() => void load()}>Atualizar</button>
        </div>
      </div>
      {listError && <p className="alert" role="alert">{listError}</p>}
      {removed && <p className="success" role="status">{removed}</p>}
      {loading && !page && <p role="status" className="muted">Consultando usuários…</p>}
      <div className="card table-card">
        <table className="data-table">
          <thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Cidade</th><th>WhatsApp</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {page?.items.filter((user) => !cityFilter || user.location_id === cityFilter).map((user) => <tr key={user.id} className={user.active ? '' : 'inactive'}>
              <td><strong>{user.name}</strong>{user.id === owner && <span className="muted"> (você)</span>}</td>
              <td className="mono">{user.login}</td>
              <td>{roleLabels[user.role ?? 'technician']}</td>
              <td>{cityName(user.location_id) ?? (user.role === 'administrator' ? 'Todas' : '—')}</td>
              <td className="mono">{formatWhatsapp(user.whatsapp) || '—'}</td>
              <td><span className={'badge ' + (user.active ? 'badge-success' : 'badge-muted')}>{user.active ? 'Ativo' : 'Desativado'}</span></td>
              <td className="num"><div className="row-actions">
                {user.role === 'technician' && <button className="small-btn" onClick={() => setSelected(user)}>Abrir técnico</button>}
                <button className="small-btn" onClick={() => { setRemoved(''); setManaging(user) }}>Gerenciar</button>
              </div></td>
            </tr>)}
            {page?.items.length === 0 && <tr><td colSpan={7} className="empty-cell">Nenhum usuário cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {page?.next_cursor && <button disabled={loading} onClick={() => void load(page.next_cursor!)}>Carregar mais usuários</button>}
      {managing && <UserManager key={managing.id} owner={owner} user={managing} fail={fail} cities={cities}
        close={() => setManaging(undefined)}
        deleted={(message) => {
          const id = managing.id
          setManaging(undefined)
          setRemoved(message)
          setPage((previous) => previous && { ...previous, items: previous.items.filter((item) => item.id !== id) })
        }}
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
  const cities = useCities(owner)
  const [role, setRole] = useState('technician')
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
          whatsapp: fields.get('whatsapp'),
          location_id: fields.get('location_id') || null,
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
          <label>Perfil<select name="role" value={role} onChange={(event) => setRole(event.target.value)}><option value="technician">Técnico</option><option value="warehouse_clerk">Estoquista</option><option value="administrator">Administrador</option></select></label>
          <label>Cidade<select name="location_id" required={role !== 'administrator'} defaultValue="">
            <option value="" disabled={role !== 'administrator'}>{role === 'administrator' ? 'Todas (sem cidade fixa)' : 'Escolha a cidade'}</option>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select></label>
          <small>Técnicos e estoquistas só veem e movimentam o estoque da própria cidade.</small>
          <label>WhatsApp<input name="whatsapp" type="tel" inputMode="tel" autoComplete="off" maxLength={24} placeholder="(11) 98765-4321" aria-describedby="whatsapp-format" /></label>
          <small id="whatsapp-format">Com DDD. O comprovante de devolução é enviado para este número, sem papel.</small>
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

function UserManager({ owner, user, fail, close, changed, deleted, cities }: {
  owner: string; user: ManagedUser; fail: (failure: unknown) => string; cities: City[]
  close: () => void; changed: (user: ManagedUser) => void; deleted: (message: string) => void
}) {
  const self = user.id === owner
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState(user.name)
  const [role, setRole] = useState(user.role ?? 'technician')
  const [whatsapp, setWhatsapp] = useState(formatWhatsapp(user.whatsapp))
  const [location, setLocation] = useState(user.location_id ?? '')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState('')

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
  const whatsappChanged = whatsapp.trim() !== formatWhatsapp(user.whatsapp)
  const locationChanged = location !== '' && location !== (user.location_id ?? '')

  function save(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const updated = await administrator<ManagedUser>(owner, path, {
        method: 'PATCH', headers: json,
        body: JSON.stringify({ name, ...(roleChanged ? { role } : {}), ...(whatsappChanged ? { whatsapp } : {}),
          ...(locationChanged ? { location_id: location } : {}) }),
      })
      changed(updated)
      setWhatsapp(formatWhatsapp(updated.whatsapp))
      if (roleChanged) return 'Dados salvos. O perfil agora é ' + roleLabels[updated.role ?? 'technician'] + ' e as sessões abertas foram encerradas.'
      if (locationChanged) return 'Dados salvos. A cidade agora é ' + (cities.find((city) => city.id === updated.location_id)?.name ?? '') + ' e as sessões abertas foram encerradas.'
      return 'Dados salvos.'
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

  async function remove() {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await administrator<{ mode: 'removed' | 'archived' }>(owner, path, { method: 'DELETE' })
      deleted(result.mode === 'removed'
        ? 'Conta de ' + user.name + ' excluída. O login ' + user.login + ' está livre para um novo cadastro.'
        : 'Conta de ' + user.name + ' excluída. O histórico de equipamentos e entregas foi mantido, e o login ' + user.login + ' fica reservado.')
    } catch (failure) {
      setError(fail(failure))
      setBusy(false)
    }
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
          <label>Perfil<select value={role} disabled={self} onChange={(event) => setRole(event.target.value as typeof role)}
            aria-describedby={self ? 'manage-self-role' : undefined}>
            <option value="technician">Técnico</option>
            <option value="warehouse_clerk">Estoquista</option>
            <option value="administrator">Administrador</option>
          </select></label>
          <label>Cidade<select value={location} onChange={(event) => setLocation(event.target.value)}>
            {!user.location_id && <option value="">{role === 'administrator' ? 'Todas (sem cidade fixa)' : 'Escolha a cidade'}</option>}
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select></label>
          {locationChanged && <small>Trocar a cidade encerra as sessões da pessoa. Técnicos com roteadores, chips, capturas ou lotes em aberto precisam resolver as pendências antes.</small>}
          {self && <small id="manage-self-role">Você não pode trocar o próprio perfil. Peça a outro administrador.</small>}
          <label>WhatsApp<input type="tel" inputMode="tel" autoComplete="off" maxLength={24} value={whatsapp}
            onChange={(event) => setWhatsapp(event.target.value)} placeholder="(11) 98765-4321" aria-describedby="manage-whatsapp" /></label>
          <small id="manage-whatsapp">Com DDD. Recebe o comprovante de devolução. Deixe vazio para remover.</small>
          {roleChanged && <small>Trocar o perfil encerra as sessões da pessoa. Técnicos com equipamentos em posse, capturas sem identificação, lotes ou sessões de recebimento em aberto não podem mudar de perfil até a pendência ser resolvida.</small>}
          <button className="primary" type="submit" disabled={name.trim() === user.name && !roleChanged && !whatsappChanged && !locationChanged}>{busy ? 'Salvando…' : 'Salvar alterações'}</button>
        </fieldset>
      </form>

      <form className="task-panel" onSubmit={reset}>
        <h3>Redefinir senha</h3>
        <p className="muted">{self
          ? 'A nova senha passa a valer imediatamente e todas as suas sessões são encerradas: você precisará entrar de novo.'
          : 'A nova senha passa a valer imediatamente e todas as sessões da pessoa são encerradas.'}</p>
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

      {self ? <div className="task-panel">
        <h3>Acesso</h3>
        <p className="muted">Esta é a sua conta. Para desativá-la ou excluí-la, peça a outro administrador.</p>
      </div> : <>
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

      <form className="task-panel" onSubmit={(event) => { event.preventDefault(); if (confirmDelete.trim() === user.login) void remove() }}>
        <h3>Excluir conta</h3>
        <p className="muted">A conta deixa de existir e não pode ser recuperada. Se a pessoa já registrou coletas, entregas ou conferências,
          esse histórico continua nos registros de equipamentos e o login fica reservado. Não é possível excluir quem ainda tem
          equipamentos em posse, capturas sem identificação, lotes ou sessões de recebimento em aberto.</p>
        <fieldset className="user-fields" disabled={busy}>
          <label>Digite <strong className="mono">{user.login}</strong> para confirmar
            <input className="mono" value={confirmDelete} autoCapitalize="none" autoComplete="off" spellCheck={false}
              onChange={(event) => setConfirmDelete(event.target.value)} />
          </label>
          <button type="submit" className="danger-btn" disabled={confirmDelete.trim() !== user.login}>{busy ? 'Excluindo…' : 'Excluir conta'}</button>
        </fieldset>
      </form>
      </>}
    </section>
  </div>
}
