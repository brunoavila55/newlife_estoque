import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'

interface DashboardProps {
  user: User
  onNavigate: (module: any) => void
}

export function DashboardModule({ user, onNavigate }: DashboardProps) {
  const batches = useLiveQuery(() => db.batches.toArray(), [])
  const triage = useLiveQuery(() => db.triage.toArray(), [])
  const discrepancies = useLiveQuery(() => db.discrepancies.toArray(), [])

  const pendingTriageCount = triage?.filter((t) => t.status === 'PENDING').length || 0
  const openDiscrepanciesCount = discrepancies?.filter((d) => d.status === 'OPEN').length || 0

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h2>Visão Geral e Indicadores Operacionais (Cap. 14)</h2>
          <p className="muted">
            Painel executivo em tempo real: rastreabilidade de ativos em campo, taxa de conferência, fila de triagem e
            alertas de retenção prolongada.
          </p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => onNavigate('receiving')}>
            ⚡ Ir para Mesa de Recebimento
          </button>
        </div>
      </div>

      {/* Grid de Cards KPI */}
      <div className="kpi-grid">
        <div className="kpi-card" onClick={() => onNavigate('reports')}>
          <div className="kpi-header">
            <span className="kpi-title">Em Campo com Técnicos</span>
            <span className="kpi-icon">👷</span>
          </div>
          <div className="kpi-value">25</div>
          <div className="kpi-trend text-warning">▲ 3 técnicos ativos</div>
        </div>

        <div className="kpi-card" onClick={() => onNavigate('batches')}>
          <div className="kpi-header">
            <span className="kpi-title">Aguardando no Balcão</span>
            <span className="kpi-icon">📋</span>
          </div>
          <div className="kpi-value">{batches?.filter((b) => b.status === 'PRESENTED').length || 2}</div>
          <div className="kpi-trend text-info">Lotes apresentados</div>
        </div>

        <div className="kpi-card" onClick={() => onNavigate('receiving')}>
          <div className="kpi-header">
            <span className="kpi-title">Recebidos no Mês</span>
            <span className="kpi-icon">📦</span>
          </div>
          <div className="kpi-value">84</div>
          <div className="kpi-trend text-success">✓ 96.2% taxa de devolução</div>
        </div>

        <div className="kpi-card" onClick={() => onNavigate('discrepancies')}>
          <div className="kpi-header">
            <span className="kpi-title">Divergências Abertas</span>
            <span className="kpi-icon">⚠️</span>
          </div>
          <div className="kpi-value text-danger">{openDiscrepanciesCount}</div>
          <div className="kpi-trend text-danger">Requer atenção da supervisão</div>
        </div>

        <div className="kpi-card" onClick={() => onNavigate('triage')}>
          <div className="kpi-header">
            <span className="kpi-title">Fila de Triagem</span>
            <span className="kpi-icon">🔬</span>
          </div>
          <div className="kpi-value text-purple">{pendingTriageCount}</div>
          <div className="kpi-trend">Aguardando teste de bancada</div>
        </div>

        <div className="kpi-card" onClick={() => onNavigate('inventory_warehouse')}>
          <div className="kpi-header">
            <span className="kpi-title">Estoque Disponível</span>
            <span className="kpi-icon">✅</span>
          </div>
          <div className="kpi-value text-success">68</div>
          <div className="kpi-trend text-success">Prontos para reinstalação</div>
        </div>
      </div>

      <div className="desk-grid">
        {/* Gráfico Visual de Distribuição de Ativos */}
        <section className="card">
          <h3>Distribuição de Ativos por Ciclo de Vida</h3>
          <p className="muted">Equipamentos rastreados no sistema New Life:</p>

          <div className="chart-bars-vertical">
            <div className="chart-bar-group">
              <div className="bar-wrapper">
                <div className="bar-fill" style={{ height: '55%', backgroundColor: '#0284c7' }} />
              </div>
              <span className="bar-label">Em Campo</span>
              <span className="bar-val">25</span>
            </div>

            <div className="chart-bar-group">
              <div className="bar-wrapper">
                <div className="bar-fill" style={{ height: '35%', backgroundColor: '#d97706' }} />
              </div>
              <span className="bar-label">Triagem</span>
              <span className="bar-val">16</span>
            </div>

            <div className="chart-bar-group">
              <div className="bar-wrapper">
                <div className="bar-fill" style={{ height: '90%', backgroundColor: '#16a34a' }} />
              </div>
              <span className="bar-label">Disponível</span>
              <span className="bar-val">68</span>
            </div>

            <div className="chart-bar-group">
              <div className="bar-wrapper">
                <div className="bar-fill" style={{ height: '18%', backgroundColor: '#9333ea' }} />
              </div>
              <span className="bar-label">Manutenção</span>
              <span className="bar-val">8</span>
            </div>

            <div className="chart-bar-group">
              <div className="bar-wrapper">
                <div className="bar-fill" style={{ height: '10%', backgroundColor: '#dc2626' }} />
              </div>
              <span className="bar-label">Sucata</span>
              <span className="bar-val">4</span>
            </div>
          </div>
        </section>

        {/* Alerta de Retenção de Técnicos */}
        <section className="card">
          <div className="card-header">
            <h3>Retenção de Equipamentos em Campo</h3>
            <span className="badge badge-warning">Meta: devolução &lt; 7 dias</span>
          </div>
          <p className="muted">Monitoramento de tempo de posse desde o recolhimento na casa do cliente:</p>

          <ul className="retention-list">
            <li className="retention-item alert-border">
              <div className="retention-info">
                <strong>Felipe Ramos (Técnico)</strong>
                <span className="muted">14 roteadores em custódia</span>
              </div>
              <div className="retention-badge badge-danger">
                9 dias de retenção (5 em atraso)
              </div>
            </li>

            <li className="retention-item">
              <div className="retention-info">
                <strong>Carlos Silva (Técnico)</strong>
                <span className="muted">8 roteadores em custódia</span>
              </div>
              <div className="retention-badge badge-success">
                4 dias de retenção (Regular)
              </div>
            </li>

            <li className="retention-item">
              <div className="retention-info">
                <strong>Marcos Souza (Técnico)</strong>
                <span className="muted">3 roteadores em custódia</span>
              </div>
              <div className="retention-badge badge-success">
                2 dias de retenção (Regular)
              </div>
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
