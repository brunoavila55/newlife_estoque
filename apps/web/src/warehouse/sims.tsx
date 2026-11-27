import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { ApiError, warehouse } from '../api'
import { playSound } from '../audio'
import { Icon } from '../components/icon'
import { dateTime, jsonPost, type Page } from '../delivery'
import { formatWhatsapp } from '../users'
import { readSimSheet, sheetErrorMessage, type SimSheet } from '../xlsx'

export type City = { id: string; name: string }

type Card = {
  id: string; iccid: string; carrier: string | null; mvno_display: string | null
  operator_status: string | null; subscriber: string | null
  location_id: string | null; location_name: string | null
  technician_id: string | null; technician_name: string | null
  holder_location_id: string | null; holder_location_name: string | null; since: string
}
type History = { type: 'IMPORTED' | 'DELIVERED' | 'RETURNED'; at: string; holder: string; actor: string; transfer_number: number | null }
type Lookup =
  | { result: 'FOUND'; card: Card; history: History[] }
  | { result: 'UNKNOWN' | 'AMBIGUOUS'; iccid: string }
  | { result: 'INVALID'; reason: string }
type TechnicianSims = {
  id: string; name: string; login: string; active: boolean; whatsapp: string | null
  sims: number; last_delivery_at: string | null
}
type Kind = 'DELIVERY' | 'RETURN'
type TransferSummary = {
  id: string; number: number; kind: Kind; location_id: string; location_name: string
  technician_id: string; technician_name: string; technician_whatsapp: string | null
  clerk_name: string; notes: string | null; created_at: string; total: number
}
type TransferDetail = { transfer: TransferSummary; items: { iccid: string; operator_status: string | null }[] }
type Problem = { iccid: string; reason: string }

const kindText: Record<Kind, { title: string; verb: string; badge: string }> = {
  DELIVERY: { title: 'Entrega de chips', verb: 'Entregar', badge: 'badge-info' },
  RETURN: { title: 'Devolução de chips', verb: 'Receber devolução', badge: 'badge-warning' },
}
const movementLabel: Record<History['type'], string> = {
  IMPORTED: 'Entrada pela planilha', DELIVERED: 'Entregue ao técnico', RETURNED: 'Devolvido ao estoque',
}

function transferName(transfer: Pick<TransferSummary, 'kind' | 'number'>) {
  return (transfer.kind === 'DELIVERY' ? 'Entrega ' : 'Devolução ') + String(transfer.number).padStart(4, '0')
}

function failure(error: unknown, denied: () => void): string {
  if (error instanceof ApiError && error.status === 401) denied()
  return error instanceof ApiError ? error.message : 'Sem conexão com o servidor. Tente novamente.'
}

function holderText(card: Card): string {
  if (card.technician_name) return 'Com ' + card.technician_name
  return 'Estoque de ' + (card.location_name ?? '—')
}

// ---------------------------------------------------------------------------
// Mesa de entrega e devolução
// ---------------------------------------------------------------------------

type Draft = { kind: Kind; technicianId?: string; items: { iccid: string; status: string | null }[]; key: string; notes: string }

function emptyDraft(kind: Kind = 'DELIVERY'): Draft {
  return { kind, items: [], key: crypto.randomUUID(), notes: '' }
}

