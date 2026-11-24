import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'
import type { Discrepancy, DiscrepancyType, DiscrepancyStatus } from '../types'

const typeLabels: Record<DiscrepancyType, string> = {
  UNKNOWN_CODE: 'Código Desconhecido (Sem Cadastro)',
  DUPLICATE_CODE: 'Tentativa de Recebimento Duplicado',
  WRONG_TECHNICIAN: 'Item Registrado para Outro Técnico',
  MISSING_IN_BATCH: 'Item Faltante Declarado no Lote',
  DAMAGED_PHYSICAL: 'Avaria Física / Dano Grave',
  UNREADABLE_LABEL: 'Etiqueta Ilegível ou Desgastada',
  UNBATCHED_ITEM: 'Item Avulso sem Lote Vinculado',
}

const statusLabels: Record<DiscrepancyStatus, string> = {
  OPEN: 'Aberto',
  IN_ANALYSIS: 'Em Análise',
  AWAITING_INFO: 'Aguardando Informação',
  RESOLVED: 'Resolvido',
  REOPENED: 'Reaberto',
}

const statusColors: Record<DiscrepancyStatus, string> = {
  OPEN: '#dc2626',
  IN_ANALYSIS: '#ea580c',
  AWAITING_INFO: '#ca8a04',
  RESOLVED: '#16a34a',
  REOPENED: '#9333ea',
}

