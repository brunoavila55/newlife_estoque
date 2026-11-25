import { useCallback, useEffect, useState } from 'react'
import { ApiError, warehouse } from '../api'
import { Icon } from '../components/icon'
import {
  batchName, batchStatus, daysSince, dateTime, describe,
  type BatchDetail, type BatchSummary, type CustodyItem, type Page,
} from '../delivery'
import { BatchPreview, useReceive } from './batch_queue'

type Technician = {
  id: string; name: string; login: string; active: boolean
  in_custody: number; unidentified: number; open_batches: number; oldest_pending_at: string | null
}

const RETENTION_ALERT_DAYS = 7

/** Saldo de cada técnico: o que está em campo, o que está em lote e o histórico de entregas. */
export function TechniciansModule({ owner, denied, opened }: {
  owner: string; denied: () => void; opened: (session: string) => void
}) {
  const [rows, setRows] = useState<Technician[]>()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Technician>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) denied()
    setError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Tente novamente.')
  }, [denied])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows((await warehouse<{ items: Technician[] }>(owner, '/warehouse/technicians-summary')).items)
      setError('')
    } catch (failure) {
      fail(failure)
    } finally {
      setLoading(false)
    }
  }, [fail, owner])

  useEffect(() => { void load() }, [load])

  if (selected) {
    return <TechnicianStock owner={owner} technician={selected} fail={fail} error={error} opened={opened}
      back={() => { setSelected(undefined); setError(''); void load() }} />
  }

  const term = search.trim().toLowerCase()
  const visible = (rows ?? []).filter((row) => !term || row.name.toLowerCase().includes(term) || row.login.includes(term))
  const totals = visible.reduce((sum, row) => ({
    custody: sum.custody + row.in_custody + row.unidentified, batches: sum.batches + row.open_batches,
  }), { custody: 0, batches: 0 })

  return <div className="module-container">
    <div className="section-head">
      <div>
        <h1>Estoque por técnico</h1>
        <p className="muted">{totals.custody} equipamentos em campo · {totals.batches} lotes abertos</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading}><Icon name="sync" /> Atualizar</button>
    </div>
    <label className="queue-filter">
      <Icon name="search" />
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar técnico" aria-label="Buscar técnico" />
    </label>
    {error && <p className="alert" role="alert">{error}</p>}
    <section className="card table-card">
      <table className="data-table">
        <thead><tr>
          <th>Técnico</th><th className="num">Em posse</th><th className="num">Sem identificação</th>
          <th className="num">Lotes abertos</th><th>Mais antigo</th><th />
        </tr></thead>
        <tbody>
          {visible.map((row) => {
            const days = row.oldest_pending_at ? daysSince(row.oldest_pending_at) : null
            const held = row.in_custody + row.unidentified
            return <tr key={row.id} className={row.active ? '' : 'inactive'}>
              <td><strong>{row.name}</strong><br /><span className="muted small-text">{row.login}{row.active ? '' : ' · inativo'}</span></td>
              <td className="num">{row.in_custody}</td>
              <td className="num">{row.unidentified || '—'}</td>
              <td className="num">{row.open_batches ? <span className="badge badge-info">{row.open_batches}</span> : '—'}</td>
              <td>{days === null ? '—' : <span className={days >= RETENTION_ALERT_DAYS ? 'badge badge-danger' : 'muted'}>
                {days === 0 ? 'hoje' : days + (days === 1 ? ' dia' : ' dias')}</span>}</td>
              <td><button type="button" className="small-btn" onClick={() => setSelected(row)} disabled={!held && !row.open_batches && !row.active}>
                Abrir</button></td>
            </tr>
          })}
          {rows && visible.length === 0 && <tr><td colSpan={6} className="empty-cell">Nenhum técnico encontrado.</td></tr>}
        </tbody>
      </table>
    </section>
  </div>
}