/** Entrega de chips ao técnico (ou devolução) por bipe contínuo, com confirmação única e comprovante. */
export function SimDesk({ owner, clerkName, city, denied }: {
  owner: string; clerkName: string; city: City; denied: () => void
}) {
  const storageKey = 'newlife-sim-draft:' + owner + ':' + city.id
  const [draft, setDraftState] = useState<Draft>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      return saved ? JSON.parse(saved) as Draft : emptyDraft()
    } catch {
      return emptyDraft()
    }
  })
  const [technicians, setTechnicians] = useState<TechnicianSims[]>()
  const [search, setSearch] = useState('')
  const [value, setValue] = useState('')
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string }>()
  const [problems, setProblems] = useState<Problem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<TransferDetail>()
  const [terminator] = useState(() => localStorage.getItem('newlife-scanner-suffix') ?? 'Enter')
  const field = useRef<HTMLInputElement>(null)
  const queue = useRef(Promise.resolve())
  const latest = useRef(draft)

  const setDraft = useCallback((update: (previous: Draft) => Draft) => {
    setDraftState((previous) => {
      const next = update(previous)
      latest.current = next
      sessionStorage.setItem(storageKey, JSON.stringify(next))
      return next
    })
  }, [storageKey])

  const loadTechnicians = useCallback(async () => {
    try {
      const data = await warehouse<{ items: TechnicianSims[] }>(owner, '/sims/technicians')
      setTechnicians(data.items)
    } catch (error) {
      setError(failure(error, denied))
    }
  }, [denied, owner])
  useEffect(() => { void loadTechnicians() }, [loadTechnicians])

  const technician = technicians?.find((item) => item.id === draft.technicianId)
  const focusScanner = useCallback(() => requestAnimationFrame(() => field.current?.focus()), [])
  useEffect(() => {
    if (!technician || done) return
    focusScanner()
    function capture(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select')) return
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) field.current?.focus()
    }
    window.addEventListener('keydown', capture)
    return () => window.removeEventListener('keydown', capture)
  }, [technician, done, focusScanner])

  async function check(code: string) {
    const current = latest.current
    if (!current.technicianId) return
    let lookup: Lookup
    try {
      lookup = await warehouse<Lookup>(owner, '/sims/lookup?code=' + encodeURIComponent(code))
    } catch (error) {
      setError(failure(error, denied))
      playSound('ERROR')
      return
    }
    setError('')
    if (lookup.result === 'INVALID') {
      setFlash({ tone: 'bad', text: code + ' · ' + lookup.reason })
      playSound('ERROR')
      return
    }
    if (lookup.result !== 'FOUND') {
      setFlash({ tone: 'bad', text: lookup.iccid + ' · chip não cadastrado. Separe e importe a planilha da operadora.' })
      playSound('UNKNOWN')
      return
    }
    const card = lookup.card
    if (latest.current.items.some((item) => item.iccid.slice(0, 19) === card.iccid.slice(0, 19))) {
      setFlash({ tone: 'warn', text: card.iccid + ' · já está na lista.' })
      playSound('DUPLICATE')
      return
    }
    const ok = current.kind === 'DELIVERY'
      ? card.location_id === city.id
      : card.technician_id === current.technicianId
    if (!ok) {
      const where = card.technician_id === current.technicianId
        ? 'já está com este técnico'
        : card.technician_name ? 'está com ' + card.technician_name : 'está no estoque de ' + card.location_name
      setFlash({ tone: 'bad', text: card.iccid + ' · ' + where + '. Separe este chip.' })
      playSound('UNKNOWN')
      return
    }
    setDraft((previous) => ({ ...previous, items: [...previous.items, { iccid: card.iccid, status: card.operator_status }] }))
    setProblems((previous) => previous.filter((problem) => problem.iccid !== card.iccid))
    setFlash({ tone: 'ok', text: card.iccid + ' · adicionado' + (card.operator_status ? ' · operadora: ' + card.operator_status : '') })
    playSound('MATCHED')
  }

  function submitScan() {
    const code = value.trim()
    if (!code) return
    setValue('')
    queue.current = queue.current.then(() => check(code))
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void confirm()
      return
    }
    if (event.key === terminator || event.key === 'Enter') {
      event.preventDefault()
      submitScan()
    }
  }

  async function confirm() {
    const current = latest.current
    if (busy || !current.technicianId || current.items.length === 0) return
    await queue.current
    setBusy(true)
    setError('')
    try {
      const result = await warehouse<TransferDetail>(owner, '/sims/transfers', jsonPost({
        client_transfer_id: current.key, kind: current.kind, technician_id: current.technicianId,
        iccids: current.items.map((item) => item.iccid), notes: current.notes.trim() || null,
      }))
      sessionStorage.removeItem(storageKey)
      setDone(result)
      setProblems([])
      playSound('MATCHED')
      void loadTechnicians()
    } catch (error) {
      const body = error instanceof ApiError ? error.body as { problems?: Problem[] } | undefined : undefined
      if (body?.problems) {
        setProblems(body.problems)
        // A lista mudou de situação no servidor: uma nova tentativa usa outra chave.
        setDraft((previous) => ({ ...previous, key: crypto.randomUUID() }))
      }
      setError(failure(error, denied))
      playSound('ERROR')
    } finally {
      setBusy(false)
      focusScanner()
    }
  }

  function restart(kind: Kind = draft.kind, technicianId?: string) {
    setDone(undefined)
    setProblems([])
    setFlash(undefined)
    setDraft(() => ({ ...emptyDraft(kind), technicianId }))
  }

  if (done) {
    return <div className="module-container">
      <div className="section-head">
        <div><h1>{transferName(done.transfer)} registrada</h1>
          <p>{done.transfer.total} chip{done.transfer.total > 1 ? 's' : ''} {done.transfer.kind === 'DELIVERY' ? 'agora sob responsabilidade de' : 'devolvidos por'} {done.transfer.technician_name}.</p></div>
        <button className="primary" onClick={() => restart()}>Nova movimentação</button>
      </div>
      <TransferVoucher detail={done} />
    </div>
  }

  const term = search.trim().toLowerCase()
  const listed = (technicians ?? []).filter((item) => item.active
    && (!term || item.name.toLowerCase().includes(term) || item.login.includes(term)))
  const problemOf = new Map(problems.map((problem) => [problem.iccid, problem.reason]))

  return <div className="module-container">
    <div className="section-head">
      <div>
        <h1>Entregar chips</h1>
        <p>Bipe os chips, confira a lista e confirme. Cada ICCID fica registrado no nome do técnico em {city.name}.</p>
      </div>
      <nav className="tabs" aria-label="Tipo de movimentação">
        {(['DELIVERY', 'RETURN'] as Kind[]).map((kind) => <button key={kind} aria-current={draft.kind === kind ? 'page' : undefined}
          disabled={draft.items.length > 0} onClick={() => restart(kind, draft.technicianId)}>{kind === 'DELIVERY' ? 'Entrega ao técnico' : 'Devolução ao estoque'}</button>)}
      </nav>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}

    {!technician ? <section className="card">
      <div className="section-head">
        <h2>{draft.kind === 'DELIVERY' ? 'Para quem são os chips?' : 'Quem está devolvendo?'}</h2>
        <input type="search" placeholder="Buscar técnico" value={search} autoFocus
          onChange={(event) => setSearch(event.target.value)} aria-label="Buscar técnico" />
      </div>
      {!technicians && <p className="muted" role="status">Carregando técnicos…</p>}
      {technicians && listed.length === 0 && <p className="empty-state">Nenhum técnico ativo em {city.name}.</p>}
      <div className="batch-grid">{listed.map((item) => <button key={item.id} type="button" className="card batch-card"
        disabled={draft.kind === 'RETURN' && item.sims === 0}
        onClick={() => setDraft((previous) => ({ ...previous, technicianId: item.id }))}>
        <span className="batch-card-tech">{item.name}</span>
        <span className="muted small-text">{item.sims} chip{item.sims === 1 ? '' : 's'} em posse
          {item.last_delivery_at && ' · última entrega ' + dateTime.format(new Date(item.last_delivery_at))}</span>
      </button>)}</div>
    </section> : <>
      <section className="card counter-scan">
        <div className="section-head">
          <div><span className={'badge ' + kindText[draft.kind].badge}>{kindText[draft.kind].title}</span>
            <h2>{technician.name}</h2>
            <p className="muted small-text">{technician.sims} chip{technician.sims === 1 ? '' : 's'} em posse antes desta movimentação</p></div>
          <button type="button" className="small-btn" disabled={draft.items.length > 0 || busy}
            onClick={() => setDraft((previous) => ({ ...previous, technicianId: undefined }))}>Trocar técnico</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); submitScan() }}>
          <label className="counter-field">
            <span>Bipe o chip</span>
            <input ref={field} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown}
              autoComplete="off" spellCheck={false} maxLength={64} inputMode="numeric" disabled={busy}
              placeholder="ICCID (89…)" aria-describedby="sim-hint" />
          </label>
          <div className="counter-scan-side">
            <button type="submit" className="small-btn" disabled={busy || !value.trim()}>Adicionar</button>
          </div>
        </form>
        <p id="sim-hint" className="muted small-text">O leitor adiciona cada chip à lista. Para confirmar, use o botão ou <kbd>Ctrl</kbd> + <kbd>Enter</kbd>.</p>
        {flash && <p className={'counter-flash ' + flash.tone} role="status">{flash.text}</p>}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Chips na lista <span className="count">{draft.items.length}</span></h2>
          {draft.items.length > 0 && <button type="button" className="small-btn" disabled={busy}
            onClick={() => { setDraft((previous) => ({ ...previous, items: [] })); setProblems([]); focusScanner() }}>Limpar lista</button>}
        </div>
        {draft.items.length === 0 && <p className="empty-state">Nenhum chip bipado ainda.</p>}
        <ol className="counter-list">{draft.items.map((item) => <li key={item.iccid}>
          <span className="mono">{item.iccid}</span>
          <span className="row-actions">
            {problemOf.has(item.iccid) ? <span className="badge badge-danger">{problemOf.get(item.iccid)}</span>
              : item.status && <span className="muted small-text">{item.status}</span>}
            <button type="button" className="small-btn" aria-label={'Remover ' + item.iccid} disabled={busy}
              onClick={() => { setDraft((previous) => ({ ...previous, items: previous.items.filter((entry) => entry.iccid !== item.iccid) })); focusScanner() }}>
              <Icon name="close" /></button>
          </span>
        </li>)}</ol>
        {problems.filter((problem) => !draft.items.some((item) => item.iccid === problem.iccid)).map((problem) =>
          <p key={problem.iccid} className="alert small-text"><span className="mono">{problem.iccid}</span> · {problem.reason}</p>)}
        {draft.items.length > 0 && <div className="sim-confirm">
          <label>Observação <span className="muted">(opcional)</span>
            <input value={draft.notes} maxLength={500} onChange={(event) => setDraft((previous) => ({ ...previous, notes: event.target.value }))} />
          </label>
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Registrando…' : `${kindText[draft.kind].verb}: ${draft.items.length} chip${draft.items.length > 1 ? 's' : ''} ${draft.kind === 'DELIVERY' ? 'para' : 'de'} ${technician.name}`}
          </button>
        </div>}
        <p className="muted small-text">Registrado por {clerkName}. Se algum chip não puder ser movimentado, nada é registrado e o item aparece marcado.</p>
      </section>
    </>}
  </div>
}

