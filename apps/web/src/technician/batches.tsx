import { useCallback, useEffect, useState } from 'react'
import { ApiError, authenticated } from '../api'
import { Icon } from '../components/icon'
import {
  batchName, batchStatus, dateTime, describe, itemState, jsonPost,
  type BatchDetail, type BatchSummary, type Page,
} from '../delivery'

/** Lotes declarados pelo técnico e o resultado de cada conferência. */
export function BatchesTab({ owner, connected, deny, opened, open }: {
  owner: string
  connected: boolean
  deny: () => void
  opened?: BatchDetail
  open: (batch?: BatchDetail) => void
}) {
  const [page, setPage] = useState<Page<BatchSummary>>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) deny()
    setError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Tente novamente.')
  }, [deny])

  const load = useCallback(async (after?: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await authenticated<Page<BatchSummary>>(owner, '/me/batches?limit=30' + (after ? '&after=' + after : ''))
      setPage((previous) => after && previous ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (failure) {
      fail(failure)
    } finally {
      setLoading(false)
    }
  }, [fail, owner])

  useEffect(() => { if (connected && !opened) void load() }, [connected, load, opened])

  async function show(id: string) {
    setLoading(true)
    setError('')
    try {
      open(await authenticated<BatchDetail>(owner, '/me/batches/' + id))
    } catch (failure) {
      fail(failure)
    } finally {
      setLoading(false)
    }
  }

  if (opened) {
    return <BatchView owner={owner} detail={opened} fail={fail} error={error} back={() => open(undefined)}
      update={(detail) => open(detail)} reload={() => void show(opened.batch.id)} />
  }

  return <div className="tech-view">
    <header className="tech-view-head row">
      <div>
        <h1>Lotes</h1>
        <p className="muted">Cada lote é uma entrega no balcão.</p>
      </div>
      <button type="button" className="small-btn" onClick={() => void load()} disabled={loading || !connected}>
        <Icon name="sync" /> Atualizar
      </button>
    </header>
    {!connected && <p className="alert" role="status">Sem conexão. Conecte-se para consultar seus lotes.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {page?.items.length === 0 && <div className="empty-state">
      <p>Nenhum lote ainda. Em <strong>Comigo</strong>, selecione os equipamentos e toque em <strong>Montar lote</strong>.</p>
    </div>}
    <ul className="tech-batch-list">{page?.items.map((batch) => {
      const status = batchStatus[batch.status]
      return <li key={batch.id}>
        <button type="button" className="tech-batch-card" onClick={() => void show(batch.id)} disabled={loading}>
          <span className="tech-batch-top">
            <strong>{batchName(batch)}</strong>
            <span className={'badge ' + status.tone}>{status.label}</span>
          </span>
          <span className="muted">
            {batch.total} equipamento{batch.total === 1 ? '' : 's'} · {dateTime.format(new Date(batch.created_at))}
          </span>
          {(batch.status === 'RECEIVING' || batch.status === 'CLOSED') &&
            <span className="tech-progress"><progress value={batch.received} max={batch.total} />
              {batch.received} de {batch.total} recebidos</span>}
        </button>
      </li>
    })}</ul>
    {page?.next_cursor && <button type="button" disabled={loading} onClick={() => void load(page.next_cursor!)}>Mais lotes</button>}
  </div>
}

function BatchView({ owner, detail, fail, error, back, update, reload }: {
  owner: string
  detail: BatchDetail
  fail: (failure: unknown) => void
  error: string
  back: () => void
  update: (detail: BatchDetail) => void
  reload: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { batch, items } = detail
  const status = batchStatus[batch.status]
  const missing = items.filter((item) => !item.received_at).length

  async function cancel() {
    setBusy(true)
    try {
      update(await authenticated<BatchDetail>(owner, '/me/batches/' + batch.id + '/cancel', jsonPost()))
      setConfirming(false)
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  return <div className="tech-view">
    <header className="tech-view-head row">
      <button type="button" className="small-btn" onClick={back}>← Lotes</button>
      <button type="button" className="small-btn" onClick={reload}><Icon name="sync" /> Atualizar</button>
    </header>
    <section className="tech-batch-hero">
      {(batch.status === 'SUBMITTED' || batch.status === 'RECEIVING') && <span className="muted">Informe no balcão</span>}
      <strong className="tech-batch-number">{batchName(batch)}</strong>
      <span className={'badge ' + status.tone}>{status.label}</span>
      <dl className="tech-batch-facts">
        <div><dt>Itens</dt><dd>{batch.total}</dd></div>
        <div><dt>Recebidos</dt><dd>{batch.received}</dd></div>
        <div><dt>Enviado</dt><dd>{dateTime.format(new Date(batch.created_at))}</dd></div>
      </dl>
      {batch.clerk_name && <p className="muted">Conferido por {batch.clerk_name}</p>}
      {batch.notes && <p className="muted">“{batch.notes}”</p>}
    </section>
    {batch.status === 'CLOSED' && missing > 0 && <p className="alert">
      {missing} equipamento{missing > 1 ? 's' : ''} não {missing > 1 ? 'foram entregues' : 'foi entregue'}. {missing > 1 ? 'Eles continuam' : 'Ele continua'} com você e {missing > 1 ? 'aparecem' : 'aparece'} em <strong>Comigo</strong>.
    </p>}
    {error && <p className="alert" role="alert">{error}</p>}
    <ul className="tech-list">{items.map((item) => {
      const state = itemState(item, batch.status)
      const info = describe(item)
      return <li key={item.capture_id} className="tech-row">
        <span className={'mono' + (info.verified ? '' : ' muted')}>{info.text}</span>
        <span className="tech-pick-meta">
          <span className={'badge ' + state.tone}>{state.label}</span>
          {item.added_by_clerk && <span className="muted">incluído no balcão</span>}
        </span>
      </li>
    })}</ul>
    {batch.status === 'SUBMITTED' && (confirming
      ? <div className="tech-callout">
        <p>Cancelar o {batchName(batch)}? Os equipamentos voltam para <strong>Comigo</strong>.</p>
        <div className="tech-form-actions">
          <button type="button" className="danger-btn" disabled={busy} onClick={() => void cancel()}>Cancelar lote</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Manter</button>
        </div>
      </div>
      : <button type="button" onClick={() => setConfirming(true)}>Cancelar este lote</button>)}
  </div>
}
