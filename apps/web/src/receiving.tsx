import { useCallback, useEffect, useState } from 'react'
import { ApiError, warehouse } from './api'
import { batchName, dateTime, type Page } from './delivery'

type Session = {
  id: string; technician_name: string; warehouse_name: string; opened_at: string
  closed_at: string | null; batch_number: number | null
}
type Trace = { result: string; history?: { type: string; at: string; holder: string }[] }

const outcomes: Record<string, string> = {
  MATCHED: 'Equipamento localizado.',
  UNKNOWN: 'Código não cadastrado.',
  AMBIGUOUS: 'Código associado a mais de um equipamento. Use outro código da etiqueta.',
}

/** Conferências feitas por este estoquista, com acesso ao comprovante. */
export function SessionHistory({ owner, denied, opened }: {
  owner: string; denied: () => void; opened: (session: string) => void
}) {
  const [page, setPage] = useState<Page<Session>>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (after?: string) => {
    setLoading(true)
    try {
      const next = await warehouse<Page<Session>>(owner, '/receipt-sessions?limit=50' + (after ? '&after=' + after : ''))
      setPage((previous) => after && previous ? { ...next, items: [...previous.items, ...next.items] } : next)
      setError('')
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) denied()
      setError(failure instanceof ApiError ? failure.message : 'Não foi possível carregar as conferências.')
    } finally {
      setLoading(false)
    }
  }, [denied, owner])

  useEffect(() => { void load() }, [load])

  return <div className="module-container">
    <div className="section-head">
      <div><h1>Comprovantes</h1><p className="muted">Conferências que você abriu, com o comprovante de cada entrega.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading}>Atualizar</button>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    <section className="card table-card">
      <table className="data-table">
        <thead><tr><th>Lote</th><th>Técnico</th><th>Início</th><th>Situação</th><th /></tr></thead>
        <tbody>
          {page?.items.map((session) => <tr key={session.id}>
            <td><strong>{session.batch_number ? batchName({ number: session.batch_number }) : 'Avulso'}</strong></td>
            <td>{session.technician_name}</td>
            <td>{dateTime.format(new Date(session.opened_at))}</td>
            <td>{session.closed_at
              ? <span className="badge badge-success">Encerrada {dateTime.format(new Date(session.closed_at))}</span>
              : <span className="badge badge-warning">Em conferência</span>}</td>
            <td><button type="button" className="small-btn" onClick={() => opened(session.id)}>
              {session.closed_at ? 'Comprovante' : 'Continuar'}</button></td>
          </tr>)}
          {page?.items.length === 0 && <tr><td colSpan={5} className="empty-cell">Nenhuma conferência registrada.</td></tr>}
        </tbody>
      </table>
    </section>
    {page?.next_cursor && <button type="button" disabled={loading} onClick={() => void load(page.next_cursor!)}>Mais conferências</button>}
  </div>
}

/** Histórico de custódia de qualquer equipamento, por serial ou MAC. */
export function EquipmentSearch({ owner, denied, initialCode }: {
  owner: string; denied: () => void; initialCode?: string
}) {
  const [code, setCode] = useState(initialCode ?? '')
  const [query, setQuery] = useState(initialCode ? { value: initialCode } : undefined)
  const [result, setResult] = useState<Trace>()
  const [busy, setBusy] = useState(Boolean(initialCode))
  const [error, setError] = useState('')
  useEffect(() => {
    if (!query) return
    let cancelled = false
    void warehouse<Trace>(owner, '/warehouse/equipment/lookup?value=' + encodeURIComponent(query.value))
      .then(data => { if (!cancelled) setResult(data) })
      .catch(failure => {
        if (cancelled) return
        if (failure instanceof ApiError && failure.status === 401) denied()
        setError(failure instanceof ApiError ? failure.message : 'Não foi possível consultar o equipamento. Tente novamente.')
      })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [denied, owner, query])

  return <div className="module-container">
    <h1>Rastrear equipamento</h1>
    <section className="card">
      <form className="receipt-form" onSubmit={event => {
        event.preventDefault()
        if (busy || !code.trim()) return
        setBusy(true); setResult(undefined); setError('')
        setQuery({ value: code.trim() })
      }}>
        <label>Serial ou MAC<input value={code} onChange={event => setCode(event.target.value)} autoFocus={!initialCode}
          required maxLength={128} disabled={busy} className="mono" /></label>
        <button className="primary" disabled={busy}>{busy ? 'Consultando…' : 'Consultar'}</button>
      </form>
      {error && <p role="alert" className="alert">{error}</p>}
      {result && <p role="status">{outcomes[result.result] ?? 'Resultado indisponível.'}</p>}
      {!!result?.history?.length && <ol className="timeline">{result.history.map((movement, index) => <li key={index}>
        <strong>{movement.type === 'WAREHOUSE_RECEIVED' ? 'Recebido no estoque' : 'Recolhido em campo'}</strong> · {movement.holder}
        <br /><span className="muted small-text">{dateTime.format(new Date(movement.at))}</span>
      </li>)}</ol>}
    </section>
  </div>
}
