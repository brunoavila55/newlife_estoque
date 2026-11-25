import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, authenticated } from '../api'
import { Icon } from '../components/icon'
import {
  batchName, dateTime, describe, jsonPost, type BatchDetail, type CustodyItem,
} from '../delivery'

const captureStatus: Record<string, { label: string; tone: string }> = {
  IDENTIFIED: { label: 'Identificado', tone: 'badge-success' },
  NEEDS_REVIEW: { label: 'Identificar no balcão', tone: 'badge-purple' },
  OCR_FAILED: { label: 'Identificar no balcão', tone: 'badge-purple' },
  OCR_PENDING: { label: 'Lendo etiqueta', tone: 'badge-muted' },
  OCR_PROCESSING: { label: 'Lendo etiqueta', tone: 'badge-muted' },
  RECEIVED: { label: 'Lendo etiqueta', tone: 'badge-muted' },
}

/** Tudo o que está sob responsabilidade do técnico, com a montagem do lote de entrega. */
export function HoldingsTab({ owner, connected, localPending, deny, sync, syncing, created }: {
  owner: string
  connected: boolean
  localPending: number
  deny: () => void
  sync: () => void
  syncing: boolean
  created: (batch: BatchDetail) => void
}) {
  const [items, setItems] = useState<CustodyItem[]>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ key: string; client_batch_id: string }>(undefined)

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) deny()
    setError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Tente novamente.')
  }, [deny])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const page = await authenticated<{ items: CustodyItem[] }>(owner, '/me/custody')
      setItems(page.items)
      setSelected((previous) => new Set(page.items
        .filter((item) => !item.batch_id && previous.has(item.capture_id)).map((item) => item.capture_id)))
    } catch (failure) {
      fail(failure)
    } finally {
      setLoading(false)
    }
  }, [fail, owner])

  useEffect(() => { if (connected) void load() }, [connected, load, localPending])

  const free = items?.filter((item) => !item.batch_id) ?? []
  const inBatch = items?.filter((item) => item.batch_id) ?? []

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit() {
    if (!selected.size || loading) return
    const ids = [...selected].sort()
    const key = ids.join(',') + '|' + notes.trim()
    if (pending.current?.key !== key) pending.current = { key, client_batch_id: crypto.randomUUID() }
    setLoading(true)
    setError('')
    try {
      const batch = await authenticated<BatchDetail>(owner, '/me/batches', jsonPost({
        client_batch_id: pending.current.client_batch_id, capture_ids: ids, notes: notes.trim() || null,
      }))
      pending.current = undefined
      setSelected(new Set())
      setComposing(false)
      setNotes('')
      created(batch)
    } catch (failure) {
      fail(failure)
      void load()
    } finally {
      setLoading(false)
    }
  }

  return <div className="tech-view">
    <header className="tech-view-head row">
      <div>
        <h1>Comigo</h1>
        <p className="muted">Equipamentos sob sua responsabilidade até o estoque conferir.</p>
      </div>
      <button type="button" className="small-btn" onClick={() => void load()} disabled={loading || !connected}>
        <Icon name="sync" /> Atualizar
      </button>
    </header>

    {localPending > 0 && <div className="tech-callout">
      <p><strong>{localPending} foto{localPending > 1 ? 's' : ''} ainda no celular.</strong> Envie para poder colocar no lote.</p>
      <button type="button" className="small-btn" onClick={sync} disabled={syncing || !connected}>
        {syncing ? 'Enviando…' : 'Enviar agora'}
      </button>
    </div>}
    {!connected && <p className="alert" role="status">Sem conexão. Conecte-se para consultar e montar lotes.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {connected && !items && loading && <p role="status" className="muted">Consultando…</p>}

    {items && <>
      <section className="tech-section">
        <div className="tech-section-head">
          <h2>Para entregar <span className="count">{free.length}</span></h2>
          {free.length > 0 && <button type="button" className="link-btn" onClick={() =>
            setSelected(selected.size === free.length ? new Set() : new Set(free.map((item) => item.capture_id)))}>
            {selected.size === free.length ? 'Limpar seleção' : 'Selecionar todos'}
          </button>}
        </div>
        {free.length === 0 && <p className="empty-state">Nada pendente de entrega fora de lotes.</p>}
        <ul className="tech-list">{free.map((item) => {
          const info = describe(item)
          const status = captureStatus[item.capture_status] ?? captureStatus.RECEIVED
          const checked = selected.has(item.capture_id)
          return <li key={item.capture_id}>
            <label className={'tech-pick' + (checked ? ' checked' : '')}>
              <input type="checkbox" checked={checked} onChange={() => toggle(item.capture_id)} />
              <span className="tech-pick-body">
                <span className={'mono' + (info.verified ? '' : ' muted')}>{info.text}</span>
                <span className="tech-pick-meta">
                  <span className={'badge ' + status.tone}>{status.label}</span>
                  <span className="muted">{dateTime.format(new Date(item.captured_at))}</span>
                  {item.complement?.service_order && <span className="muted">OS {item.complement.service_order}</span>}
                </span>
              </span>
            </label>
          </li>
        })}</ul>
      </section>

      {inBatch.length > 0 && <section className="tech-section">
        <div className="tech-section-head"><h2>Já em lote <span className="count">{inBatch.length}</span></h2></div>
        <ul className="tech-list">{inBatch.map((item) => <li key={item.capture_id} className="tech-row">
          <span className="mono">{describe(item).text}</span>
          <span className="badge badge-info">{batchName({ number: item.batch_number ?? 0 })}</span>
        </li>)}</ul>
      </section>}
    </>}

    {selected.size > 0 && !composing && <div className="tech-action-bar">
      <span><strong>{selected.size}</strong> selecionado{selected.size > 1 ? 's' : ''}</span>
      <button type="button" className="primary" onClick={() => setComposing(true)}>Montar lote</button>
    </div>}

    {composing && <div className="tech-sheet" role="dialog" aria-modal="true" aria-labelledby="compose-title">
      <div className="tech-sheet-panel">
        <h2 id="compose-title">Montar lote com {selected.size} equipamento{selected.size > 1 ? 's' : ''}</h2>
        <p className="muted">Separe estes equipamentos e entregue juntos no balcão. Eles continuam sob sua responsabilidade até o estoque bipar cada um.</p>
        <label>Observação para o estoque <span className="muted">(opcional)</span>
          <textarea value={notes} maxLength={500} rows={2} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {error && <p className="alert" role="alert">{error}</p>}
        <div className="tech-form-actions">
          <button type="button" className="primary" disabled={loading} onClick={() => void submit()}>
            {loading ? 'Enviando…' : 'Confirmar lote'}
          </button>
          <button type="button" disabled={loading} onClick={() => setComposing(false)}>Voltar</button>
        </div>
      </div>
    </div>}
  </div>
}