// ---------------------------------------------------------------------------
// Comprovante
// ---------------------------------------------------------------------------

function voucherText(detail: TransferDetail): string {
  const { transfer, items } = detail
  const lines = [
    `*Comprovante de ${transfer.kind === 'DELIVERY' ? 'entrega' : 'devolução'} de chips · New Life*`,
    `${transferName(transfer)} · ${transfer.location_name}`,
    `Técnico: ${transfer.technician_name}`,
    `${transfer.kind === 'DELIVERY' ? 'Entregue' : 'Recebido'} por: ${transfer.clerk_name}`,
    `Data: ${dateTime.format(new Date(transfer.created_at))}`,
    `Quantidade: ${transfer.total} chip${transfer.total > 1 ? 's' : ''}`,
    '', '*ICCIDs*',
    ...items.map((item, index) => `${index + 1}. ${item.iccid}`),
  ]
  if (transfer.notes) lines.push('', 'Observação: ' + transfer.notes)
  lines.push('', 'Registro ' + transfer.id)
  return lines.join('\n')
}

export function TransferVoucher({ detail }: { detail: TransferDetail }) {
  const { transfer, items } = detail
  const [copied, setCopied] = useState(false)
  const text = voucherText(detail)
  const phone = transfer.technician_whatsapp
  const link = phone && 'https://web.whatsapp.com/send?phone=' + phone + '&text=' + encodeURIComponent(text)
  return <section className="card voucher">
    <div className="section-head">
      {phone
        ? <p className="muted">Envie o comprovante para o WhatsApp de {transfer.technician_name} ({formatWhatsapp(phone)}).</p>
        : <p className="muted">{transfer.technician_name} não tem WhatsApp cadastrado. Peça ao administrador para cadastrar o número em Usuários ou copie o texto.</p>}
      <div className="actions">
        {link && <a className="whatsapp-btn" href={link} target="_blank" rel="noopener noreferrer">Enviar pelo WhatsApp</a>}
        <button type="button" className={link ? 'small-btn' : 'primary'} onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))
        }}>{copied ? 'Texto copiado' : 'Copiar texto'}</button>
      </div>
    </div>
    <div className="receipt-print">
      <header className="voucher-head">
        <img src="/icons/new-life-logo.png" alt="New Life" />
        <div><h1>Comprovante de {transfer.kind === 'DELIVERY' ? 'entrega' : 'devolução'} de chips</h1><p>{transferName(transfer)}</p></div>
      </header>
      <dl className="voucher-facts">
        <div><dt>Técnico</dt><dd>{transfer.technician_name}</dd></div>
        <div><dt>{transfer.kind === 'DELIVERY' ? 'Entregue por' : 'Recebido por'}</dt><dd>{transfer.clerk_name} · {transfer.location_name}</dd></div>
        <div><dt>Data</dt><dd>{dateTime.format(new Date(transfer.created_at))}</dd></div>
        <div><dt>Quantidade</dt><dd>{transfer.total}</dd></div>
      </dl>
      <table className="voucher-table"><thead><tr><th>#</th><th>ICCID</th><th>Status na operadora</th></tr></thead>
        <tbody>{items.map((item, index) => <tr key={item.iccid}>
          <td>{index + 1}</td><td className="mono">{item.iccid}</td><td>{item.operator_status ?? '—'}</td>
        </tr>)}</tbody></table>
      {transfer.notes && <p><strong>Observação:</strong> {transfer.notes}</p>}
      <p className="muted small-text">Registro {transfer.id}</p>
    </div>
  </section>
}