function TechnicianStock({ owner, technician, fail, error, opened, back }: {
  owner: string; technician: Technician; fail: (failure: unknown) => void; error: string
  opened: (session: string) => void; back: () => void
}) {
  const [custody, setCustody] = useState<CustodyItem[]>()
  const [batches, setBatches] = useState<Page<BatchSummary>>()
  const [preview, setPreview] = useState<BatchDetail>()
  const { receive } = useReceive(owner, opened, fail)

  const loadBatches = useCallback(async (after?: string) => {
    const page = await warehouse<Page<BatchSummary>>(owner,
      '/warehouse/batches?limit=20&technician_id=' + technician.id + (after ? '&after=' + after : ''))
    setBatches((previous) => after && previous ? { ...page, items: [...previous.items, ...page.items] } : page)
  }, [owner, technician.id])

  useEffect(() => {
    void warehouse<{ items: CustodyItem[] }>(owner, '/warehouse/technicians/' + technician.id + '/custody')
      .then((page) => setCustody(page.items)).catch(fail)
    void loadBatches().catch(fail)
  }, [fail, loadBatches, owner, technician.id])

  async function show(id: string) {
    try { setPreview(await warehouse<BatchDetail>(owner, '/warehouse/batches/' + id)) } catch (failure) { fail(failure) }
  }

  const loose = custody?.filter((item) => !item.batch_id) ?? []
  const batched = custody?.filter((item) => item.batch_id) ?? []

  return <div className="module-container">
    <div className="section-head">
      <div>
        <button type="button" className="small-btn" onClick={back}>← Técnicos</button>
        <h1>{technician.name}</h1>
        <p className="muted">{custody ? custody.length : '…'} equipamentos sob responsabilidade · {technician.login}</p>
      </div>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="desk-grid">
      <section className="card">
        <h2>Em campo, fora de lote <span className="count">{loose.length}</span></h2>
        <p className="muted small-text">Recolhidos e ainda não colocados em um lote pelo técnico.</p>
        {custody && loose.length === 0 && <p className="empty-state">Nada fora de lote.</p>}
        <ul className="counter-list">{loose.map((item) => {
          const info = describe(item)
          return <li key={item.capture_id}>
            <span className={'mono' + (info.verified ? '' : ' muted')}>{info.text}</span>
            <span className="muted small-text">coletado {dateTime.format(new Date(item.captured_at))} · {daysSince(item.captured_at)} d</span>
          </li>
        })}</ul>
        {batched.length > 0 && <p className="muted small-text">+ {batched.length} em lotes abertos</p>}
      </section>
      <section className="card">
        <h2>Lotes</h2>
        {batches?.items.length === 0 && <p className="empty-state">Nenhum lote enviado.</p>}
        <ul className="counter-list">{batches?.items.map((batch) => <li key={batch.id}>
          <span><strong>{batchName(batch)}</strong> <span className={'badge ' + batchStatus[batch.status].tone}>{batchStatus[batch.status].label}</span><br />
            <span className="muted small-text">{dateTime.format(new Date(batch.created_at))} · {batch.received}/{batch.total} recebidos</span></span>
          <span className="row-actions">
            <button type="button" className="small-btn" onClick={() => void show(batch.id)}>Itens</button>
            {(batch.status === 'SUBMITTED' || batch.status === 'RECEIVING') &&
              <button type="button" className="small-btn primary" onClick={() => void receive(batch.id)}>Conferir</button>}
            {batch.status === 'CLOSED' && batch.receipt_session_id &&
              <button type="button" className="small-btn" onClick={() => opened(batch.receipt_session_id!)}>Comprovante</button>}
          </span>
        </li>)}</ul>
        {batches?.next_cursor && <button type="button" onClick={() => void loadBatches(batches.next_cursor!).catch(fail)}>Mais lotes</button>}
      </section>
    </div>
    {preview && <BatchPreview detail={preview} close={() => setPreview(undefined)}
      receive={preview.batch.status === 'SUBMITTED' || preview.batch.status === 'RECEIVING'
        ? () => void receive(preview.batch.id) : undefined} />}
  </div>
}
