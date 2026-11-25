import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, warehouse } from '../api'
import { Icon } from '../components/icon'
import {
  batchName, batchStatus, dateTime, describe, itemState, jsonPost,
  type BatchDetail, type BatchSummary, type Page,
} from '../delivery'

function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'agora'
  if (minutes < 60) return 'há ' + minutes + ' min'
  const hours = Math.round(minutes / 60)
  return hours < 24 ? 'há ' + hours + ' h' : 'há ' + Math.round(hours / 24) + ' dias'
}

/** Abre (ou retoma) a conferência de um lote. A chave fica estável entre tentativas. */
export function useReceive(owner: string, opened: (session: string) => void, fail: (failure: unknown) => void) {
  const keys = useRef(new Map<string, string>())
  const [busy, setBusy] = useState<string>()
  const receive = useCallback(async (batch: string) => {
    if (!keys.current.has(batch)) keys.current.set(batch, crypto.randomUUID())
    setBusy(batch)
    try {
      const result = await warehouse<{ receipt_session_id: string }>(owner, '/warehouse/batches/' + batch + '/receive',
        jsonPost({ client_session_id: keys.current.get(batch) }))
      keys.current.delete(batch)
      opened(result.receipt_session_id)
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(undefined)
    }
  }, [fail, opened, owner])
  return { receive, busy }
}

/** Lotes enviados pelos técnicos e ainda não encerrados. Ponto de partida do balcão. */
export function BatchQueue({ owner, denied, opened }: {
  owner: string; denied: () => void; opened: (session: string) => void
}) {
  const [page, setPage] = useState<Page<BatchSummary>>()
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<BatchDetail>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) denied()
    setError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Tente novamente.')
  }, [denied])
  const { receive, busy } = useReceive(owner, opened, fail)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPage(await warehouse<Page<BatchSummary>>(owner, '/warehouse/batches?status=open&limit=100'))
      setError('')
    } catch (failure) {
      fail(failure)
    } finally {
      setLoading(false)
    }
  }, [fail, owner])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const term = filter.trim().toLowerCase()
  const items = (page?.items ?? [])
    .filter((batch) => !term || batch.technician_name.toLowerCase().includes(term)
      || String(batch.number).includes(term.replace(/\D/g, '') || '\u0000'))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
  const receiving = items.filter((batch) => batch.status === 'RECEIVING')
  const waiting = items.filter((batch) => batch.status === 'SUBMITTED')

  async function show(id: string) {
    try {
      setPreview(await warehouse<BatchDetail>(owner, '/warehouse/batches/' + id))
    } catch (failure) {
      fail(failure)
    }
  }

  const card = (batch: BatchSummary) => <li key={batch.id} className="batch-card">
    <div className="batch-card-main">
      <div className="batch-card-title">
        <strong>{batchName(batch)}</strong>
        <span className={'badge ' + batchStatus[batch.status].tone}>{batchStatus[batch.status].label}</span>
      </div>
      <p className="batch-card-tech">{batch.technician_name}</p>
      <p className="muted small-text">
        {batch.total} equipamento{batch.total === 1 ? '' : 's'}
        {batch.unidentified > 0 && <> · <span className="text-purple">{batch.unidentified} para identificar pela foto</span></>}
        {' · enviado '}{age(batch.created_at)}
      </p>
      {batch.status === 'RECEIVING' && <p className="muted small-text">
        {batch.received} de {batch.total} recebidos{batch.clerk_name ? ' · ' + batch.clerk_name : ''}</p>}
      {batch.notes && <p className="muted small-text">“{batch.notes}”</p>}
    </div>
    <div className="batch-card-actions">
      <button type="button" className="small-btn" onClick={() => void show(batch.id)}>Ver itens</button>
      <button type="button" className="primary" disabled={busy === batch.id} onClick={() => void receive(batch.id)}>
        {batch.status === 'RECEIVING' ? 'Continuar' : 'Conferir'} <Icon name="next" />
      </button>
    </div>
  </li>

  return <div className="module-container">
    <div className="section-head">
      <div>
        <h1>Lotes para conferir</h1>
        <p className="muted">O técnico chega com a pilha e informa o número do lote. Abra o lote e bipe cada equipamento.</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading}><Icon name="sync" /> Atualizar</button>
    </div>
    <label className="queue-filter">
      <Icon name="search" />
      <input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)}
        placeholder="Número do lote ou nome do técnico" aria-label="Filtrar lotes" />
    </label>
    {error && <p className="alert" role="alert">{error}</p>}
    {page && items.length === 0 && <div className="card empty-state">
      {term ? 'Nenhum lote aberto corresponde à busca.' : 'Nenhum lote aguardando. Quando um técnico montar um lote no celular, ele aparece aqui.'}
    </div>}
    {receiving.length > 0 && <section>
      <h2 className="queue-group">Em conferência</h2>
      <ul className="batch-grid">{receiving.map(card)}</ul>
    </section>}
    {waiting.length > 0 && <section>
      <h2 className="queue-group">Aguardando ({waiting.length})</h2>
      <ul className="batch-grid">{waiting.map(card)}</ul>
    </section>}
    {preview && <BatchPreview detail={preview} close={() => setPreview(undefined)}
      receive={preview.batch.status === 'SUBMITTED' || preview.batch.status === 'RECEIVING'
        ? () => void receive(preview.batch.id) : undefined} />}
  </div>
}

export function BatchPreview({ detail, close, receive }: { detail: BatchDetail; close: () => void; receive?: () => void }) {
  const { batch, items } = detail
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="batch-preview-title"
    onClick={(event) => { if (event.target === event.currentTarget) close() }}
    onKeyDown={(event) => { if (event.key === 'Escape') close() }}>
    <section className="card modal-panel">
      <div className="section-head">
        <div>
          <h2 id="batch-preview-title">{batchName(batch)} · {batch.technician_name}</h2>
          <p className="muted">{batchStatus[batch.status].label} · enviado em {dateTime.format(new Date(batch.created_at))}
            {batch.finished_at && ' · encerrado em ' + dateTime.format(new Date(batch.finished_at))}</p>
        </div>
        <button type="button" className="small-btn" onClick={close} autoFocus>Fechar</button>
      </div>
      {batch.notes && <p className="muted">“{batch.notes}”</p>}
      <ul className="counter-list">{items.map((item) => {
        const state = itemState(item, batch.status)
        const info = describe(item)
        return <li key={item.capture_id}>
          <span className={'mono' + (info.verified ? '' : ' muted')}>{info.text}</span>
          <span className={'badge ' + state.tone}>{state.label}</span>
        </li>
      })}</ul>
      {receive && <button type="button" className="primary" onClick={receive}>
        {batch.status === 'RECEIVING' ? 'Continuar conferência' : 'Conferir este lote'}</button>}
    </section>
  </div>
}