// ---------------------------------------------------------------------------
// Estoque de chips e importação
// ---------------------------------------------------------------------------

type Holder = 'all' | 'stock' | 'technicians'
type CardPage = Page<Card> & { totals: { stock: number; with_technicians: number } }

export function SimStock({ owner, city, denied }: { owner: string; city: City; denied: () => void }) {
  const [tab, setTab] = useState<'list' | 'technicians' | 'import'>('list')
  const [technician, setTechnician] = useState<TechnicianSims>()
  return <div className="module-container">
    <div className="section-head">
      <div><h1>Estoque de chips</h1><p>Chips da MVNO em {city.name}: no estoque e com os técnicos.</p></div>
    </div>
    <nav aria-label="Estoque de chips" className="tabs">
      <button aria-current={tab === 'list' ? 'page' : undefined} onClick={() => { setTechnician(undefined); setTab('list') }}>Chips</button>
      <button aria-current={tab === 'technicians' ? 'page' : undefined} onClick={() => setTab('technicians')}>Por técnico</button>
      <button aria-current={tab === 'import' ? 'page' : undefined} onClick={() => setTab('import')}>Importar planilha</button>
    </nav>
    {tab === 'list' && <CardList key={technician?.id ?? 'all'} owner={owner} denied={denied} technician={technician}
      clear={() => setTechnician(undefined)} />}
    {tab === 'technicians' && <TechnicianChips owner={owner} denied={denied} city={city}
      open={(item) => { setTechnician(item); setTab('list') }} />}
    {tab === 'import' && <SimImport owner={owner} denied={denied} city={city} />}
  </div>
}

