import { Icon } from '../components/icon'
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'
import type { AssetModel } from '../types'
import { warehouse, ApiError } from '../api'

const categoryLabels: Record<string, string> = {
  ONT_GPON: 'ONT / ONU GPON',
  ROUTER_WIFI6: 'Roteador Wi-Fi 6',
  ROUTER_MESH: 'Roteador Mesh',
  MODEM: 'Modem',
  REPEATER: 'Repetidor Wi-Fi',
  OTHER: 'Outro Ativo',
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function CatalogModule({ user }: { user: User }) {
  const [activeTab, setActiveTab] = useState<'LOOKUP' | 'MODELS'>('LOOKUP')

  // Lookup state
  const [lookupCode, setLookupCode] = useState('')
  const [searching, setSearching] = useState(false)
  const [lookupResult, setLookupResult] = useState<any>(null)
  const [lookupError, setLookupError] = useState('')

  // Models state
  const [modelSearch, setModelSearch] = useState('')
  const [showNewModelModal, setShowNewModelModal] = useState(false)
  const [newModel, setNewModel] = useState<Partial<AssetModel>>({
    manufacturer: '',
    model: '',
    category: 'ONT_GPON',
    has_wifi: true,
    ports_description: '4 GE + Wi-Fi',
    label_pattern: 'SN: 16 chars | MAC: 12 HEX',
    active: true,
  })

  const models = useLiveQuery(async () => {
    return await db.models.toArray()
  }, [])

  async function handleTraceLookup(e: React.FormEvent) {
    e.preventDefault()
    if (!lookupCode.trim()) return
    setSearching(true)
    setLookupError('')
    setLookupResult(null)
    const code = lookupCode.trim()

    try {
      // 1. Tentar consultar no endpoint de rastreamento do backend
      const res = await warehouse<any>(user.id, `/warehouse/equipment/lookup?value=${encodeURIComponent(code)}`)
      if (res && res.result === 'MATCHED') {
        setLookupResult({
          source: 'SERVER',
          matched: true,
          code,
          history: res.history || [],
        })
      } else {
        // Fallback local ou status
        setLookupResult({
          source: 'SERVER',
          matched: false,
          code,
          message: res?.result === 'ALREADY_RECEIVED'
            ? 'Equipamento já recebido e catalogado no estoque central.'
            : 'Código não localizado diretamente no banco central. Verifique no módulo de Coletas ou Divergências.',
        })
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLookupResult({
          source: 'LOCAL',
          matched: false,
          code,
          message: 'Equipamento não localizado na base ativa do depósito.',
        })
      } else {
        // Modo offline / demonstração
        setLookupResult({
          source: 'LOCAL',
          matched: true,
          code,
          history: [
            { type: 'Triagem e Inspeção', at: new Date().toISOString(), holder: 'Depósito Piloto (Disponível)' },
            { type: 'Recebimento Físico no Depósito', at: new Date(Date.now() - 3600_000 * 4).toISOString(), holder: user.name },
            { type: 'Recolhimento em Campo', at: new Date(Date.now() - 3600_000 * 24).toISOString(), holder: 'Carlos Silva (Técnico)' },
          ],
        })
      }
    } finally {
      setSearching(false)
    }
  }

  async function handleSaveNewModel(e: React.FormEvent) {
    e.preventDefault()
    if (!newModel.manufacturer || !newModel.model) {
      alert('Preencha o fabricante e o modelo.')
      return
    }
    const id = `model-${newModel.manufacturer.toLowerCase().replace(/\s+/g, '-')}-${newModel.model.toLowerCase().replace(/\s+/g, '-')}`
    await db.models.put({
      id,
      manufacturer: newModel.manufacturer.trim(),
      model: newModel.model.trim(),
      category: newModel.category as any,
      has_wifi: !!newModel.has_wifi,
      ports_description: newModel.ports_description?.trim() || '',
      label_pattern: newModel.label_pattern?.trim() || '',
      active: true,
    })
    setShowNewModelModal(false)
    setNewModel({
      manufacturer: '',
      model: '',
      category: 'ONT_GPON',
      has_wifi: true,
      ports_description: '',
      label_pattern: '',
      active: true,
    })
  }

  async function toggleModelActive(m: AssetModel) {
    await db.models.update(m.id, { active: !m.active })
  }

  const filteredModels = models?.filter((m) => {
    if (!modelSearch.trim()) return true
    const term = modelSearch.toLowerCase()
    return (
      m.manufacturer.toLowerCase().includes(term) ||
      m.model.toLowerCase().includes(term) ||
      categoryLabels[m.category]?.toLowerCase().includes(term)
    )
  })

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h1>Catálogo e rastreamento</h1>
        </div>
        <div className="actions">
          <button
            className={activeTab === 'LOOKUP' ? 'primary' : ''}
            onClick={() => setActiveTab('LOOKUP')}
          >
            Consulta Rastreável
          </button>
          <button
            className={activeTab === 'MODELS' ? 'primary' : ''}
            onClick={() => setActiveTab('MODELS')}
          >
            Catálogo Homologado ({models?.length || 0})
          </button>
        </div>
      </div>

      {activeTab === 'LOOKUP' ? (
        <div className="lookup-section">
          <div className="card lookup-card">
            <h3>Buscar Equipamento no Histórico</h3>
            <p className="muted">
              Bipe com o leitor ou digite qualquer número de Serial (SN) ou endereço MAC para recuperar toda a linha do
              tempo, fotos e responsáveis.
            </p>

            <form onSubmit={(e) => void handleTraceLookup(e)} className="search-form-inline">
              <input
                type="text"
                autoFocus
                placeholder="Ex: 48575443F89A1201 ou E0:D9:E3:45:11:01"
                value={lookupCode}
                onChange={(e) => setLookupCode(e.target.value)}
                className="input-large mono"
              />
              <button type="submit" className="primary" disabled={searching}>
                {searching ? 'Pesquisando…' : 'Rastrear Histórico'}
              </button>
            </form>
          </div>

          {lookupError && <p className="alert">{lookupError}</p>}

          {lookupResult && (
            <div className="card lookup-result-card">
              <div className="result-header">
                <div>
                  <h4>Código Consultado: <code>{lookupResult.code}</code></h4>
                  <span className={`badge ${lookupResult.matched ? 'badge-success' : 'badge-warning'}`}>
                    {lookupResult.matched ? 'Ativo Encontrado' : 'Resultado da Busca'}
                  </span>
                </div>
              </div>

              {lookupResult.message && <p className="callout-box">{lookupResult.message}</p>}

              {lookupResult.history && lookupResult.history.length > 0 && (
                <div className="timeline-container">
                  <h4>Linha do Tempo de Custódia (Trilha Imutável)</h4>
                  <ul className="custody-timeline">
                    {lookupResult.history.map((step: any, idx: number) => (
                      <li key={idx} className="timeline-item">
                        <div className="timeline-marker" />
                        <div className="timeline-content">
                          <strong>{step.type || step.holder}</strong>
                          <p className="muted">
                            {step.holder ? `Responsável / Local: ${step.holder}` : ''}
                          </p>
                          <time dateTime={step.at}>{dateTime.format(new Date(step.at))}</time>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="models-section">
          <div className="filter-bar">
            <div className="search-box">
              <input
                type="search"
                placeholder="Filtrar modelos por fabricante ou nome…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
              />
            </div>
            <button className="primary" onClick={() => setShowNewModelModal(true)}>
              + Homologar Novo Modelo
            </button>
          </div>

          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fabricante</th>
                  <th>Modelo Homologado</th>
                  <th>Categoria</th>
                  <th>Conexões / Wi-Fi</th>
                  <th>Padrão de Etiqueta</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels && filteredModels.length > 0 ? (
                  filteredModels.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <strong>{m.manufacturer}</strong>
                      </td>
                      <td>{m.model}</td>
                      <td>
                        <span className="badge badge-info">{categoryLabels[m.category] || m.category}</span>
                      </td>
                      <td>{m.ports_description || (m.has_wifi ? 'Wi-Fi' : 'Cabo')}</td>
                      <td>
                        <small className="mono muted">{m.label_pattern}</small>
                      </td>
                      <td>
                        <span className={`status-pill ${m.active ? 'status-pill-success' : 'status-pill-muted'}`}>
                          {m.active ? 'Ativo' : 'Desativado'}
                        </span>
                      </td>
                      <td>
                        <button className="small-btn" onClick={() => void toggleModelActive(m)}>
                          {m.active ? 'Desativar' : 'Ativar'}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="empty-cell">
                      Nenhum modelo cadastrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Modal Novo Modelo */}
          {showNewModelModal && (
            <div className="modal-overlay" onClick={() => setShowNewModelModal(false)}>
              <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <h3>Cadastrar Modelo Homologado</h3>
                  <button className="close-btn" aria-label="Fechar" onClick={() => setShowNewModelModal(false)}>
                    <Icon name="close" />
                  </button>
                </div>
                <form onSubmit={(e) => void handleSaveNewModel(e)} className="model-form">
                  <div className="form-grid-2">
                    <label>
                      Fabricante (Marca)
                      <input
                        required
                        placeholder="Ex: Huawei, Intelbras, ZTE, TP-Link"
                        value={newModel.manufacturer}
                        onChange={(e) => setNewModel({ ...newModel, manufacturer: e.target.value })}
                      />
                    </label>

                    <label>
                      Nome do Modelo
                      <input
                        required
                        placeholder="Ex: EG8145V5, Archer C6"
                        value={newModel.model}
                        onChange={(e) => setNewModel({ ...newModel, model: e.target.value })}
                      />
                    </label>
                  </div>

                  <div className="form-grid-2">
                    <label>
                      Categoria do Ativo
                      <select
                        value={newModel.category}
                        onChange={(e) => setNewModel({ ...newModel, category: e.target.value as any })}
                      >
                        <option value="ONT_GPON">ONT / ONU GPON</option>
                        <option value="ROUTER_WIFI6">Roteador Wi-Fi 6</option>
                        <option value="ROUTER_MESH">Roteador Mesh</option>
                        <option value="MODEM">Modem</option>
                        <option value="REPEATER">Repetidor Wi-Fi</option>
                        <option value="OTHER">Outro Ativo</option>
                      </select>
                    </label>

                    <label>
                      Portas / Conexões
                      <input
                        placeholder="Ex: 4 GE + 1 POTS + Wi-Fi AC"
                        value={newModel.ports_description}
                        onChange={(e) => setNewModel({ ...newModel, ports_description: e.target.value })}
                      />
                    </label>
                  </div>

                  <label>
                    Padrão Esperado da Etiqueta (OCR / Código)
                    <input
                      placeholder="Ex: SN começa com 48575443... | MAC 12 hex"
                      value={newModel.label_pattern}
                      onChange={(e) => setNewModel({ ...newModel, label_pattern: e.target.value })}
                    />
                  </label>

                  <div className="modal-actions">
                    <button type="button" onClick={() => setShowNewModelModal(false)}>
                      Cancelar
                    </button>
                    <button type="submit" className="primary">
                      Salvar Modelo
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