const priorityBadges: Record<'LOW' | 'MEDIUM' | 'HIGH', string> = {
  LOW: 'badge-muted',
  MEDIUM: 'badge-warning',
  HIGH: 'badge-danger',
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function DiscrepanciesModule({ user }: { user: User }) {
  const [filter, setFilter] = useState<'ALL' | DiscrepancyStatus>('OPEN')
  const [selectedDiscrepancy, setSelectedDiscrepancy] = useState<Discrepancy | null>(null)
  const [search, setSearch] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolutionText, setResolutionText] = useState('')
  const [newStatus, setNewStatus] = useState<DiscrepancyStatus>('RESOLVED')

  const discrepancies = useLiveQuery(async () => {
    return await db.discrepancies.orderBy('created_at').reverse().toArray()
  }, [])

  const filtered = discrepancies?.filter((d) => {
    if (filter !== 'ALL' && d.status !== filter) return false
    if (!search.trim()) return true
    const term = search.toLowerCase()
    return (
      d.code_scanned.toLowerCase().includes(term) ||
      typeLabels[d.type].toLowerCase().includes(term) ||
      (d.declared_technician_name && d.declared_technician_name.toLowerCase().includes(term)) ||
      (d.notes && d.notes.toLowerCase().includes(term))
    )
  })

  function openResolution(d: Discrepancy) {
    setSelectedDiscrepancy(d)
    setResolutionText(d.resolution || '')
    setNewStatus(d.status === 'RESOLVED' ? 'RESOLVED' : 'RESOLVED')
  }

  async function handleSaveResolution(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedDiscrepancy) return
    if (!resolutionText.trim()) {
      alert('Informe a justificativa e decisão da resolução para auditoria.')
      return
    }
    setResolving(true)
    try {
      const updated: Discrepancy = {
        ...selectedDiscrepancy,
        status: newStatus,
        resolution: resolutionText.trim(),
        resolved_by: user.name,
        resolved_at: new Date().toISOString(),
      }
      await db.discrepancies.put(updated)

      // Criar notificação de resolução
      await db.notifications.add({
        id: crypto.randomUUID(),
        type: 'INFO',
        title: `Divergência Resolvida: ${typeLabels[selectedDiscrepancy.type]}`,
        message: `Caso para código ${selectedDiscrepancy.code_scanned} foi marcado como ${statusLabels[newStatus]} por ${user.name}.`,
        read: false,
        created_at: new Date().toISOString(),
      })

      setSelectedDiscrepancy(null)
    } catch (err) {
      alert('Erro ao salvar resolução: ' + String(err))
    } finally {
      setResolving(false)
    }
  }

  async function seedSampleDiscrepancies() {
    await db.discrepancies.bulkAdd([
      {
        id: crypto.randomUUID(),
        type: 'UNKNOWN_CODE',
        code_scanned: 'SN998877AABB11',
        warehouse_id: '00000000-0000-4000-8000-000000000001',
        warehouse_name: 'Depósito Piloto',
        clerk_id: user.id,
        clerk_name: user.name,
        status: 'OPEN',
        priority: 'HIGH',
        notes: 'Equipamento lido na mesa não consta em coletas nem no cadastro. Separado na bancada de quarentena física.',
        created_at: new Date(Date.now() - 3600_000 * 3).toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: 'WRONG_TECHNICIAN',
        code_scanned: '48575443A1B2C3D4',
        declared_technician_name: 'Felipe Ramos (Técnico)',
        warehouse_id: '00000000-0000-4000-8000-000000000001',
        warehouse_name: 'Depósito Piloto',
        clerk_id: user.id,
        clerk_name: user.name,
        status: 'IN_ANALYSIS',
        priority: 'MEDIUM',
        notes: 'Roteador estava sob custódia de Felipe Ramos, mas foi entregue no balcão pelo técnico Carlos Silva.',
        created_at: new Date(Date.now() - 3600_000 * 12).toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: 'MISSING_IN_BATCH',
        code_scanned: 'LOTE-202611-003',
        declared_technician_name: 'Carlos Silva (Técnico)',
        warehouse_id: '00000000-0000-4000-8000-000000000001',
        warehouse_name: 'Depósito Piloto',
        clerk_id: user.id,
        clerk_name: user.name,
        status: 'OPEN',
        priority: 'HIGH',
        notes: 'Declarados 10 itens no lote, porém apenas 9 foram entregues fisicamente. Aberto prazo de 48h para averiguação.',
        created_at: new Date(Date.now() - 3600_000 * 20).toISOString(),
      },
      {
        id: crypto.randomUUID(),
        type: 'DAMAGED_PHYSICAL',
        code_scanned: 'ZTEGC11223344',
        warehouse_id: '00000000-0000-4000-8000-000000000001',
        warehouse_name: 'Depósito Piloto',
        clerk_id: user.id,
        clerk_name: user.name,
        status: 'RESOLVED',
        priority: 'MEDIUM',
        notes: 'Carcaça quebrada e conectores oxidados recolhidos em cliente inundado.',
        resolution: 'Encaminhado diretamente para bancada de descarte e sucata autorizada. Registrado BO operacional.',
        resolved_by: user.name,
        resolved_at: new Date(Date.now() - 3600_000 * 5).toISOString(),
        created_at: new Date(Date.now() - 3600_000 * 30).toISOString(),
      },
    ])
  }

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h2>Divergências e Exceções Operacionais (Cap. 10)</h2>
          <p className="muted">
            Tratamento de códigos desconhecidos, equipamentos em quarentena física, itens de outro técnico, faltantes e
            avarias. Toda resolução é auditada.
          </p>
        </div>
        {(!discrepancies || discrepancies.length === 0) && (
          <button onClick={() => void seedSampleDiscrepancies()}>+ Carregar Exemplos de Exceções</button>
        )}
      </div>

      <div className="filter-bar">
        <div className="search-box">
          <input
            type="search"
            placeholder="Filtrar por código, técnico, tipo ou descrição…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="chip-group">
          {(['ALL', 'OPEN', 'IN_ANALYSIS', 'AWAITING_INFO', 'RESOLVED'] as const).map((st) => (
            <button
              key={st}
              className={`chip ${filter === st ? 'active' : ''}`}
              onClick={() => setFilter(st)}
            >
              {st === 'ALL' ? 'Todas as Divergências' : statusLabels[st]}
            </button>
          ))}
        </div>
      </div>

      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Tipo de Ocorrência</th>
              <th>Código / Serial Lido</th>
              <th>Prioridade</th>
              <th>Técnico / Origem</th>
              <th>Status</th>
              <th>Data Abertura</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {filtered && filtered.length > 0 ? (
              filtered.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{typeLabels[item.type]}</strong>
                  </td>
                  <td>
                    <code>{item.code_scanned}</code>
                  </td>
                  <td>
                    <span className={`badge ${priorityBadges[item.priority]}`}>{item.priority}</span>
                  </td>
                  <td>{item.declared_technician_name || item.warehouse_name || '—'}</td>
                  <td>
                    <span
                      className="status-pill"
                      style={{
                        backgroundColor: `${statusColors[item.status]}15`,
                        color: statusColors[item.status],
                        borderColor: statusColors[item.status],
                      }}
                    >
                      {statusLabels[item.status]}
                    </span>
                  </td>
                  <td>{dateTime.format(new Date(item.created_at))}</td>
                  <td>
                    <button className="primary small-btn" onClick={() => openResolution(item)}>
                      {item.status === 'RESOLVED' ? 'Ver Resolução' : 'Tratar Caso'}
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  Nenhuma divergência encontrada nesta visualização.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal de Tratamento e Resolução de Divergência */}
      {selectedDiscrepancy && (
        <div className="modal-overlay" onClick={() => setSelectedDiscrepancy(null)}>
          <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>{typeLabels[selectedDiscrepancy.type]}</h3>
                <p className="muted">
                  Código: <code>{selectedDiscrepancy.code_scanned}</code> · Registrado em:{' '}
                  {dateTime.format(new Date(selectedDiscrepancy.created_at))}
                </p>
              </div>
              <button className="close-btn" onClick={() => setSelectedDiscrepancy(null)}>
                ✕
              </button>
            </div>

            <div className="discrepancy-details-box">
              <p>
                <strong>Depósito / Unidade:</strong> {selectedDiscrepancy.warehouse_name || 'Depósito Piloto'}
              </p>
              {selectedDiscrepancy.declared_technician_name && (
                <p>
                  <strong>Técnico Relacionado:</strong> {selectedDiscrepancy.declared_technician_name}
                </p>
              )}
              <p>
                <strong>Operador que registrou:</strong> {selectedDiscrepancy.clerk_name || 'Estoquista'}
              </p>
              {selectedDiscrepancy.notes && (
                <div className="callout-box">
                  <strong>Relato da Ocorrência:</strong>
                  <p>{selectedDiscrepancy.notes}</p>
                </div>
              )}
            </div>

            <form onSubmit={(e) => void handleSaveResolution(e)} className="resolution-form">
              <label>
                Status do Caso
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value as DiscrepancyStatus)}
                >
                  <option value="IN_ANALYSIS">Em Análise / Investigação</option>
                  <option value="AWAITING_INFO">Aguardando Informação do Técnico</option>
                  <option value="RESOLVED">Resolvido (Com Justificativa)</option>
                  <option value="REOPENED">Reaberto</option>
                </select>
              </label>

              <label>
                Justificativa e Decisão Formal de Resolução (Auditoria)
                <textarea
                  rows={4}
                  required
                  value={resolutionText}
                  onChange={(e) => setResolutionText(e.target.value)}
                  placeholder="Explique a decisão tomada: ex: 'Equipamento conferido manualmente com nota fiscal; vinculado à OS 49210 e transferido ao depósito central'."
                />
              </label>

              {selectedDiscrepancy.resolved_by && (
                <p className="muted small-text">
                  Última resolução gravada por {selectedDiscrepancy.resolved_by} em{' '}
                  {dateTime.format(new Date(selectedDiscrepancy.resolved_at || ''))}
                </p>
              )}

              <div className="modal-actions">
                <button type="button" onClick={() => setSelectedDiscrepancy(null)}>
                  Fechar
                </button>
                <button type="submit" className="primary" disabled={resolving}>
                  {resolving ? 'Salvando Decisão…' : 'Gravar Resolução Auditada'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
