import { useCallback, useEffect, useState } from 'react'
import { administrator, ApiError, authenticated, type Inventory } from './api'
import type { User } from './db'

export function InventoryPanel({ owner, denied, technician }: {
  owner: string; denied: () => void; technician?: User
}) {
  const path = technician ? '/admin/users/' + technician.id + '/inventory' : '/me/inventory'
  const request = technician ? administrator : authenticated
  const [page, setPage] = useState<Inventory>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (cursor?: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await request<Inventory>(owner, path + (cursor ? '?after=' + cursor : ''))
      setPage((previous) => cursor && previous ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) denied()
      if (!cursor) setPage(undefined)
      setError(failure instanceof ApiError ? failure.message : 'Não foi possível consultar o estoque.')
    } finally {
      setLoading(false)
    }
  }, [denied, owner, path, request])

  useEffect(() => { void load() }, [load])

  return <section className="card work-list inventory-panel">
    <div className="section-head"><h2>{technician ? 'Estoque de ' + technician.name : 'Estoque particular'}</h2><button onClick={() => void load()} disabled={loading}>Atualizar</button></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading && !page && <p role="status">Consultando estoque…</p>}
    {page?.items.length === 0 && <p className="empty-state">Nenhum equipamento identificado em custódia.</p>}
    {!!page?.items.length && <ul className="items">{page.items.map((item) =>
      <li key={item.id}>
        <strong className="status-label">Aguardando devolução</strong>
        <ul>{item.identifiers.map((identifier) =>
          <li key={identifier.kind + identifier.normalized_value}>{identifier.kind === 'SERIAL' ? 'Serial' : identifier.kind}: {identifier.raw_value}</li>
        )}</ul>
      </li>
    )}</ul>}
    {page?.next_cursor && <button onClick={() => void load(page.next_cursor!)} disabled={loading}>Carregar mais</button>}
  </section>
}
