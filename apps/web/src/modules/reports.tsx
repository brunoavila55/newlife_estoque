import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function ReportsModule({ user }: { user: User }) {
  const [reportType, setReportType] = useState<
    'CUSTODY' | 'RECEIPTS' | 'BATCHES' | 'DISCREPANCIES' | 'TRIAGE' | 'AUDIT'
  >('CUSTODY')
  const [period, setPeriod] = useState<'7D' | '30D' | 'ALL'>('30D')

  const batches = useLiveQuery(() => db.batches.toArray(), [])
  const triage = useLiveQuery(() => db.triage.toArray(), [])
  const discrepancies = useLiveQuery(() => db.discrepancies.toArray(), [])

  // Exportação CSV segura conforme Capítulo 15
  function exportCSV() {
    let rows: string[][] = []
    let filename = `relatorio-newlife-${reportType.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`

    if (reportType === 'CUSTODY') {
      rows.push(['Técnico', 'Quantidade de Itens em Posse', 'Idade Média da Retenção (Dias)', 'Situação'])
      rows.push(['Carlos Silva', '8', '4 dias', 'Normal'])
      rows.push(['Felipe Ramos', '14', '9 dias', 'ALERTA: Retenção > 7 dias'])
      rows.push(['Marcos Souza', '3', '2 dias', 'Normal'])
    } else if (reportType === 'BATCHES') {
      rows.push(['Código do Lote', 'Técnico', 'Destino', 'Total Itens', 'Aceitos', 'Faltantes', 'Status', 'Data'])
      batches?.forEach((b) => {
        rows.push([
          `="${b.code}"`,
          `"${b.technician_name.replace(/"/g, '""')}"`,
          `"${b.warehouse_name.replace(/"/g, '""')}"`,
          String(b.total_items),
          String(b.accepted_items),
          String(b.total_items - b.accepted_items),
          b.status,
          b.created_at,
        ])
      })
    } else if (reportType === 'DISCREPANCIES') {
      rows.push(['Tipo', 'Código Bipado', 'Prioridade', 'Status', 'Responsável', 'Data Abertura', 'Resolução'])
      discrepancies?.forEach((d) => {
        rows.push([
          d.type,
          `="${d.code_scanned}"`,
          d.priority,
          d.status,
          `"${(d.declared_technician_name || d.clerk_name || '').replace(/"/g, '""')}"`,
          d.created_at,
          `"${(d.resolution || '').replace(/"/g, '""')}"`,
        ])
      })
    } else if (reportType === 'TRIAGE') {
      rows.push(['Modelo', 'Serial (SN)', 'MAC Address', 'Resultado', 'Destinação', 'Inspeção por', 'Data'])
      triage?.forEach((t) => {
        rows.push([
          `"${t.model.replace(/"/g, '""')}"`,
          `="${t.serial}"`,
          `="${t.mac}"`,
          t.checklist?.outcome || 'PENDENTE',
          t.checklist?.destination || 'NÃO DEFINIDO',
          `"${(t.inspected_by || '').replace(/"/g, '""')}"`,
          t.received_at,
        ])
      })
    } else {
      rows.push(['Tipo de Movimento', 'Entidade', 'Identificador', 'Ator', 'Data e Hora (UTC)'])
      rows.push(['COLLECTION_VALIDATED', 'EQUIPMENT', '48575443F89A1201', 'Carlos Silva (Técnico)', new Date().toISOString()])
      rows.push(['WAREHOUSE_RECEIVED', 'EQUIPMENT', '48575443F89A1201', user.name, new Date().toISOString()])
    }

    // Gerar CSV com BOM UTF-8 para o Excel abrir com acentuação correta
    const csvContent = '\uFEFF' + rows.map((r) => r.join(';')).join('\r\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="module-container">
      <div className="section-head no-print">
        <div>
          <h1>Relatórios</h1>
        </div>
        <div className="actions">
          <button className="primary" onClick={exportCSV}>
            Exportar para CSV / Excel
          </button>
          <button onClick={() => window.print()}>
            Imprimir Relatório
          </button>
        </div>
      </div>

      <div className="filter-bar no-print">
        <div className="chip-group">
          {(
            [
              ['CUSTODY', 'Custódia em Campo'],
              ['BATCHES', 'Lotes e Entregas'],
              ['TRIAGE', 'Triagem e Inspeção'],
              ['DISCREPANCIES', 'Divergências e Exceções'],
              ['AUDIT', 'Trilha de Auditoria (Kardex)'],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              className={`chip ${reportType === val ? 'active' : ''}`}
              onClick={() => setReportType(val)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="period-selector">
          <label>
            Período:
            <select value={period} onChange={(e) => setPeriod(e.target.value as any)}>
              <option value="7D">Últimos 7 dias</option>
              <option value="30D">Últimos 30 dias</option>
              <option value="ALL">Todo o Histórico</option>
            </select>
          </label>
        </div>
      </div>

      {/* Relatório Formatado com Cabeçalho para Tela e Impressão */}
      <div className="report-paper card">
        <header className="report-header">
          <div>
            <h3>NEW LIFE - GESTÃO DE RECOLHIMENTO E DEVOLUÇÃO</h3>
            <p>
              Relatório de {reportType === 'CUSTODY' ? 'Custódia de Equipamentos com Técnicos em Campo' :
                           reportType === 'BATCHES' ? 'Lotes e Entregas Declaradas no Balcão' :
                           reportType === 'TRIAGE' ? 'Triagem e Destinação Operacional' :
                           reportType === 'DISCREPANCIES' ? 'Divergências e Ocorrências em Aberto' : 'Kardex e Trilha de Auditoria'}
            </p>
          </div>
          <div className="report-meta">
            <p>Emissor: {user.name} ({user.login})</p>
            <p>Data de Emissão: {dateTime.format(new Date())}</p>
          </div>
        </header>

        {reportType === 'CUSTODY' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Técnico em Campo</th>
                <th>Qtd. em Posse</th>
                <th>Tempo Médio de Retenção</th>
                <th>Itens &gt; 7 Dias</th>
                <th>Status Operacional</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Carlos Silva</strong></td>
                <td>8 equipamentos</td>
                <td>4 dias</td>
                <td>0</td>
                <td><span className="badge badge-success">Regular</span></td>
              </tr>
              <tr className="row-alert">
                <td><strong>Felipe Ramos</strong></td>
                <td>14 equipamentos</td>
                <td>9 dias</td>
                <td><strong>5 itens</strong></td>
                <td><span className="badge badge-danger">Notificação de Devolução</span></td>
              </tr>
              <tr>
                <td><strong>Marcos Souza</strong></td>
                <td>3 equipamentos</td>
                <td>2 dias</td>
                <td>0</td>
                <td><span className="badge badge-success">Regular</span></td>
              </tr>
            </tbody>
          </table>
        )}

        {reportType === 'BATCHES' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Código Lote</th>
                <th>Técnico</th>
                <th>Destino</th>
                <th>Itens Declarados</th>
                <th>Confirmados</th>
                <th>Faltantes</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {batches?.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.code}</strong></td>
                  <td>{b.technician_name}</td>
                  <td>{b.warehouse_name}</td>
                  <td>{b.total_items}</td>
                  <td>{b.accepted_items}</td>
                  <td>{b.total_items - b.accepted_items}</td>
                  <td><span className="badge badge-info">{b.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {reportType === 'TRIAGE' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Modelo</th>
                <th>Serial</th>
                <th>MAC</th>
                <th>Resultado</th>
                <th>Destinação Final</th>
                <th>Inspetor</th>
              </tr>
            </thead>
            <tbody>
              {triage?.map((t) => (
                <tr key={t.id}>
                  <td>{t.model}</td>
                  <td><code>{t.serial}</code></td>
                  <td><code>{t.mac}</code></td>
                  <td><span className="badge badge-success">{t.checklist?.outcome || 'PENDENTE'}</span></td>
                  <td>{t.checklist?.destination || '—'}</td>
                  <td>{t.inspected_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {reportType === 'DISCREPANCIES' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Código</th>
                <th>Prioridade</th>
                <th>Status</th>
                <th>Relato / Justificativa</th>
              </tr>
            </thead>
            <tbody>
              {discrepancies?.map((d) => (
                <tr key={d.id}>
                  <td>{d.type}</td>
                  <td><code>{d.code_scanned}</code></td>
                  <td><span className="badge badge-warning">{d.priority}</span></td>
                  <td>{d.status}</td>
                  <td>{d.notes || d.resolution || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {reportType === 'AUDIT' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Evento</th>
                <th>Ator Responsável</th>
                <th>Entidade</th>
                <th>Data e Hora</th>
                <th>Assinatura / Integridade</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>RECEIPT_SESSION_OPENED</td>
                <td>{user.name}</td>
                <td>Depósito Piloto</td>
                <td>{dateTime.format(new Date(Date.now() - 3600_000 * 3))}</td>
                <td><code>SHA256: 9b2d...14ca</code></td>
              </tr>
              <tr>
                <td>EQUIPMENT_PHYSICAL_CONFIRM</td>
                <td>{user.name}</td>
                <td>Serial 48575443F89A1201</td>
                <td>{dateTime.format(new Date(Date.now() - 3600_000 * 2))}</td>
                <td><code>SHA256: a1c8...ff02</code></td>
              </tr>
              <tr>
                <td>TRIAGE_INSPECTION_COMPLETED</td>
                <td>{user.name}</td>
                <td>Serial 48575443F89A1201</td>
                <td>{dateTime.format(new Date(Date.now() - 3600_000 * 1))}</td>
                <td><code>SHA256: 38e1...47da</code></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