function CardList({ owner, denied, technician, clear }: {
  owner: string; denied: () => void; technician?: TechnicianSims; clear: () => void
}) {
  const [holder, setHolder] = useState<Holder>(technician ? 'technicians' : 'all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState<CardPage>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<Extract<Lookup, { result: 'FOUND' }>>()

  const load = useCallback(async (after?: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ holder, limit: '100' })
      if (search.trim()) params.set('search', search.trim())
      if (technician) params.set('technician_id', technician.id)
      if (after) params.set('after', after)
      const data = await warehouse<CardPage>(owner, '/sims?' + params)
      setPage((previous) => after && previous ? { ...data, items: [...previous.items, ...data.items] } : data)
      setError('')
    } catch (failed) {
      setError(failure(failed, denied))
    } finally {
      setLoading(false)
    }
  }, [denied, holder, owner, search, technician])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [load])

  async function open(card: Card) {
    try {
      const data = await warehouse<Lookup>(owner, '/sims/lookup?code=' + card.iccid)
      if (data.result === 'FOUND') setDetail(data)
    } catch (failed) {
      setError(failure(failed, denied))
    }
  }

  return <section className="work-list">
    {page && <div className="diagnostic-summary-grid">
      <div className="card summary-box"><span className="muted">No estoque</span><strong>{page.totals.stock}</strong></div>
      <div className="card summary-box"><span className="muted">Com técnicos</span><strong>{page.totals.with_technicians}</strong></div>
    </div>}
    <div className="section-head">
      {technician ? <div><h2>Chips com {technician.name}</h2><button className="small-btn" onClick={clear}>← Todos os chips</button></div>
        : <nav className="tabs" aria-label="Filtro">
          {([['all', 'Todos'], ['stock', 'No estoque'], ['technicians', 'Com técnicos']] as [Holder, string][]).map(([id, label]) =>
            <button key={id} aria-current={holder === id ? 'page' : undefined} onClick={() => setHolder(id)}>{label}</button>)}
        </nav>}
      <input type="search" inputMode="numeric" placeholder="Buscar ICCID" value={search} maxLength={24}
        onChange={(event) => setSearch(event.target.value)} aria-label="Buscar ICCID" />
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="card table-card">
      <table className="data-table">
        <thead><tr><th>ICCID</th><th>Com quem está</th><th>Status na operadora</th><th>Assinante</th><th>Desde</th></tr></thead>
        <tbody>
          {page?.items.map((card) => <tr key={card.id} onClick={() => void open(card)} style={{ cursor: 'pointer' }}>
            <td className="mono">{card.iccid}</td>
            <td><span className={'badge ' + (card.technician_id ? 'badge-info' : 'badge-success')}>{holderText(card)}</span></td>
            <td>{card.operator_status ?? '—'}</td>
            <td>{card.subscriber ?? '—'}</td>
            <td className="muted">{dateTime.format(new Date(card.since))}</td>
          </tr>)}
          {page?.items.length === 0 && <tr><td colSpan={5} className="empty-cell">Nenhum chip encontrado. Importe a planilha da operadora.</td></tr>}
        </tbody>
      </table>
    </div>
    {loading && <p className="muted" role="status">Consultando…</p>}
    {page?.next_cursor && <button disabled={loading} onClick={() => void load(page.next_cursor!)}>Carregar mais chips</button>}
    {detail && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sim-detail-title" onClick={() => setDetail(undefined)}>
      <div className="modal-panel card" onClick={(event) => event.stopPropagation()}>
        <div className="section-head"><h2 id="sim-detail-title" className="mono">{detail.card.iccid}</h2>
          <button className="small-btn" onClick={() => setDetail(undefined)}><Icon name="close" /> Fechar</button></div>
        <SimFacts lookup={detail} />
      </div>
    </div>}
  </section>
}

