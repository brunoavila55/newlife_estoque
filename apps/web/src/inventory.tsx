import { useCallback, useEffect, useState } from 'react'
import { administrator, ApiError, authenticated, type Equipment, type Inventory } from './api'
import type { User } from './db'

type DeliveredEquipment = Equipment & { delivered_at: string; warehouse_name: string }
type EquipmentPage = Omit<Inventory, 'items'> & { items: (Equipment | DeliveredEquipment)[] }
const deliveryDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function InventoryPanel({ owner, denied, technician, deliveries = false }: {
  owner: string; denied: () => void; technician?: User; deliveries?: boolean
}) {
  const path = technician ? '/admin/users/' + technician.id + (deliveries ? '/deliveries' : '/inventory') : '/me/inventory'
  const request = technician ? administrator : authenticated
  const [page, setPage] = useState<EquipmentPage>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (cursor?: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await request<EquipmentPage>(owner, path + (cursor ? '?after=' + cursor : ''))
      setPage((previous) => cursor && previous ? { ...next, items: [...previous.items, ...next.items] } : next)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) denied()
      if (!cursor) setPage(undefined)
      setError(failure instanceof ApiError ? failure.message : 'Não foi possível consultar os equipamentos.')
    } finally {
      setLoading(false)
    }
  }, [denied, owner, path, request])

  useEffect(() => { void load() }, [load])

  return <section className="card work-list inventory-panel">
    <div className="section-head">
      {technician ? <h2>{deliveries ? 'Entregas confirmadas' : 'Equipamentos em posse'}</h2> : <h1>Meu estoque</h1>}
      <button onClick={() => void load()} disabled={loading}>Atualizar</button>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading && !page && <p role="status">Consultando equipamentos…</p>}
    {page?.items.length === 0 && <p className="empty-state">{deliveries
      ? 'Nenhuma entrega confirmada.'
      : 'Nenhum equipamento identificado em custódia.'}</p>}
    {!!page?.items.length && <ul className="items">{page.items.map((item) =>
      <li key={item.id}>
        {'delivered_at' in item ? <div>
          <strong>{item.warehouse_name}</strong>
          <p className="muted"><time dateTime={item.delivered_at}>{deliveryDate.format(new Date(item.delivered_at))}</time></p>
        </div> : <strong className="status-label">Aguardando devolução</strong>}
        <ul>{item.identifiers.map((identifier) =>
          <li key={identifier.kind + identifier.normalized_value}>{identifier.kind === 'SERIAL' ? 'Serial' : identifier.kind}: {identifier.raw_value}</li>
        )}</ul>
      </li>
    )}</ul>}
    {page?.next_cursor && <button onClick={() => void load(page.next_cursor!)} disabled={loading}>Carregar mais</button>}
  </section>
}
