import { useState, useRef, useCallback, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, storePhoto, freeSpace, type Capture, type Profile, type User } from '../db'
import { preparePhoto } from '../photo'
import { LabelCamera } from '../label-camera'
import type { BarcodeEvidence } from '../db'
import { QRCodeSVG } from '../components/qrcode'
import { playSound } from '../audio'

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

interface TechDeskProps {
  profile: Profile
  deny: () => void
  syncing: boolean
  run: (force: boolean) => Promise<void>
  leaveDesk: () => Promise<void>
}

export function TechDesk({ profile, deny, syncing, run, leaveDesk }: TechDeskProps) {
  const [navTab, setNavTab] = useState<'HOME' | 'CAPTURE' | 'CARTEIRA' | 'LOTES' | 'QUEUE'>('HOME')

  const [notice, setNotice] = useState('')
  const [success, setSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [lowSpace, setLowSpace] = useState(false)
  const [usedStorageMB, setUsedStorageMB] = useState<string>('0')

  // Capture & Complementary form state
  const [barcode, setBarcode] = useState('')
  const [macAddress, setMacAddress] = useState('')
  const [serialNumber, setSerialNumber] = useState('')
  const [selectedModel, setSelectedModel] = useState('Huawei EG8145V5')
  const [serviceOrder, setServiceOrder] = useState('')
  const [condition, setCondition] = useState<'GOOD' | 'DAMAGED'>('GOOD')
  const [powerSupply, setPowerSupply] = useState<'ORIGINAL' | 'REPLACEMENT' | 'MISSING'>('ORIGINAL')
  const [cablesPresent, setCablesPresent] = useState(true)
  const [notes, setNotes] = useState('')
  const [nextMode, setNextMode] = useState(false)

  const [liveCamera, setLiveCamera] = useState(false)
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<File | null>(null)

  // Carteira search & multi-select
  const [carteiraSearch, setCarteiraSearch] = useState('')
  const [selectedForBatch, setSelectedForBatch] = useState<string[]>([])
  const [batchNotes, setBatchNotes] = useState('')
  const [showCreateBatchModal, setShowCreateBatchModal] = useState(false)
  const [activeBatchModal, setActiveBatchModal] = useState<any>(null)

  const cameraInputRef = useRef<HTMLInputElement>(null)
  const pickerInputRef = useRef<HTMLInputElement>(null)

  const captures = useLiveQuery(
    async () => (await db.captures.where('owner').equals(profile.id).sortBy('capturedAt')).reverse(),
    [profile.id]
  )
  const batches = useLiveQuery(
    async () => (await db.batches.where('technician_id').equals(profile.id).sortBy('created_at')).reverse(),
    [profile.id]
  )
  const models = useLiveQuery(() => db.models.where('active').equals(1 as any).toArray(), [])

  const pendingCount = captures?.filter((c) => c.state !== 'UPLOADED').length || 0
  const identifiedCount = captures?.filter((c) => c.remoteStatus === 'IDENTIFIED').length || 0

  const checkSpace = useCallback(async () => {
    try {
      const estimate = await navigator.storage?.estimate()
      if (estimate?.usage) {
        setUsedStorageMB((estimate.usage / (1024 * 1024)).toFixed(1))
      }
      const free = await freeSpace()
      setLowSpace(free !== null && free < 40 * 1024 * 1024)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void checkSpace()
  }, [checkSpace])

  function handleMacChange(val: string) {
    const clean = val.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 12)
    const formatted = clean.match(/.{1,2}/g)?.join(':') || clean
    setMacAddress(formatted)
  }

  async function handlePhotoSelected(file?: File, liveEvidence?: BarcodeEvidence) {
    if (!file) return
    setCurrentFile(file)
    setPreviewBlobUrl(URL.createObjectURL(file))
    setLiveCamera(false)

    if (liveEvidence) {
      const code = liveEvidence.raw_value.trim()
      if (/^[0-9A-Fa-f]{12}$/.test(code.replace(/[:-]/g, ''))) {
        handleMacChange(code)
      } else {
        setSerialNumber(code)
      }
    }
  }

  async function handleSaveCapture() {
    if (!currentFile) {
      alert('Nenhuma foto capturada.')
      return
    }
    setSaving(true)
    setNotice('')
    setSuccess('')

    try {
      void navigator.storage?.persist?.().catch(() => false)
      const photo = await preparePhoto(currentFile)
      const capturedAt = new Date().toISOString()

      const evidence: BarcodeEvidence | undefined = barcode.trim()
        ? { raw_value: barcode.trim(), source: 'MANUAL' }
        : undefined

      await storePhoto(profile.id, photo, capturedAt, evidence, {
        model: selectedModel,
        serviceOrder: serviceOrder.trim() || undefined,
        condition,
        powerSupply,
        cables: cablesPresent,
        notes: notes.trim() || undefined,
      })

      playSound('SHUTTER')

      if (nextMode) {
        setSerialNumber('')
        setMacAddress('')
        setBarcode('')
        setCurrentFile(null)
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
        setPreviewBlobUrl(null)
        setSuccess('Salvo! Enquadre o próximo roteador desta mesma OS.')
      } else {
        setSerialNumber('')
        setMacAddress('')
        setBarcode('')
        setNotes('')
        setCurrentFile(null)
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
        setPreviewBlobUrl(null)
        setSuccess('Equipamento registrado com sucesso no celular.')
        setNavTab('QUEUE')
      }

      void run(false)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Erro ao salvar captura.')
    } finally {
      setSaving(false)
      void checkSpace()
    }
  }

  async function handleCreateBatch() {
    if (selectedForBatch.length === 0) {
      alert('Selecione ao menos um equipamento para criar o lote.')
      return
    }
    const batchId = crypto.randomUUID()
    const code = `LOTE-${new Date().toISOString().slice(2, 7).replace('-', '')}-${Math.floor(100 + Math.random() * 900)}`

    const selectedCaptures = captures?.filter((c) => selectedForBatch.includes(c.id)) || []
    const batchItems = selectedCaptures.map((c) => ({
      equipment_id: c.remoteId || c.id,
      serial: c.barcode?.raw_value || 'SN-EM-OCR',
      mac: 'MAC-EM-OCR',
      model: c.complement?.model || 'ONU / Roteador',
      status: 'PENDING' as const,
    }))

    await db.batches.add({
      id: batchId,
      code,
      technician_id: profile.id,
      technician_name: profile.name,
      warehouse_id: '00000000-0000-4000-8000-000000000001',
      warehouse_name: 'Depósito Piloto - Sala 01',
      status: 'PRESENTED',
      notes: batchNotes.trim() || undefined,
      items: batchItems,
      total_items: batchItems.length,
      accepted_items: 0,
      created_at: new Date().toISOString(),
      presented_at: new Date().toISOString(),
    })

    setSelectedForBatch([])
    setBatchNotes('')
    setShowCreateBatchModal(false)
    setNavTab('LOTES')
    playSound('MATCHED')
  }

  const filteredCarteira = captures?.filter((c) => {
    if (!carteiraSearch.trim()) return true
    const term = carteiraSearch.toLowerCase()
    return (
      (c.barcode?.raw_value && c.barcode.raw_value.toLowerCase().includes(term)) ||
      (c.complement?.model && c.complement.model.toLowerCase().includes(term)) ||
      (c.complement?.serviceOrder && c.complement.serviceOrder.toLowerCase().includes(term))
    )
  })

  return (
    <div className="mobile-app-shell">
      {/* 1. Barra de status móvel nativa */}
      <header className="mobile-system-header">
        <div className="mobile-status-bar">
          <span className="mobile-clock">{new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
          <div className="mobile-status-indicators">
            <span className={`network-pill ${navigator.onLine ? 'online' : 'offline'}`}>
              <span className="dot" /> {navigator.onLine ? '4G Online' : 'Sem Sinal'}
            </span>
            <span className="battery-icon">🔋 98%</span>
          </div>
        </div>

        <div className="mobile-app-bar">
          <div className="user-tech-badge">
            <div className="tech-avatar">{profile.name.charAt(0).toUpperCase()}</div>
            <div className="tech-meta">
              <strong className="tech-name">{profile.name}</strong>
              <span className="tech-role-tag">Técnico em Campo · New Life</span>
            </div>
          </div>

          <button
            type="button"
            className="mobile-exit-btn"
            onClick={() => (pendingCount > 0 ? setConfirmLeave(true) : void leaveDesk())}
            title={navigator.onLine ? 'Sair' : 'Bloquear'}
          >
            {navigator.onLine ? 'Sair' : 'Bloquear'}
          </button>
        </div>
      </header>

      {/* Alerta de confirmação de saída com fotos pendentes */}
      {confirmLeave && (
        <section className="mobile-alert-banner warning">
          <p>
            Você possui <strong>{pendingCount} foto(s) pendente(s)</strong> a enviar. Elas permanecerão guardadas neste celular.
          </p>
          <div className="banner-actions">
            <button className="small-btn" onClick={() => setConfirmLeave(false)}>Continuar Conectado</button>
            <button className="small-btn danger-btn" onClick={() => void leaveDesk()}>Sair e Manter</button>
          </div>
        </section>
      )}

      {notice && <div className="mobile-toast alert">{notice}</div>}
      {success && <div className="mobile-toast success">{success}</div>}
      {lowSpace && (
        <div className="mobile-toast alert">
          ⚠️ Pouco espaço disponível no celular. Sincronize suas fotos pendentes.
        </div>
      )}

      {/* 2. Conteúdo Principal das 5 Abas */}
      <div className="mobile-scrollable-body">
        {/* ABA 1: INÍCIO */}
        {navTab === 'HOME' && (
          <div className="mobile-tab-view home-view">
            {/* Hero Card Glassmorphic */}
            <div className="mobile-hero-card">
              <div className="hero-top-row">
                <span className="hero-subtitle">Sob Sua Custódia</span>
                <span className="retention-pill success">✓ 4 dias retido</span>
              </div>
              <div className="hero-counter-wrap">
                <h1 className="hero-main-counter">{identifiedCount + pendingCount}</h1>
                <span className="hero-counter-unit">roteadores em campo</span>
              </div>

              <div className="hero-sync-status">
                {pendingCount > 0 ? (
                  <span className="sync-tag pending">⚡ {pendingCount} fotos aguardando sincronização</span>
                ) : (
                  <span className="sync-tag synced">✓ Todas as coletas sincronizadas</span>
                )}
              </div>

              <button
                type="button"
                className="mobile-hero-cta"
                onClick={() => setNavTab('CAPTURE')}
              >
                <span className="cta-icon">📸</span>
                <span>Fotografar Novo Roteador</span>
              </button>
            </div>

            {/* Widget Grid de Acesso Rápido */}
            <div className="mobile-widget-grid">
              <div className="mobile-widget-card" onClick={() => setNavTab('CARTEIRA')}>
                <div className="widget-icon-box blue">💼</div>
                <strong className="widget-value">{identifiedCount}</strong>
                <span className="widget-title">Minha Carteira</span>
              </div>

              <div className="mobile-widget-card" onClick={() => setNavTab('LOTES')}>
                <div className="widget-icon-box teal">📋</div>
                <strong className="widget-value">{batches?.length || 0}</strong>
                <span className="widget-title">Lotes Gerados</span>
              </div>

              <div className="mobile-widget-card" onClick={() => setNavTab('QUEUE')}>
                <div className="widget-icon-box orange">🔄</div>
                <strong className="widget-value">{pendingCount}</strong>
                <span className="widget-title">Fila Offline</span>
              </div>
            </div>

            {/* Banner de Produtividade */}
            <div className="mobile-card info-card">
              <div className="card-header-icon">
                <span className="icon">💡</span>
                <strong>Agilidade na Casa do Cliente</strong>
              </div>
              <p className="small-text muted">
                Ao recolher mais de um aparelho no mesmo assinante, ative o <strong>"Modo Próximo"</strong> na tela de revisão para manter a Ordem de Serviço (OS) preenchida.
              </p>
            </div>

            {/* Resumo de Lotes Recentes */}
            {batches && batches.length > 0 && (
              <div className="mobile-section-block">
                <div className="section-title-row">
                  <h3>Últimos Lotes Apresentados</h3>
                  <button className="link-btn" onClick={() => setNavTab('LOTES')}>Ver Todos</button>
                </div>
                <div className="recent-batches-list">
                  {batches.slice(0, 2).map((b) => (
                    <div key={b.id} className="mobile-card batch-row-card" onClick={() => { setActiveBatchModal(b); setNavTab('LOTES') }}>
                      <div className="batch-row-left">
                        <strong>{b.code}</strong>
                        <span className="muted small-text">{b.total_items} equipamento(s)</span>
                      </div>
                      <span className="badge badge-info">{b.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ABA 2: REGISTRAR (CÂMERA & CADASTRO) */}
        {navTab === 'CAPTURE' && (
          <div className="mobile-tab-view capture-view">
            {!previewBlobUrl ? (
              <div className="mobile-capture-hero card">
                <div className="viewfinder-icon-illustration">
                  <div className="scanner-frame-art">
                    <span className="bracket tl" />
                    <span className="bracket tr" />
                    <span className="bracket bl" />
                    <span className="bracket br" />
                    <span className="laser-art" />
                    <span className="barcode-bars-art">||| | ||| || |</span>
                  </div>
                </div>

                <h2>Fotografar Etiqueta</h2>
                <p className="muted text-center">
                  Posicione a etiqueta do roteador com boa iluminação. O leitor decodificará os códigos em tempo real.
                </p>

                {liveCamera ? (
                  <LabelCamera
                    close={() => setLiveCamera(false)}
                    fallback={() => {
                      setLiveCamera(false)
                      cameraInputRef.current?.click()
                    }}
                    save={async (file, evidence) => {
                      await handlePhotoSelected(file, evidence)
                      return true
                    }}
                  />
                ) : (
                  <div className="capture-buttons-stack">
                    <button
                      type="button"
                      className="primary mobile-big-btn"
                      onClick={() =>
                        typeof navigator.mediaDevices?.getUserMedia === 'function'
                          ? setLiveCamera(true)
                          : cameraInputRef.current?.click()
                      }
                    >
                      <span className="btn-icon">📷</span> Abrir Câmera Traseira
                    </button>

                    <button
                      type="button"
                      className="secondary mobile-big-btn"
                      onClick={() => pickerInputRef.current?.click()}
                    >
                      <span className="btn-icon">🖼️</span> Escolher da Galeria
                    </button>
                  </div>
                )}

                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  onChange={(e) => {
                    void handlePhotoSelected(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                <input
                  ref={pickerInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    void handlePhotoSelected(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </div>
            ) : (
              /* Tela de Revisão da Foto com Formulário Complementar */
              <div className="mobile-review-form-wrap card">
                <div className="review-header-bar">
                  <h3>Conferência e Dados da Coleta</h3>
                  <button
                    type="button"
                    className="small-btn"
                    onClick={() => {
                      setCurrentFile(null)
                      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
                      setPreviewBlobUrl(null)
                    }}
                  >
                    Tirar Outra
                  </button>
                </div>

                <div className="captured-photo-thumb-wrap">
                  <img src={previewBlobUrl} alt="Etiqueta Capturada" className="captured-photo-img" />
                  <span className="photo-tag">✓ Foto Gravada</span>
                </div>

                <form onSubmit={(e) => { e.preventDefault(); void handleSaveCapture() }} className="mobile-form-body">
                  <div className="form-group">
                    <label>
                      Número de Série (SN)
                      <div className="input-with-badge">
                        <input
                          type="text"
                          required
                          className="mono"
                          placeholder="Ex: 48575443F89A1201"
                          value={serialNumber}
                          onChange={(e) => setSerialNumber(e.target.value.toUpperCase())}
                        />
                        <span className="input-tag">Zeros preservados</span>
                      </div>
                    </label>
                  </div>

                  <div className="form-group">
                    <label>
                      Endereço MAC
                      <input
                        type="text"
                        className="mono"
                        placeholder="AA:BB:CC:DD:EE:FF"
                        value={macAddress}
                        onChange={(e) => handleMacChange(e.target.value)}
                      />
                    </label>
                  </div>

                  <div className="form-group">
                    <label>
                      Modelo Homologado
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                      >
                        {models?.map((m) => (
                          <option key={m.id} value={`${m.manufacturer} ${m.model}`}>
                            {m.manufacturer} · {m.model}
                          </option>
                        ))}
                        <option value="Outro Modelo">Outro Modelo / Desconhecido</option>
                      </select>
                    </label>
                  </div>

                  <div className="form-group">
                    <label>
                      Ordem de Serviço (OS) ou Contrato
                      <input
                        type="text"
                        placeholder="Ex: OS-10492 ou Nome do Cliente"
                        value={serviceOrder}
                        onChange={(e) => setServiceOrder(e.target.value)}
                      />
                    </label>
                  </div>

                  {/* Segmented Buttons para Condição da Carcaça */}
                  <div className="form-group">
                    <label>Estado da Carcaça</label>
                    <div className="segmented-control">
                      <button
                        type="button"
                        className={`seg-btn ${condition === 'GOOD' ? 'active' : ''}`}
                        onClick={() => setCondition('GOOD')}
                      >
                        ✓ Bom Estado
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${condition === 'DAMAGED' ? 'active' : ''}`}
                        onClick={() => setCondition('DAMAGED')}
                      >
                        ⚠️ Avariado / Riscado
                      </button>
                    </div>
                  </div>

                  {/* Segmented Buttons para Fonte */}
                  <div className="form-group">
                    <label>Fonte de Alimentação</label>
                    <div className="segmented-control three-way">
                      <button
                        type="button"
                        className={`seg-btn ${powerSupply === 'ORIGINAL' ? 'active' : ''}`}
                        onClick={() => setPowerSupply('ORIGINAL')}
                      >
                        Original
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${powerSupply === 'REPLACEMENT' ? 'active' : ''}`}
                        onClick={() => setPowerSupply('REPLACEMENT')}
                      >
                        Paralela
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${powerSupply === 'MISSING' ? 'active' : ''}`}
                        onClick={() => setPowerSupply('MISSING')}
                      >
                        Ausente
                      </button>
                    </div>
                  </div>

                  {/* Toggle iOS para Cabos */}
                  <div className="toggle-row-card">
                    <div>
                      <strong>Cabos Inclusos</strong>
                      <small className="muted display-block">Cabo de rede RJ45 e fibra</small>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={cablesPresent}
                        onChange={(e) => setCablesPresent(e.target.checked)}
                      />
                      <span className="slider round" />
                    </label>
                  </div>

                  {/* Switch para Modo Registrar Próximo */}
                  <div className="toggle-row-card next-mode-glow">
                    <div>
                      <strong className="text-teal">⚡ Modo Registrar Próximo</strong>
                      <small className="muted display-block">Mantém a mesma OS e modelo para o próximo bipe</small>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={nextMode}
                        onChange={(e) => setNextMode(e.target.checked)}
                      />
                      <span className="slider round" />
                    </label>
                  </div>

                  <div className="mobile-sticky-save-bar">
                    <button
                      type="submit"
                      className="primary mobile-big-btn full-width"
                      disabled={saving}
                    >
                      {saving ? 'Gravando no Celular…' : '💾 Salvar no Dispositivo'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {/* ABA 3: MINHA CARTEIRA */}
        {navTab === 'CARTEIRA' && (
          <div className="mobile-tab-view carteira-view">
            <div className="carteira-top-bar">
              <input
                type="search"
                placeholder="Buscar por serial, modelo ou OS…"
                value={carteiraSearch}
                onChange={(e) => setCarteiraSearch(e.target.value)}
                className="mobile-search-input"
              />
            </div>

            <div className="carteira-stats-line">
              <span className="muted">{filteredCarteira?.length || 0} equipamento(s) sob sua guarda</span>
              {selectedForBatch.length > 0 && (
                <button className="link-btn" onClick={() => setSelectedForBatch([])}>Desmarcar Todos</button>
              )}
            </div>

            {filteredCarteira && filteredCarteira.length > 0 ? (
              <div className="carteira-cards-stack">
                {filteredCarteira.map((item) => {
                  const isSelected = selectedForBatch.includes(item.id)
                  return (
                    <div
                      key={item.id}
                      className={`mobile-equipment-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedForBatch((prev) =>
                          prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                        )
                      }}
                    >
                      <div className="card-checkbox">
                        <div className={`checkbox-circle ${isSelected ? 'checked' : ''}`}>
                          {isSelected && '✓'}
                        </div>
                      </div>

                      <div className="equipment-icon-col">
                        <div className="device-avatar">📡</div>
                      </div>

                      <div className="equipment-info-col">
                        <div className="equipment-title-row">
                          <strong>{item.complement?.model || 'ONU / Roteador'}</strong>
                          <span className="custody-tag">Em Custódia</span>
                        </div>

                        <div className="equipment-codes">
                          <span className="mono-code">SN: {item.barcode?.raw_value || 'Pendente OCR'}</span>
                        </div>

                        <div className="equipment-sub-meta">
                          {item.complement?.serviceOrder && (
                            <span className="os-badge">OS: {item.complement.serviceOrder}</span>
                          )}
                          <span className="date-text">{dateTime.format(new Date(item.capturedAt))}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="mobile-empty-state card">
                <span className="empty-icon">📦</span>
                <h3>Carteira Vazia</h3>
                <p className="muted">Nenhum equipamento aguardando devolução neste momento.</p>
              </div>
            )}

            {/* Floating Action Sheet quando há itens selecionados */}
            {selectedForBatch.length > 0 && (
              <div className="mobile-floating-batch-bar">
                <div className="floating-batch-info">
                  <strong>{selectedForBatch.length}</strong>
                  <span>selecionado(s)</span>
                </div>
                <button
                  type="button"
                  className="primary floating-cta-btn"
                  onClick={() => setShowCreateBatchModal(true)}
                >
                  Gerar Lote de Devolução →
                </button>
              </div>
            )}

            {/* Modal de Confirmação do Lote */}
            {showCreateBatchModal && (
              <div className="modal-overlay" onClick={() => setShowCreateBatchModal(false)}>
                <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-head">
                    <h3>Criar Lote com {selectedForBatch.length} Itens</h3>
                    <button className="close-btn" onClick={() => setShowCreateBatchModal(false)}>✕</button>
                  </div>

                  <p className="muted small-text">
                    Será gerado um código de lote e um QR Code na tela para o estoquista bipar no balcão e conferir a entrega física.
                  </p>

                  <label>
                    Depósito de Destino
                    <input type="text" readOnly value="Depósito Piloto - Sala 01" />
                  </label>

                  <label>
                    Observações de Entrega (Opcional)
                    <textarea
                      rows={2}
                      placeholder="Ex: Roteadores recolhidos na rota sul..."
                      value={batchNotes}
                      onChange={(e) => setBatchNotes(e.target.value)}
                    />
                  </label>

                  <div className="modal-actions">
                    <button onClick={() => setShowCreateBatchModal(false)}>Cancelar</button>
                    <button className="primary" onClick={() => void handleCreateBatch()}>
                      Confirmar e Gerar Lote
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ABA 4: MEUS LOTES */}
        {navTab === 'LOTES' && (
          <div className="mobile-tab-view lotes-view">
            <div className="section-header-compact">
              <h2>Meus Lotes de Entrega</h2>
              <p className="muted small-text">Toque no lote para abrir o QR Code para o conferente.</p>
            </div>

            {batches && batches.length > 0 ? (
              <div className="batches-cards-stack">
                {batches.map((batch) => {
                  const pct = batch.total_items > 0 ? Math.round((batch.accepted_items / batch.total_items) * 100) : 0
                  return (
                    <div
                      key={batch.id}
                      className="mobile-batch-card card"
                      onClick={() => setActiveBatchModal(batch)}
                    >
                      <div className="batch-card-header">
                        <div className="batch-code-block">
                          <strong>{batch.code}</strong>
                          <span className="batch-date-text">{dateTime.format(new Date(batch.created_at))}</span>
                        </div>
                        <span className={`badge status-${batch.status.toLowerCase()}`}>
                          {batch.status === 'PRESENTED' ? 'Apresentado' : batch.status === 'COMPLETED' ? 'Concluído' : batch.status}
                        </span>
                      </div>

                      <div className="batch-progress-wrapper">
                        <div className="batch-progress-bar">
                          <div className="fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="batch-progress-text">
                          {batch.accepted_items} de {batch.total_items} aceitos ({pct}%)
                        </span>
                      </div>

                      <div className="batch-card-footer">
                        <span className="tap-qr-hint">📲 Toque para ver QR Code</span>
                        <span className="arrow-right">→</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="mobile-empty-state card">
                <span className="empty-icon">📋</span>
                <h3>Nenhum Lote Criado</h3>
                <p className="muted">Selecione os roteadores na Carteira e gere um lote de devolução.</p>
              </div>
            )}

            {/* Modal do QR Code do Lote */}
            {activeBatchModal && (
              <div className="modal-overlay" onClick={() => setActiveBatchModal(null)}>
                <div className="modal-box card text-center" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-head">
                    <div>
                      <h3>{activeBatchModal.code}</h3>
                      <span className="badge badge-info">{activeBatchModal.status}</span>
                    </div>
                    <button className="close-btn" onClick={() => setActiveBatchModal(null)}>✕</button>
                  </div>

                  <div className="qr-display-box">
                    <QRCodeSVG
                      value={`newlife:batch:${activeBatchModal.id}:${activeBatchModal.code}`}
                      size={200}
                    />
                  </div>

                  <p className="muted small-text">
                    Apresente este QR Code na mesa do estoque para o conferente carregar a lista de entrega.
                  </p>

                  <div className="batch-modal-summary">
                    <div className="summary-item">
                      <span className="label">Total Declarado</span>
                      <strong className="val">{activeBatchModal.total_items} itens</strong>
                    </div>
                    <div className="summary-item">
                      <span className="label">Conferidos</span>
                      <strong className="val text-success">{activeBatchModal.accepted_items} itens</strong>
                    </div>
                  </div>

                  <button className="primary full-width" onClick={() => setActiveBatchModal(null)}>
                    Fechar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ABA 5: FILA OFFLINE */}
        {navTab === 'QUEUE' && (
          <div className="mobile-tab-view queue-view">
            <div className="offline-storage-meter card">
              <div className="meter-top-row">
                <div>
                  <strong>Armazenamento Local</strong>
                  <p className="muted small-text">{usedStorageMB} MB utilizados de 320 MB</p>
                </div>
                <span className="meter-pill">{pendingCount} fotos pendentes</span>
              </div>

              <button
                type="button"
                className="primary mobile-big-btn full-width"
                disabled={syncing}
                onClick={() => void run(true)}
              >
                {syncing ? '🔄 Enviando Fotos ao Servidor…' : '⚡ Sincronizar Agora'}
              </button>
            </div>

            <div className="queue-list-section">
              <h3>Fotos no Celular ({captures?.length || 0})</h3>
              {captures && captures.length > 0 ? (
                <div className="queue-cards-stack">
                  {captures.map((c) => (
                    <div key={c.id} className="queue-item-card card">
                      <div className="queue-item-main">
                        <strong className={`badge ${c.state === 'UPLOADED' ? 'badge-success' : 'badge-warning'}`}>
                          {c.state === 'UPLOADED' ? '✓ Enviada' : '⏳ Salva Offline'}
                        </strong>
                        <span className="mono queue-serial">
                          {c.barcode?.raw_value || 'Serial em OCR'}
                        </span>
                        <small className="muted">{dateTime.format(new Date(c.capturedAt))}</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mobile-empty-state card">
                  <p className="muted">Nenhuma foto no armazenamento do dispositivo.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3. Floating Bottom Navigation Bar Estilizada */}
      <nav className="mobile-bottom-dock">
        <button
          type="button"
          className={`dock-btn ${navTab === 'HOME' ? 'active' : ''}`}
          onClick={() => setNavTab('HOME')}
        >
          <span className="dock-icon">🏠</span>
          <span className="dock-label">Início</span>
        </button>

        <button
          type="button"
          className={`dock-btn ${navTab === 'CAPTURE' ? 'active' : ''}`}
          onClick={() => setNavTab('CAPTURE')}
        >
          <span className="dock-icon">📸</span>
          <span className="dock-label">Registrar</span>
        </button>

        <button
          type="button"
          className={`dock-btn ${navTab === 'CARTEIRA' ? 'active' : ''}`}
          onClick={() => setNavTab('CARTEIRA')}
        >
          <span className="dock-icon">💼</span>
          <span className="dock-label">Carteira</span>
        </button>

        <button
          type="button"
          className={`dock-btn ${navTab === 'LOTES' ? 'active' : ''}`}
          onClick={() => setNavTab('LOTES')}
        >
          <span className="dock-icon">📋</span>
          <span className="dock-label">Lotes</span>
        </button>

        <button
          type="button"
          className={`dock-btn ${navTab === 'QUEUE' ? 'active' : ''}`}
          onClick={() => setNavTab('QUEUE')}
        >
          <span className="dock-icon relative">
            🔄
            {pendingCount > 0 && <span className="dock-badge">{pendingCount}</span>}
          </span>
          <span className="dock-label">Fila</span>
        </button>
      </nav>
    </div>
  )
}