function SimFacts({ lookup }: { lookup: Extract<Lookup, { result: 'FOUND' }> }) {
  const { card, history } = lookup
  return <>
    <dl className="voucher-facts">
      <div><dt>Com quem está</dt><dd>{holderText(card)}</dd></div>
      <div><dt>Cidade</dt><dd>{card.holder_location_name ?? '—'}</dd></div>
      <div><dt>Status na operadora</dt><dd>{card.operator_status ?? '—'}</dd></div>
      <div><dt>Assinante</dt><dd>{card.subscriber ?? '—'}</dd></div>
      <div><dt>Rede</dt><dd>{card.carrier ?? '—'}</dd></div>
      <div><dt>Desde</dt><dd>{dateTime.format(new Date(card.since))}</dd></div>
    </dl>
    <h3>Histórico</h3>
    <ol className="timeline">{history.map((entry, index) => <li key={index}>
      <strong>{movementLabel[entry.type]}</strong> · {entry.holder}
      <span className="muted small-text"> · {dateTime.format(new Date(entry.at))} · por {entry.actor}
        {entry.transfer_number !== null && ' · nº ' + String(entry.transfer_number).padStart(4, '0')}</span>
    </li>)}</ol>
  </>
}

function TechnicianChips({ owner, denied, city, open }: {
  owner: string; denied: () => void; city: City; open: (technician: TechnicianSims) => void
}) {
  const [items, setItems] = useState<TechnicianSims[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    warehouse<{ items: TechnicianSims[] }>(owner, '/sims/technicians')
      .then((data) => setItems(data.items), (failed) => setError(failure(failed, denied)))
  }, [denied, owner])
  return <section className="work-list">
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="card table-card">
      <table className="data-table">
        <thead><tr><th>Técnico</th><th className="num">Chips em posse</th><th>Última entrega</th><th /></tr></thead>
        <tbody>
          {items?.map((item) => <tr key={item.id} className={item.active ? '' : 'inactive'}>
            <td><strong>{item.name}</strong> <span className="muted mono">{item.login}</span></td>
            <td className="num">{item.sims}</td>
            <td className="muted">{item.last_delivery_at ? dateTime.format(new Date(item.last_delivery_at)) : '—'}</td>
            <td className="num"><button className="small-btn" disabled={item.sims === 0} onClick={() => open(item)}>Ver chips</button></td>
          </tr>)}
          {items?.length === 0 && <tr><td colSpan={4} className="empty-cell">Nenhum técnico em {city.name}.</td></tr>}
        </tbody>
      </table>
    </div>
  </section>
}

type ImportSummary = {
  import_id: string; dry_run: boolean; file_name: string; location_name: string
  total_rows: number; created: number; updated: number; unchanged: number
  invalid: { row: number; value: string; reason: string }[]
  other_location_count: number; other_location: { iccid: string; holder: string }[]
  status_changes: { iccid: string; from: string | null; to: string | null }[]
}
type ImportEntry = { id: string; file_name: string; actor_name: string; location_name: string; summary: ImportSummary; created_at: string }

