import { Icon } from '../components/icon'
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'
import { batchStatusLabels, type Batch, type BatchStatus } from '../types'
import { QRCodeSVG } from '../components/qrcode'

const statusColors: Record<BatchStatus, string> = {
  DRAFT: '#64748b',
  PRESENTED: '#0284c7',
  IN_CHECK: '#d97706',
  PARTIAL: '#ea580c',
  COMPLETED: '#16a34a',
  CANCELLED: '#dc2626',
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function BatchesModule({ user, onOpenSession }: { user: User; onOpenSession?: (batch: Batch) => void }) {
  const [filter, setFilter] = useState<'ALL' | BatchStatus>('ALL')
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null)
  const [printBatch, setPrintBatch] = useState<Batch | null>(null)
  const [search, setSearch] = useState('')

  const batches = useLiveQuery(async () => {
    let query = db.batches.orderBy('created_at').reverse()
    const all = await query.toArray()
    return all
  }, [])

  const filtered = batches?.filter((b) => {
    if (filter !== 'ALL' && b.status !== filter) return false
    if (!search.trim()) return true
    const term = search.toLowerCase()
    return (
      b.code.toLowerCase().includes(term) ||
      b.technician_name.toLowerCase().includes(term) ||
      b.warehouse_name.toLowerCase().includes(term) ||
      b.items.some((i) => i.serial.toLowerCase().includes(term) || i.mac.toLowerCase().includes(term))
    )
  })

  async function cancelBatch(batch: Batch) {
    if (batch.status === 'COMPLETED') {
      alert('Não é possível cancelar um lote já concluído.')
      return
    }
    if (!confirm(`Deseja cancelar o lote ${batch.code}? Os itens voltarão para o estoque particular do técnico.`)) {
      return
    }
    await db.batches.update(batch.id, { status: 'CANCELLED' })
    if (selectedBatch?.id === batch.id) {
      setSelectedBatch((prev) => (prev ? { ...prev, status: 'CANCELLED' } : null))
    }
  }

  return (
    <div className="module-container">
      {/* Visualização de Impressão de Comprovante de Quitação (PDF / Impressora) */}
      {printBatch && (
        <div className="receipt-print-modal">
          <div className="receipt-print-actions no-print">
            <button className="primary" onClick={() => window.print()}>
              Imprimir / Salvar em PDF
            </button>
            <button onClick={() => setPrintBatch(null)}>Fechar</button>
          </div>
          <div className="receipt-print">
            <header className="print-header">
              <div>
                <h2>NEW LIFE - TELECOM</h2>
                <p>Termo de Quitação e Recebimento de Equipamentos</p>
              </div>
              <div className="print-meta">
                <strong>{printBatch.code}</strong>
                <p>Emissão: {dateTime.format(new Date())}</p>
              </div>
            </header>

            <div className="print-grid">
              <div>
                <dt>Técnico Responsável:</dt>
                <dd>{printBatch.technician_name}</dd>
              </div>
              <div>
                <dt>Unidade de Recebimento:</dt>
                <dd>{printBatch.warehouse_name}</dd>
              </div>
              <div>
                <dt>Status do Lote:</dt>
                <dd>{batchStatusLabels[printBatch.status]}</dd>
              </div>
              <div>
                <dt>Total de Itens Declarados:</dt>
                <dd>{printBatch.total_items} equipamento(s)</dd>
              </div>
              <div>
                <dt>Itens Confirmados:</dt>
                <dd>{printBatch.accepted_items} equipamento(s)</dd>
              </div>
              <div>
                <dt>Pendências / Faltantes:</dt>
                <dd>{printBatch.total_items - printBatch.accepted_items} equipamento(s)</dd>
              </div>
            </div>

            <h3>Relação de Equipamentos</h3>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Nº</th>
                  <th>Modelo</th>
                  <th>Serial (SN)</th>
                  <th>MAC Address</th>
                  <th>Status</th>
                  <th>Conferido em</th>
                </tr>
              </thead>
              <tbody>
                {printBatch.items.map((item, index) => (
                  <tr key={item.equipment_id || index}>
                    <td>{index + 1}</td>
                    <td>{item.model || 'ONU / Roteador'}</td>
                    <td><code>{item.serial}</code></td>
                    <td><code>{item.mac}</code></td>
                    <td>
                      <span className={`badge status-${item.status.toLowerCase()}`}>
                        {item.status === 'ACCEPTED' ? 'Recebido' : item.status === 'PENDING' ? 'Pendente' : 'Divergente'}
                      </span>
                    </td>
                    <td>{item.confirmed_at ? dateTime.format(new Date(item.confirmed_at)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {printBatch.notes && (
              <div className="print-notes">
                <strong>Observações da Operação:</strong>
                <p>{printBatch.notes}</p>
              </div>
            )}

            <div className="print-signatures">
              <div>
                <div className="sig-line" />
                <p>Assinatura do Técnico: {printBatch.technician_name}</p>
              </div>
              <div>
                <div className="sig-line" />
                <p>Assinatura do Estoquista / Conferente</p>
              </div>
            </div>
            <footer className="print-footer">
              <small>
                Registro digital imutável gerado pelo Sistema New Life de Gestão de Recolhimento e Devolução. Conforme
                princípio de cadeia de custódia rastreável.
              </small>
            </footer>
          </div>
        </div>
      )}

      <div className="section-head">
        <div>
          <h1>Lotes e entregas</h1>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-box">
          <input
            type="search"
            placeholder="Buscar por código de lote, técnico, serial ou MAC…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="chip-group">
          {(['ALL', 'PRESENTED', 'IN_CHECK', 'PARTIAL', 'COMPLETED', 'DRAFT'] as const).map((st) => (
            <button
              key={st}
              className={`chip ${filter === st ? 'active' : ''}`}
              onClick={() => setFilter(st)}
            >
              {st === 'ALL' ? 'Todos os Lotes' : batchStatusLabels[st]}
            </button>
          ))}
        </div>
      </div>

      <div className="batches-grid">
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Código do Lote</th>
                <th>Técnico</th>
                <th>Destino</th>
                <th>Progresso</th>
                <th>Status</th>
                <th>Data</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered && filtered.length > 0 ? (
                filtered.map((batch) => {
                  const pct = batch.total_items > 0 ? Math.round((batch.accepted_items / batch.total_items) * 100) : 0
                  return (
                    <tr
                      key={batch.id}
                      className={selectedBatch?.id === batch.id ? 'row-selected' : ''}
                      onClick={() => setSelectedBatch(batch)}
                    >
                      <td>
                        <strong>{batch.code}</strong>
                      </td>
                      <td>{batch.technician_name}</td>
                      <td>{batch.warehouse_name}</td>
                      <td>
                        <div className="progress-cell">
                          <div className="progress-bar-small">
                            <div className="progress-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <span>
                            {batch.accepted_items}/{batch.total_items} ({pct}%)
                          </span>
                        </div>
                      </td>
                      <td>
                        <span
                          className="status-pill"
                          style={{
                            backgroundColor: `${statusColors[batch.status]}15`,
                            color: statusColors[batch.status],
                            borderColor: statusColors[batch.status],
                          }}
                        >
                          {batchStatusLabels[batch.status]}
                        </span>
                      </td>
                      <td>{dateTime.format(new Date(batch.created_at))}</td>
                      <td>
                        <div className="action-buttons-inline">
                          <button
                            className="btn-icon"
                            title="Ver detalhes e QR Code"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedBatch(batch)
                            }}
                          >
                            Ver
                          </button>
                          <button
                            className="btn-icon"
                            title="Imprimir Comprovante / Termo de Quitação"
                            onClick={(e) => {
                              e.stopPropagation()
                              setPrintBatch(batch)
                            }}
                          >
                            Imprimir
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    Nenhum lote encontrado com os filtros selecionados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Painel lateral de Detalhes do Lote */}
        {selectedBatch && (
          <aside className="detail-sidebar card">
            <div className="detail-sidebar-head">
              <div>
                <h3>Lote {selectedBatch.code}</h3>
                <span
                  className="status-pill"
                  style={{
                    backgroundColor: `${statusColors[selectedBatch.status]}15`,
                    color: statusColors[selectedBatch.status],
                    borderColor: statusColors[selectedBatch.status],
                  }}
                >
                  {batchStatusLabels[selectedBatch.status]}
                </span>
              </div>
              <button className="close-btn" aria-label="Fechar" onClick={() => setSelectedBatch(null)}>
                <Icon name="close" />
              </button>
            </div>

            <div className="qr-container">
              <QRCodeSVG value={`newlife:batch:${selectedBatch.id}:${selectedBatch.code}`} size={140} />
              <small className="muted">QR Code para o estoquista bipar no balcão</small>
            </div>

            <div className="batch-metadata">
              <p>
                <strong>Técnico:</strong> {selectedBatch.technician_name}
              </p>
              <p>
                <strong>Depósito:</strong> {selectedBatch.warehouse_name}
              </p>
              <p>
                <strong>Criado em:</strong> {dateTime.format(new Date(selectedBatch.created_at))}
              </p>
              {selectedBatch.notes && (
                <p>
                  <strong>Obs:</strong> {selectedBatch.notes}
                </p>
              )}
            </div>

            <div className="batch-items-list">
              <h4>Itens do Lote ({selectedBatch.items.length})</h4>
              <ul>
                {selectedBatch.items.map((item, idx) => (
                  <li key={idx} className="batch-item-row">
                    <div>
                      <strong>{item.model || 'Equipamento'}</strong>
                      <div className="mono-codes">
                        <span>SN: {item.serial}</span>
                        <span>MAC: {item.mac}</span>
                      </div>
                    </div>
                    <span className={`badge status-${item.status.toLowerCase()}`}>
                      {item.status === 'ACCEPTED' ? 'Aceito' : item.status === 'PENDING' ? 'Pendente' : 'Divergência'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="detail-actions">
              {onOpenSession && selectedBatch.status !== 'COMPLETED' && selectedBatch.status !== 'CANCELLED' && (
                <button
                  className="primary full-width"
                  onClick={() => onOpenSession(selectedBatch)}
                >
                  Iniciar Conferência deste Lote
                </button>
              )}
              <button
                className="full-width"
                onClick={() => setPrintBatch(selectedBatch)}
              >
                Imprimir Termo de Quitação
              </button>
              {selectedBatch.status !== 'COMPLETED' && selectedBatch.status !== 'CANCELLED' && (
                <button
                  className="danger-btn full-width"
                  onClick={() => cancelBatch(selectedBatch)}
                >
                  Cancelar Lote
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
