import { useEffect, useState } from 'react'
import { ApiError, warehouse } from '../api'
import type { DesktopModule } from '../components/sidebar'
import type { City } from './sims'

type CityOverview = City & {
  technicians: number; clerks: number
  equipment_in_stock: number; equipment_with_technicians: number; open_batches: number
  sims_in_stock: number; sims_with_technicians: number
}

/** Visão geral do estoque por cidade. O administrador vê as três; o estoquista, a sua. */
export function Overview({ owner, denied, current, choose, go }: {
  owner: string; denied: () => void; current: City
  choose?: (city: City) => void; go: (module: DesktopModule) => void
}) {
  const [items, setItems] = useState<CityOverview[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    warehouse<{ items: CityOverview[] }>(owner, '/warehouse/overview').then((data) => setItems(data.items), (failure) => {
      if (failure instanceof ApiError && failure.status === 401) denied()
      setError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Tente novamente.')
    })
  }, [denied, owner])

  return <div className="module-container">
    <div className="section-head">
      <div><h1>Visão geral do estoque</h1>
        <p>Roteadores recolhidos e chips da MVNO{items && items.length > 1 ? ' em cada cidade' : ' em ' + current.name}.</p></div>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {!items && !error && <p className="muted" role="status">Carregando…</p>}
    <div className="city-grid">{items?.map((city) => {
      const active = city.id === current.id
      return <section key={city.id} className={'card city-card' + (active ? ' active' : '')} aria-current={active ? 'true' : undefined}>
        <header className="section-head">
          <div><h2>{city.name}</h2>
            <p className="muted small-text">{city.technicians} técnico{city.technicians === 1 ? '' : 's'} · {city.clerks} estoquista{city.clerks === 1 ? '' : 's'}</p></div>
          {active ? <span className="badge badge-success">Operando aqui</span>
            : choose && <button className="small-btn" onClick={() => choose(city)}>Operar nesta cidade</button>}
        </header>
        <div className="city-figures">
          <div><span className="muted small-text">Roteadores no estoque</span><strong>{city.equipment_in_stock}</strong></div>
          <div><span className="muted small-text">Roteadores com técnicos</span><strong>{city.equipment_with_technicians}</strong></div>
          <div><span className="muted small-text">Lotes para conferir</span><strong>{city.open_batches}</strong></div>
          <div><span className="muted small-text">Chips no estoque</span><strong>{city.sims_in_stock}</strong></div>
          <div><span className="muted small-text">Chips com técnicos</span><strong>{city.sims_with_technicians}</strong></div>
        </div>
        {active && <div className="actions">
          <button className="small-btn" onClick={() => go('batches')}>Conferir lotes</button>
          <button className="small-btn" onClick={() => go('sim-desk')}>Entregar chips</button>
          <button className="small-btn" onClick={() => go('sim-stock')}>Estoque de chips</button>
        </div>}
      </section>
    })}</div>
  </div>
}