function SimImport({ owner, denied, city }: { owner: string; denied: () => void; city: City }) {
  const [sheet, setSheet] = useState<SimSheet & { fileName: string; key: string }>()
  const [preview, setPreview] = useState<ImportSummary>()
  const [result, setResult] = useState<ImportSummary>()
  const [history, setHistory] = useState<ImportEntry[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await warehouse<{ items: ImportEntry[] }>(owner, '/sims/imports')).items)
    } catch (failed) {
      setError(failure(failed, denied))
    }
  }, [denied, owner])
  useEffect(() => { void loadHistory() }, [loadHistory])

  async function send(target: NonNullable<typeof sheet>, dryRun: boolean) {
    return warehouse<ImportSummary>(owner, '/sims/imports', jsonPost({
      client_import_id: target.key, file_name: target.fileName, dry_run: dryRun, rows: target.rows,
    }))
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setPreview(undefined)
    setResult(undefined)
    setSheet(undefined)
    setBusy(true)
    try {
      let parsed: SimSheet
      try {
        parsed = await readSimSheet(file)
      } catch (failed) {
        setError(sheetErrorMessage(failed))
        return
      }
      if (parsed.rows.length > 5000) {
        setError('A planilha tem ' + parsed.rows.length + ' chips. Divida em arquivos de até 5000.')
        return
      }
      const target = { ...parsed, fileName: file.name.slice(0, 255), key: crypto.randomUUID() }
      setSheet(target)
      setPreview(await send(target, true))
    } catch (failed) {
      setError(failure(failed, denied))
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (!sheet || busy) return
    setBusy(true)
    setError('')
    try {
      setResult(await send(sheet, false))
      setPreview(undefined)
      setSheet(undefined)
      void loadHistory()
    } catch (failed) {
      setError(failure(failed, denied))
    } finally {
      setBusy(false)
    }
  }

  const shown = result ?? preview
  return <section className="work-list">
    <section className="card task-panel">
      <h2>Importar planilha da operadora</h2>
      <p className="muted">Envie o .xlsx exportado do portal da MVNO. Chips novos entram no estoque de <strong>{city.name}</strong>.
        Chips já cadastrados só têm status, assinante e rede atualizados; a custódia não muda.</p>
      <label className="primary file-btn">
        {busy ? 'Lendo planilha…' : 'Escolher planilha .xlsx'}
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => void choose(event)} disabled={busy} hidden />
      </label>
      {error && <p className="alert" role="alert">{error}</p>}
      {sheet && sheet.numericIccids.length > 0 && <p className="alert">
        {sheet.numericIccids.length} linha{sheet.numericIccids.length > 1 ? 's têm' : ' tem'} ICCID salvo como número e perdeu dígitos
        (ex.: linha {sheet.numericIccids[0]}). Formate a coluna como texto na origem e exporte de novo.</p>}
    </section>

    {shown && <section className="card">
      <div className="section-head">
        <div><h2>{result ? 'Importação concluída' : 'Conferência antes de importar'}</h2>
          <p className="muted">{shown.file_name} · {shown.total_rows} linha{shown.total_rows > 1 ? 's' : ''}
            {sheet?.columns.iccid && <> · coluna do ICCID: “{sheet.columns.iccid}”</>}</p></div>
        {!result && <button className="primary" disabled={busy || (shown.created + shown.updated === 0)} onClick={() => void commit()}>
          {busy ? 'Importando…' : `Importar para ${city.name}`}</button>}
      </div>
      <div className="diagnostic-summary-grid">
        <div className="card summary-box"><span className="muted">Novos no estoque</span><strong>{shown.created}</strong></div>
        <div className="card summary-box"><span className="muted">Dados atualizados</span><strong>{shown.updated}</strong></div>
        <div className="card summary-box"><span className="muted">Sem mudança</span><strong>{shown.unchanged}</strong></div>
        <div className="card summary-box"><span className="muted">Linhas recusadas</span><strong>{shown.invalid.length}</strong></div>
      </div>
      {shown.status_changes.length > 0 && <>
        <h3>Mudanças de status na operadora</h3>
        <ul className="counter-list">{shown.status_changes.map((change) => <li key={change.iccid}>
          <span className="mono">{change.iccid}</span><span>{change.from ?? '—'} → <strong>{change.to ?? '—'}</strong></span></li>)}</ul>
      </>}
      {shown.other_location_count > 0 && <>
        <h3>Já cadastrados fora de {city.name} ({shown.other_location_count})</h3>
        <p className="muted small-text">Continuam onde estão. Apenas os dados da operadora são atualizados.</p>
        <ul className="counter-list">{shown.other_location.map((item) => <li key={item.iccid}>
          <span className="mono">{item.iccid}</span><span>{item.holder}</span></li>)}</ul>
      </>}
      {shown.invalid.length > 0 && <>
        <h3>Linhas recusadas</h3>
        <table className="data-table"><thead><tr><th>Linha</th><th>Valor</th><th>Motivo</th></tr></thead>
          <tbody>{shown.invalid.map((item) => <tr key={item.row}><td>{item.row}</td><td className="mono">{item.value}</td><td>{item.reason}</td></tr>)}</tbody></table>
      </>}
    </section>}

    <section className="card">
      <h2>Importações anteriores em {city.name}</h2>
      {history?.length === 0 && <p className="empty-state">Nenhuma planilha importada ainda.</p>}
      {history && history.length > 0 && <table className="data-table">
        <thead><tr><th>Data</th><th>Arquivo</th><th>Por</th><th className="num">Novos</th><th className="num">Atualizados</th></tr></thead>
        <tbody>{history.map((entry) => <tr key={entry.id}>
          <td>{dateTime.format(new Date(entry.created_at))}</td><td>{entry.file_name}</td><td>{entry.actor_name}</td>
          <td className="num">{entry.summary.created}</td><td className="num">{entry.summary.updated}</td>
        </tr>)}</tbody></table>}
    </section>
  </section>
}

