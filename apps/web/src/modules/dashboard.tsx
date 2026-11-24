import { Icon } from '../components/icon'
import type { DesktopModule } from '../components/sidebar'

export function DashboardModule({ administrator, onNavigate }: {
  administrator: boolean
  onNavigate: (module: DesktopModule) => void
}) {
  return (
    <div className="module-container dashboard">
      <h1>Visão geral</h1>
      <section className="workbench-feature">
        <div className="workbench-copy">
          <Icon name={administrator ? 'camera' : 'scan'} />
          <h2>{administrator ? 'Revisão de etiquetas' : 'Mesa de recebimento'}</h2>
          <p>{administrator
            ? 'Confira as fotos das coletas e valide os identificadores extraídos das etiquetas.'
            : 'Confira os equipamentos devolvidos por serial ou MAC e registre a entrega ao estoque.'}</p>
          <button onClick={() => onNavigate(administrator ? 'review' : 'receiving')}>
            {administrator ? 'Abrir revisão de OCR' : 'Abrir mesa de recebimento'} <Icon name="next" />
          </button>
        </div>
      </section>
      <section className="operations-panel">
        <h2>Acesso rápido</h2>
        <div className="operations-grid">
          {administrator && <>
            <button onClick={() => onNavigate('users')}><Icon name="users" /><span>Gerenciar usuários</span></button>
            <button onClick={() => onNavigate('receiving')}><Icon name="scan" /><span>Abrir mesa de recebimento</span></button>
          </>}
          <button onClick={() => onNavigate('catalog')}><Icon name="search" /><span>Rastrear equipamento</span></button>
          <button onClick={() => onNavigate('history')}><Icon name="file" /><span>Consultar comprovantes</span></button>
          <button onClick={() => onNavigate('discrepancies')}><Icon name="alert" /><span>Ver divergências</span></button>
        </div>
      </section>
    </div>
  )
}
