import { Icon } from '../components/icon'
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'
import type { TriageRecord, TriageOutcome, TriageDestination, TriageChecklist } from '../types'

const outcomeLabels: Record<TriageOutcome, string> = {
  APPROVED: 'Aprovado',
  REJECTED: 'Reprovado',
  INCONCLUSIVE: 'Inconclusivo',
  UNTESTED: 'Não Testado',
}

const outcomeColors: Record<TriageOutcome, string> = {
  APPROVED: '#16a34a',
  REJECTED: '#dc2626',
  INCONCLUSIVE: '#ca8a04',
  UNTESTED: '#64748b',
}

const destinationLabels: Record<TriageDestination, string> = {
  AVAILABLE: 'Disponível para Reinstalação',
  MAINTENANCE: 'Bancada de Manutenção',
  QUARANTINE: 'Quarentena Técnica',
  SCRAP: 'Sucata / Descarte',
  SUPPLIER_RETURN: 'Devolução ao Fornecedor (RMA)',
}

const destinationBadges: Record<TriageDestination, string> = {
  AVAILABLE: 'badge-success',
  MAINTENANCE: 'badge-warning',
  QUARANTINE: 'badge-purple',
  SCRAP: 'badge-danger',
  SUPPLIER_RETURN: 'badge-info',
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function TriageModule({ user }: { user: User }) {
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'COMPLETED'>('ALL')
  const [selectedRecord, setSelectedRecord] = useState<TriageRecord | null>(null)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  // Form state
  const [checklist, setChecklist] = useState<TriageChecklist>({
    case_condition: 'INTACT',
    connectors_condition: 'INTACT',
    power_supply: 'ORIGINAL',
    cables: 'PRESENT',
    functional_test: 'FACTORY_RESET',
    cleaning_and_reset: true,
    outcome: 'APPROVED',
    destination: 'AVAILABLE',
    notes: '',
  })

  const triageItems = useLiveQuery(async () => {
    return await db.triage.orderBy('received_at').reverse().toArray()
  }, [])

  const filtered = triageItems?.filter((item) => {
    if (filter === 'PENDING' && item.status !== 'PENDING') return false
    if (filter === 'COMPLETED' && item.status !== 'COMPLETED') return false
    if (!search.trim()) return true
    const term = search.toLowerCase()
    return (
      item.serial.toLowerCase().includes(term) ||
      item.mac.toLowerCase().includes(term) ||
      item.model.toLowerCase().includes(term) ||
      item.technician_name.toLowerCase().includes(term)
    )
  })

  function openInspection(record: TriageRecord) {
    setSelectedRecord(record)
    if (record.checklist) {
      setChecklist(record.checklist)
    } else {
      setChecklist({
        case_condition: 'INTACT',
        connectors_condition: 'INTACT',
        power_supply: 'ORIGINAL',
        cables: 'PRESENT',
        functional_test: 'FACTORY_RESET',
        cleaning_and_reset: true,
        outcome: 'APPROVED',
        destination: 'AVAILABLE',
        notes: '',
      })
    }
  }

  async function handleSaveInspection(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedRecord) return
    setSaving(true)
    try {
      const updated: TriageRecord = {
        ...selectedRecord,
        status: 'COMPLETED',
        inspected_at: new Date().toISOString(),
        inspected_by: user.name,
        checklist,
      }
      await db.triage.put(updated)

      // Registrar notificação se reprovado ou sucata
      if (checklist.outcome === 'REJECTED' || checklist.destination === 'SCRAP') {
        await db.notifications.add({
          id: crypto.randomUUID(),
          type: 'DISCREPANCY_ALERT',
          title: `Triagem: Equipamento Reprovado (${selectedRecord.serial})`,
          message: `O roteador ${selectedRecord.model} foi classificado como ${destinationLabels[checklist.destination]} por ${user.name}.`,
          read: false,
          created_at: new Date().toISOString(),
        })
      }

      setSelectedRecord(null)
    } catch (err) {
      alert('Erro ao salvar triagem: ' + String(err))
    } finally {
      setSaving(false)
    }
  }

  // Quick Seed for demonstration if triage table is empty
  async function seedSampleTriage() {
    await db.triage.bulkAdd([
      {
        id: crypto.randomUUID(),
        equipment_id: 'equip-demo-1',
        serial: '48575443F89A1201',
        mac: 'E0:D9:E3:45:11:01',
        model: 'Huawei EG8145V5',
        technician_name: 'Carlos Silva (Técnico)',
        received_at: new Date(Date.now() - 3600_000 * 2).toISOString(),
        status: 'PENDING',
      },
      {
        id: crypto.randomUUID(),
        equipment_id: 'equip-demo-2',
        serial: 'FHTT09823412',
        mac: '00:1E:67:89:AB:02',
        model: 'Fiberhome AN5506-04-F',
        technician_name: 'Marcos Souza (Técnico)',
        received_at: new Date(Date.now() - 3600_000 * 5).toISOString(),
        status: 'PENDING',
      },
      {
        id: crypto.randomUUID(),
        equipment_id: 'equip-demo-3',
        serial: 'ZTEGC9012389',
        mac: '34:E8:94:11:22:33',
        model: 'ZTE ZXHN F670L',
        technician_name: 'Carlos Silva (Técnico)',
        received_at: new Date(Date.now() - 3600_000 * 24).toISOString(),
        inspected_at: new Date(Date.now() - 3600_000 * 18).toISOString(),
        inspected_by: user.name,
        status: 'COMPLETED',
        checklist: {
          case_condition: 'INTACT',
          connectors_condition: 'INTACT',
          power_supply: 'ORIGINAL',
          cables: 'PRESENT',
          functional_test: 'FACTORY_RESET',
          cleaning_and_reset: true,
          outcome: 'APPROVED',
          destination: 'AVAILABLE',
          notes: 'Testado na bancada de fibra óptica. Reset de fábrica efetuado.',
        },
      },
    ])
  }

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h1>Triagem de equipamentos</h1>
        </div>
        {(!triageItems || triageItems.length === 0) && (
          <button onClick={() => void seedSampleTriage()}>+ Carregar Amostras de Triagem</button>
        )}
      </div>

      <div className="filter-bar">
        <div className="search-box">
          <input
            type="search"
            placeholder="Filtrar por serial, MAC, modelo ou técnico…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="chip-group">
          {(['ALL', 'PENDING', 'COMPLETED'] as const).map((st) => (
            <button
              key={st}
              className={`chip ${filter === st ? 'active' : ''}`}
              onClick={() => setFilter(st)}
            >
              {st === 'ALL'
                ? 'Todos os Itens'
                : st === 'PENDING'
                ? 'Aguardando Inspeção'
                : 'Triados & Destinados'}
            </button>
          ))}
        </div>
      </div>

      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Modelo / Equipamento</th>
              <th>Serial / MAC</th>
              <th>Entregue por</th>
              <th>Data Recebimento</th>
              <th>Resultado</th>
              <th>Destinação Final</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {filtered && filtered.length > 0 ? (
              filtered.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.model}</strong>
                  </td>
                  <td>
                    <div className="mono-codes">
                      <span>SN: {item.serial}</span>
                      <span>MAC: {item.mac}</span>
                    </div>
                  </td>
                  <td>{item.technician_name}</td>
                  <td>{dateTime.format(new Date(item.received_at))}</td>
                  <td>
                    {item.checklist ? (
                      <span
                        className="status-pill"
                        style={{
                          backgroundColor: `${outcomeColors[item.checklist.outcome]}15`,
                          color: outcomeColors[item.checklist.outcome],
                          borderColor: outcomeColors[item.checklist.outcome],
                        }}
                      >
                        {outcomeLabels[item.checklist.outcome]}
                      </span>
                    ) : (
                      <span className="status-pill status-pill-muted">Aguardando</span>
                    )}
                  </td>
                  <td>
                    {item.checklist ? (
                      <span className={`badge ${destinationBadges[item.checklist.destination]}`}>
                        {destinationLabels[item.checklist.destination]}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <button className="primary small-btn" onClick={() => openInspection(item)}>
                      {item.status === 'PENDING' ? 'Realizar Triagem' : 'Ver / Editar'}
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  Nenhum equipamento na fila de triagem com os filtros atuais.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal / Painel de Inspeção Técnica */}
      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>Inspeção Técnica de Triagem</h3>
                <p className="muted">
                  {selectedRecord.model} · Serial: <code>{selectedRecord.serial}</code> · MAC:{' '}
                  <code>{selectedRecord.mac}</code>
                </p>
              </div>
              <button className="close-btn" aria-label="Fechar" onClick={() => setSelectedRecord(null)}>
                <Icon name="close" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveInspection(e)} className="triage-form">
              <div className="form-section-title">1. Checklist Físico e Acessórios</div>
              <div className="form-grid-3">
                <label>
                  Estado da Carcaça
                  <select
                    value={checklist.case_condition}
                    onChange={(e) =>
                      setChecklist({ ...checklist, case_condition: e.target.value as any })
                    }
                  >
                    <option value="INTACT">Intacta (Excelente estado)</option>
                    <option value="SCRATCHED">Arranhada / Desgaste leve</option>
                    <option value="BROKEN">Trincada / Quebrada / Avariada</option>
                  </select>
                </label>

                <label>
                  Conectores e Portas RJ45/Óptica
                  <select
                    value={checklist.connectors_condition}
                    onChange={(e) =>
                      setChecklist({ ...checklist, connectors_condition: e.target.value as any })
                    }
                  >
                    <option value="INTACT">Portas Intactas / Pinos Íntegros</option>
                    <option value="DAMAGED">Porta Quebrada / Pino Torto / Óptica Suja</option>
                  </select>
                </label>

                <label>
                  Fonte de Alimentação
                  <select
                    value={checklist.power_supply}
                    onChange={(e) =>
                      setChecklist({ ...checklist, power_supply: e.target.value as any })
                    }
                  >
                    <option value="ORIGINAL">Fonte Original Funcional</option>
                    <option value="REPLACEMENT">Fonte Paralela Homologada</option>
                    <option value="MISSING">Fonte Ausente</option>
                    <option value="FAULTY">Fonte Queimada / Defeituosa</option>
                  </select>
                </label>
              </div>

              <div className="form-section-title">2. Testes Operacionais e Reset de Fábrica (LGPD)</div>
              <div className="form-grid-2">
                <label>
                  Teste de Energia e Luzes
                  <select
                    value={checklist.functional_test}
                    onChange={(e) =>
                      setChecklist({ ...checklist, functional_test: e.target.value as any })
                    }
                  >
                    <option value="FACTORY_RESET">Reset de Fábrica OK + Luzes Normais</option>
                    <option value="POWER_ON">Liga Normalmente (Sem Reset)</option>
                    <option value="LIGHTS_OK">LEDs Indicadores OK</option>
                    <option value="NO_POWER">Não Liga / Sem Sinal de Vida</option>
                    <option value="FAILED">Travado em Boot / Falha de Firmware</option>
                  </select>
                </label>

                <div className="checkbox-card">
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={checklist.cleaning_and_reset}
                      onChange={(e) =>
                        setChecklist({ ...checklist, cleaning_and_reset: e.target.checked })
                      }
                    />
                    <div>
                      <strong>Higienização e Limpeza de Dados (LGPD)</strong>
                      <small className="muted">
                        Confirmado: credenciais Wi-Fi, PPPoE e dados do assinante anterior foram
                        completamente resetados.
                      </small>
                    </div>
                  </label>
                </div>
              </div>

              <div className="form-section-title">3. Parecer e Destinação do Ativo</div>
              <div className="form-grid-2">
                <label>
                  Resultado da Triagem
                  <select
                    value={checklist.outcome}
                    onChange={(e) => {
                      const out = e.target.value as TriageOutcome
                      let dest: TriageDestination = 'AVAILABLE'
                      if (out === 'REJECTED') dest = 'MAINTENANCE'
                      if (out === 'INCONCLUSIVE') dest = 'QUARANTINE'
                      setChecklist({ ...checklist, outcome: out, destination: dest })
                    }}
                  >
                    <option value="APPROVED">Aprovado para Reuso</option>
                    <option value="REJECTED">✗ Reprovado / Com Defeito</option>
                    <option value="INCONCLUSIVE">? Inconclusivo / Necessita Teste Avançado</option>
                    <option value="UNTESTED">Não Testado</option>
                  </select>
                </label>

                <label>
                  Destinação Operacional
                  <select
                    value={checklist.destination}
                    onChange={(e) =>
                      setChecklist({ ...checklist, destination: e.target.value as any })
                    }
                  >
                    <option value="AVAILABLE">Estoque Disponível (Pronto para Reinstalação)</option>
                    <option value="MAINTENANCE">Bancada de Manutenção / Conserto</option>
                    <option value="QUARANTINE">Quarentena Técnica</option>
                    <option value="SCRAP">Sucata / Descarte Autorizado</option>
                    <option value="SUPPLIER_RETURN">Devolução ao Fornecedor (Garantia/RMA)</option>
                  </select>
                </label>
              </div>

              <label>
                Observações Técnicas
                <textarea
                  rows={2}
                  value={checklist.notes || ''}
                  onChange={(e) => setChecklist({ ...checklist, notes: e.target.value })}
                  placeholder="Detalhes sobre a conservação, cabos adicionais, motivo de manutenção ou número de protocolo..."
                />
              </label>

              <div className="modal-actions">
                <button type="button" onClick={() => setSelectedRecord(null)}>
                  Cancelar
                </button>
                <button type="submit" className="primary" disabled={saving}>
                  {saving ? 'Gravando Triagem…' : 'Confirmar e Atualizar Destino'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