// ---------------------------------------------------------------------------
// Histórico de entregas e devoluções
// ---------------------------------------------------------------------------

export function SimHistory({ owner, city, denied }: { owner: string; city: City; denied: () => void }) {
  const [page, setPage] = useState<Page<TransferSummary>>()
  const [opened, setOpened] = useState<TransferDetail>()
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (after?: string) => {
    setLoading(true)
    try {
      const data = await warehouse<Page<TransferSummary>>(owner, '/sims/transfers?limit=50' + (after ? '&after=' + after : ''))
      setPage((previous) => after && previous ? { ...data, items: [...previous.items, ...data.items] } : data)
      setError('')
    } catch (failed) {
      setError(failure(failed, denied))
    } finally {
      setLoading(false)
    }
  }, [denied, owner])
  useEffect(() => { void load() }, [load])

  async function open(id: string) {
    try {
      setOpened(await warehouse<TransferDetail>(owner, '/sims/transfers/' + id))
    } catch (failed) {
      setError(failure(failed, denied))
    }
  }

  const term = filter.trim().toLowerCase()
  const items = useMemo(() => (page?.items ?? []).filter((item) => !term
    || item.technician_name.toLowerCase().includes(term) || String(item.number).includes(term)), [page, term])

  if (opened) {
    return <div className="module-container">
      <div className="section-head"><button className="small-btn" onClick={() => setOpened(undefined)}>← Voltar ao histórico</button></div>
      <TransferVoucher detail={opened} />
    </div>
  }

  return <div className="module-container">
    <div className="section-head">
      <div><h1>Entregas de chips</h1><p>Entregas e devoluções registradas em {city.name}, com comprovante para o WhatsApp.</p></div>
      <input type="search" placeholder="Técnico ou número" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filtrar" />
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="card table-card">
      <table className="data-table">
        <thead><tr><th>Registro</th><th>Técnico</th><th className="num">Chips</th><th>Data</th><th>Por</th><th /></tr></thead>
        <tbody>
          {items.map((item) => <tr key={item.id}>
            <td><span className={'badge ' + kindText[item.kind].badge}>{transferName(item)}</span></td>
            <td><strong>{item.technician_name}</strong></td>
            <td className="num">{item.total}</td>
            <td>{dateTime.format(new Date(item.created_at))}</td>
            <td className="muted">{item.clerk_name}</td>
            <td className="num"><button className="small-btn" onClick={() => void open(item.id)}>Comprovante</button></td>
          </tr>)}
          {page && items.length === 0 && <tr><td colSpan={6} className="empty-cell">Nenhuma entrega registrada.</td></tr>}
        </tbody>
      </table>
    </div>
    {loading && <p className="muted" role="status">Consultando…</p>}
    {page?.next_cursor && <button disabled={loading} onClick={() => void load(page.next_cursor!)}>Carregar mais</button>}
  </div>
}

/** Consulta avulsa de um chip pelo ICCID (usada na busca global). */
export function SimLookup({ owner, denied, code }: { owner: string; denied: () => void; code: string }) {
  const [lookup, setLookup] = useState<Lookup>()
  const [error, setError] = useState('')
  useEffect(() => {
    warehouse<Lookup>(owner, '/sims/lookup?code=' + encodeURIComponent(code))
      .then(setLookup, (failed) => setError(failure(failed, denied)))
  }, [code, denied, owner])
  return <div className="module-container">
    <div className="section-head"><div><h1>Rastrear chip</h1><p className="mono">{code}</p></div></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {lookup?.result === 'FOUND' && <section className="card"><SimFacts lookup={lookup} /></section>}
    {lookup?.result === 'UNKNOWN' && <p className="alert">Chip não cadastrado. Importe a planilha da operadora.</p>}
    {lookup?.result === 'INVALID' && <p className="alert">{lookup.reason}</p>}
  </div>
}
