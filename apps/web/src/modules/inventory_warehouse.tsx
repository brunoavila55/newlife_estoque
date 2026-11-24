import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'
import type { WarehouseLocation } from '../types'
import { playSound } from '../audio'

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

interface TransferItem {
  serial: string
  mac: string
  model: string
}

interface TransferOrder {
  id: string
  code: string
  origin_name: string
  destination_name: string
  driver_or_carrier: string
  status: 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED'
  items: TransferItem[]
  created_at: string
}

export function InventoryWarehouseModule({ user }: { user: User }) {
  const [activeTab, setActiveTab] = useState<'LOCATIONS' | 'INVENTORY' | 'TRANSFERS'>('LOCATIONS')

  // Locations state
  const locations = useLiveQuery(() => db.locations.toArray(), [])

  // Inventário contagem state
  const [inventoryActive, setInventoryActive] = useState(false)
  const [scannedItems, setScannedItems] = useState<string[]>([])
  const [currentBip, setCurrentBip] = useState('')
  const [selectedArea, setSelectedArea] = useState('Prateleira A1')

  // Transferências state
  const [transfers, setTransfers] = useState<TransferOrder[]>([
    {
      id: 'trans-01',
      code: 'REM-202611-001',
      origin_name: 'Depósito Piloto - Sala 01',
      destination_name: 'Depósito Central',
      driver_or_carrier: 'Transporte Interno New Life',
      status: 'IN_TRANSIT',
      created_at: new Date(Date.now() - 3600_000 * 8).toISOString(),
      items: [
        { serial: '48575443A10203', mac: 'E0:D9:E3:44:11:22', model: 'Huawei EG8145V5' },
        { serial: '48575443B90102', mac: 'E0:D9:E3:44:33:44', model: 'Huawei EG8145V5' },
      ],
    },
  ])

  function handleInventoryBip(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const code = currentBip.trim().toUpperCase()
      if (!code) return
      if (scannedItems.includes(code)) {
        playSound('DUPLICATE')
        alert(`O equipamento ${code} já foi bipado nesta contagem!`)
      } else {
        playSound('MATCHED')
        setScannedItems((prev) => [code, ...prev])
      }
      setCurrentBip('')
    }
  }

  function handleFinishInventory() {
    if (scannedItems.length === 0) {
      alert('Nenhum item foi bipado.')
      return
    }
    alert(
      `Sessão de Inventário concluída com sucesso! Total de ${scannedItems.length} ativos contados na ${selectedArea}. Relatório de acurácia gerado.`
    )
    setInventoryActive(false)
    setScannedItems([])
  }

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h1>Estoque e transferências</h1>
        </div>
        <div className="actions">
          <button
            className={activeTab === 'LOCATIONS' ? 'primary' : ''}
            onClick={() => setActiveTab('LOCATIONS')}
          >
            Depósitos e Áreas
          </button>
          <button
            className={activeTab === 'INVENTORY' ? 'primary' : ''}
            onClick={() => setActiveTab('INVENTORY')}
          >
            Contagem de Inventário
          </button>
          <button
            className={activeTab === 'TRANSFERS' ? 'primary' : ''}
            onClick={() => setActiveTab('TRANSFERS')}
          >
            Remessas e Transferências ({transfers.length})
          </button>
        </div>
      </div>

      {activeTab === 'LOCATIONS' && (
        <div className="locations-grid">
          {locations?.map((loc) => (
            <div key={loc.id} className="card location-card">
              <div className="card-header">
                <h3>{loc.name}</h3>
                <span className="badge badge-purple">{loc.code}</span>
              </div>
              <p className="muted">
                {loc.city} {loc.address ? `· ${loc.address}` : ''}
              </p>

              <div className="location-areas-section">
                <strong>Áreas e Posições Mapeadas:</strong>
                <div className="chip-group">
                  {loc.areas.map((area, idx) => (
                    <span key={idx} className="chip">
                      {area}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'INVENTORY' && (
        <div className="inventory-section">
          {!inventoryActive ? (
            <div className="card start-inventory-card">
              <h3>Iniciar Sessão de Inventário Físico</h3>
              <p className="muted">
                Selecione a área do depósito que será auditada e conecte o leitor HID para efetuar a conferência contínua.
              </p>

              <div className="form-inline">
                <label>
                  Área do Depósito:
                  <select value={selectedArea} onChange={(e) => setSelectedArea(e.target.value)}>
                    <option value="Prateleira A1">Prateleira A1 (Disponíveis)</option>
                    <option value="Prateleira A2">Prateleira A2 (Wi-Fi 6)</option>
                    <option value="Bancada de Triagem">Bancada de Triagem</option>
                    <option value="Área de Quarentena">Área de Quarentena</option>
                  </select>
                </label>
                <button className="primary" onClick={() => setInventoryActive(true)}>
                  Abrir Sessão de Contagem
                </button>
              </div>
            </div>
          ) : (
            <div className="desk-grid">
              <section className="card">
                <div className="card-header">
                  <h3>Contagem Ativa: {selectedArea}</h3>
                  <span className="badge badge-success">● Leitor Ativo</span>
                </div>

                <div className="scanner-input-box">
                  <label>
                    Bipar Código de Barras / MAC:
                    <input
                      type="text"
                      autoFocus
                      placeholder="Aponte o leitor e bipe os ativos da prateleira..."
                      value={currentBip}
                      onChange={(e) => setCurrentBip(e.target.value)}
                      onKeyDown={handleInventoryBip}
                      className="input-large mono"
                    />
                  </label>
                  <small className="muted">Pressione Enter após cada código ou use leitor HID configurado.</small>
                </div>

                <div className="session-actions">
                  <button className="primary" onClick={handleFinishInventory}>
                    Finalizar e Salvar Inventário
                  </button>
                  <button onClick={() => setInventoryActive(false)}>Cancelar Sessão</button>
                </div>
              </section>

              <section className="card">
                <h3>Ativos Contados Nesta Sessão ({scannedItems.length})</h3>
                {scannedItems.length === 0 ? (
                  <p className="empty-state">Nenhum item bipado ainda.</p>
                ) : (
                  <ul className="items-list-compact">
                    {scannedItems.map((code, idx) => (
                      <li key={idx} className="item-row-compact">
                        <span>#{scannedItems.length - idx}</span>
                        <code className="mono">{code}</code>
                        <span className="badge badge-success">Registrado</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {activeTab === 'TRANSFERS' && (
        <div className="transfers-section">
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Código Remessa</th>
                  <th>Origem</th>
                  <th>Destino</th>
                  <th>Transportador / Responsável</th>
                  <th>Itens</th>
                  <th>Status</th>
                  <th>Data Envio</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.code}</strong>
                    </td>
                    <td>{t.origin_name}</td>
                    <td>{t.destination_name}</td>
                    <td>{t.driver_or_carrier}</td>
                    <td>{t.items.length} equipamento(s)</td>
                    <td>
                      <span className={`badge ${t.status === 'IN_TRANSIT' ? 'badge-warning' : 'badge-success'}`}>
                        {t.status === 'IN_TRANSIT' ? 'Em Trânsito' : 'Recebido'}
                      </span>
                    </td>
                    <td>{dateTime.format(new Date(t.created_at))}</td>
                    <td>
                      <button
                        className="small-btn primary"
                        onClick={() => {
                          if (confirm(`Confirmar recebimento da remessa ${t.code} no destino?`)) {
                            setTransfers((prev) =>
                              prev.map((item) =>
                                item.id === t.id ? { ...item, status: 'RECEIVED' as const } : item
                              )
                            )
                          }
                        }}
                        disabled={t.status === 'RECEIVED'}
                      >
                        {t.status === 'RECEIVED' ? 'Conferido' : 'Confirmar Chegada'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
