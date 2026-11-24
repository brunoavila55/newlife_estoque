import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { Icon } from '../components/icon'
import type { DesktopModule } from '../components/sidebar'

export function DashboardModule({ onNavigate }: { onNavigate: (module: DesktopModule) => void }) {
  const presented = useLiveQuery(() => db.batches.filter((batch) => batch.status === 'PRESENTED').count(), [])
  const inTriage = useLiveQuery(() => db.triage.filter((item) => item.status === 'PENDING').count(), [])
  const discrepancies = useLiveQuery(() => db.discrepancies.filter((item) => item.status === 'OPEN').count(), [])

  return (
    <div className="module-container dashboard">
      <h1>Visão geral</h1>

      <section className="workbench-feature">
        <div className="workbench-copy">
          <Icon name="scan" />
          <h2>Mesa de recebimento</h2>
          <p>Confira os equipamentos devolvidos por serial ou MAC e registre a entrega ao estoque.</p>
          <button onClick={() => onNavigate('receiving')}>Abrir mesa de recebimento <Icon name="next" /></button>
        </div>
      </section>

      <section className="operations-panel">
        <h2>Pendências neste dispositivo</h2>
        <div className="operations-grid">
          <button onClick={() => onNavigate('batches')}>
            <Icon name="list" /><span>Lotes apresentados</span><strong>{presented ?? '—'}</strong>
          </button>
          <button onClick={() => onNavigate('triage')}>
            <Icon name="tools" /><span>Aguardando triagem</span><strong>{inTriage ?? '—'}</strong>
          </button>
          <button onClick={() => onNavigate('discrepancies')}>
            <Icon name="alert" /><span>Divergências abertas</span><strong>{discrepancies ?? '—'}</strong>
          </button>
        </div>
      </section>
    </div>
  )
}
