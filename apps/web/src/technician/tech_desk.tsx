import { useState, useRef, useCallback, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, storePhoto, freeSpace, type Capture, type Profile, type User } from '../db'
import { preparePhoto, readBarcode, validBarcode } from '../photo'
import { LabelCamera } from '../label-camera'
import type { BarcodeEvidence } from '../db'
import { QRCodeSVG } from '../components/qrcode'
import { playSound } from '../audio'
import { ApiError, authenticated } from '../api'

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

interface TechDeskProps {
  profile: Profile
  deny: () => void
  syncing: boolean
  run: (force: boolean) => Promise<void>
  leaveDesk: () => Promise<void>
}

export function TechDesk({ profile, deny, syncing, run, leaveDesk }: TechDeskProps) {
  // Navigation tabs for the technician
  const [navTab, setNavTab] = useState<'HOME' | 'CAPTURE' | 'CARTEIRA' | 'LOTES' | 'QUEUE'>('HOME')

  const [notice, setNotice] = useState('')
  const [success, setSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [lowSpace, setLowSpace] = useState(false)

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
  const [nextMode, setNextMode] = useState(false) // Modo registrar próximo

  const [liveCamera, setLiveCamera] = useState(false)
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<File | null>(null)

  // Carteira multi-selection state for creating a batch
  const [selectedForBatch, setSelectedForBatch] = useState<string[]>([])
  const [batchNotes, setBatchNotes] = useState('')
  const [showCreateBatchModal, setShowCreateBatchModal] = useState(false)
  const [activeBatchModal, setActiveBatchModal] = useState<any>(null)

  const cameraInputRef = useRef<HTMLInputElement>(null)
  const pickerInputRef = useRef<HTMLInputElement>(null)

  // Database queries
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
    const free = await freeSpace()
    setLowSpace(free !== null && free < 40 * 1024 * 1024)
  }, [])

  useEffect(() => {
    void checkSpace()
  }, [checkSpace])

  // Normalização visual de MAC Address em tempo real
  function handleMacChange(val: string) {
    const clean = val.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 12)
    const formatted = clean.match(/.{1,2}/g)?.join(':') || clean
    setMacAddress(formatted)
  }

  // Capturar foto e abrir tela de revisão complementar
  async function handlePhotoSelected(file?: File, liveEvidence?: BarcodeEvidence) {
    if (!file) return
    setCurrentFile(file)
    setPreviewBlobUrl(URL.createObjectURL(file))
    setLiveCamera(false)

    // Se detectou código com leitor na câmera
    if (liveEvidence) {
      const code = liveEvidence.raw_value.trim()
      if (/^[0-9A-Fa-f]{12}$/.test(code.replace(/[:-]/g, ''))) {
        handleMacChange(code)
      } else {
        setSerialNumber(code)
      }
    }
  }

  // Salvar foto com metadados complementares
  async function handleSaveCapture() {
    if (!currentFile) {
      alert('Nenhuma foto foi capturada.')
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

      await storePhoto(
        profile.id,
        photo,
        capturedAt,
        evidence,
        {
          model: selectedModel,
          serviceOrder: serviceOrder.trim() || undefined,
          condition,
          powerSupply,
          cables: cablesPresent,
          notes: notes.trim() || undefined,
        }
      )

      playSound('SHUTTER')

      if (nextMode) {
        // Produtividade: mantém a mesma OS e modelo, mas limpa serial e MAC para o próximo
        setSerialNumber('')
        setMacAddress('')
        setBarcode('')
        setCurrentFile(null)
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
        setPreviewBlobUrl(null)
        setSuccess('Salvo! Pronto para fotografar o próximo equipamento desta OS.')
      } else {
        // Reset completo
        setSerialNumber('')
        setMacAddress('')
        setBarcode('')
        setNotes('')
        setCurrentFile(null)
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
        setPreviewBlobUrl(null)
        setSuccess('Equipamento registrado com sucesso no dispositivo.')
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

  // Criar lote a partir dos itens selecionados na carteira
  async function handleCreateBatch() {
    if (selectedForBatch.length === 0) {
      alert('Selecione ao menos um equipamento para criar o lote.')
      return
    }
    const batchId = crypto.randomUUID()
    const code = `LOTE-${new Date().toISOString().slice(2, 7).replace('-', '')}-${Math.floor(100 + Math.random() * 900)}`

    // Itens selecionados da carteira
    const selectedCaptures = captures?.filter((c) => selectedForBatch.includes(c.id)) || []
    const batchItems = selectedCaptures.map((c) => ({
      equipment_id: c.remoteId || c.id,
      serial: c.barcode?.raw_value || 'SN-PENDENTE',
      mac: 'E0:D9:E3:...',
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
      status: 'PRESENTED', // Apresentado no balcão
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
    alert(`Lote ${code} gerado com sucesso! Apresente o QR Code no balcão do estoque.`)
  }

  return (
    <div className="tech-mobile-container">
      {/* Topbar móvel */}
      <header className="tech-topbar">
        <div className="tech-profile-info">
          <span className="tech-greeting">Olá, {profile.name.split(' ')[0]}!</span>
          <span className="tech-sub-status">Técnico em Campo · Unidade Piloto</span>
        </div>
        <button
          className="exit-btn-small"
          onClick={() => (pendingCount > 0 ? setConfirmLeave(true) : void leaveDesk())}
        >
          {navigator.onLine ? 'Sair' : 'Bloquear'}
        </button>
      </header>

      {/* Alerta de confirmação de saída com fotos pendentes */}
      {confirmLeave && (
        <section className="card exit-confirm-card">
          <p>
            Há <strong>{pendingCount} foto(s) pendente(s)</strong> a enviar. Elas ficarão guardadas com segurança no
            dispositivo até você entrar novamente.
          </p>
          <div className="actions">
            <button onClick={() => setConfirmLeave(false)}>Continuar Conectado</button>
            <button className="danger-btn" onClick={() => void leaveDesk()}>
              Sair e Manter Fotos
            </button>
          </div>
        </section>
      )}

      {notice && <p className="alert">{notice}</p>}
      {success && <p className="success">{success}</p>}
      {lowSpace && (
        <p className="alert">
          ⚠️ Pouco espaço no celular. Conecte-se à internet para sincronizar as fotos pendentes.
        </p>
      )}

      {/* CONTEÚDO PRINCIPAL BASEADO NA TAB ATIVA */}
      <main className="tech-main-content">
        {/* TAB 1: INÍCIO (DASHBOARD DO TÉCNICO) */}
        {navTab === 'HOME' && (
          <div className="tech-home-view">
            <div className="tech-kpi-banner card">
              <div className="kpi-banner-top">
                <div>
                  <span className="banner-label">Sob Sua Custódia</span>
                  <h2 className="banner-number">{identifiedCount + pendingCount} equipamentos</h2>
                </div>
                <div className="retention-indicator">
                  <span className="badge badge-success">4 dias em posse</span>
                </div>
              </div>
              <p className="muted small-text">
                {pendingCount > 0
                  ? `⚡ ${pendingCount} foto(s) aguardando sincronização`
                  : '✓ Todas as fotos sincronizadas com o servidor'}
              </p>

              <button
                className="primary large-cta-btn"
                onClick={() => setNavTab('CAPTURE')}
              >
                📸 Registrar Novo Equipamento
              </button>
            </div>

            <div className="tech-quick-shortcuts">
              <div className="shortcut-card" onClick={() => setNavTab('CARTEIRA')}>
                <span className="shortcut-icon">💼</span>
                <strong>Minha Carteira</strong>
                <small className="muted">{identifiedCount} identificados</small>
              </div>

              <div className="shortcut-card" onClick={() => setNavTab('LOTES')}>
                <span className="shortcut-icon">📋</span>
                <strong>Meus Lotes</strong>
                <small className="muted">{batches?.length || 0} lote(s) criados</small>
              </div>

              <div className="shortcut-card" onClick={() => setNavTab('QUEUE')}>
                <span className="shortcut-icon">🔄</span>
                <strong>Fila de Fotos</strong>
                <small className="muted">{pendingCount} pendente(s)</small>
              </div>
            </div>

            <div className="card guide-quick-card">
              <h4>Dica de Produtividade em Campo</h4>
              <p className="muted small-text">
                Fotografe a etiqueta nítida. Se for recolher mais de um roteador no mesmo cliente, ative o modo{' '}
                <em>"Registrar próximo"</em> para manter a mesma Ordem de Serviço preenchida automaticamente.
              </p>
            </div>
          </div>
        )}

        {/* TAB 2: REGISTRAR EQUIPAMENTO (CÂMERA, OCR E CADASTRO COMPLEMENTAR) */}
        {navTab === 'CAPTURE' && (
          <div className="tech-capture-view">
            {!previewBlobUrl ? (
              <div className="card camera-choice-card">
                <h3>Fotografar Etiqueta do Equipamento</h3>
                <p className="muted">
                  Enquadre os códigos de barras, número de série (SN) e endereço MAC com boa iluminação.
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
                  <div className="camera-actions-vertical">
                    <button
                      className="primary large-btn"
                      onClick={() =>
                        typeof navigator.mediaDevices?.getUserMedia === 'function'
                          ? setLiveCamera(true)
                          : cameraInputRef.current?.click()
                      }
                    >
                      📷 Abrir Câmera Traseira
                    </button>
                    <button onClick={() => pickerInputRef.current?.click()}>
                      📁 Escolher da Galeria
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
              /* TELA DE REVISÃO E CADASTRO COMPLEMENTAR (Capítulo 04 & 05) */
              <div className="card review-complement-card">
                <div className="review-top-bar">
                  <h3>Revisão e Cadastro da Coleta</h3>
                  <button
                    className="small-btn"
                    onClick={() => {
                      setCurrentFile(null)
                      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl)
                      setPreviewBlobUrl(null)
                    }}
                  >
                    Tirar Outra Foto
                  </button>
                </div>

                <div className="photo-preview-box">
                  <img src={previewBlobUrl} alt="Foto da Etiqueta" className="label-preview-img" />
                </div>

                <form onSubmit={(e) => { e.preventDefault(); void handleSaveCapture() }} className="complement-form">
                  <div className="form-section-title">Identificadores da Etiqueta</div>

                  <label>
                    Número de Série (SN / S/N)
                    <input
                      type="text"
                      className="mono"
                      placeholder="Ex: 48575443F89A1201"
                      value={serialNumber}
                      onChange={(e) => setSerialNumber(e.target.value.toUpperCase())}
                    />
                    <small className="muted">Zeros à esquerda são estritamente preservados.</small>
                  </label>

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

                  <div className="form-section-title">Dados Complementares de Recolhimento</div>

                  <label>
                    Modelo do Equipamento
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                    >
                      {models?.map((m) => (
                        <option key={m.id} value={`${m.manufacturer} ${m.model}`}>
                          {m.manufacturer} - {m.model}
                        </option>
                      ))}
                      <option value="Outro Modelo">Outro / Não listado</option>
                    </select>
                  </label>

                  <label>
                    Nº da Ordem de Serviço (OS) / Cliente
                    <input
                      type="text"
                      placeholder="Ex: OS-98124 ou Nome do Assinante"
                      value={serviceOrder}
                      onChange={(e) => setServiceOrder(e.target.value)}
                    />
                  </label>

                  <div className="form-grid-2">
                    <label>
                      Condição da Carcaça
                      <select
                        value={condition}
                        onChange={(e) => setCondition(e.target.value as any)}
                      >
                        <option value="GOOD">Bom Estado / Sem Danos</option>
                        <option value="DAMAGED">Avariado / Quebrado</option>
                      </select>
                    </label>

                    <label>
                      Fonte de Alimentação
                      <select
                        value={powerSupply}
                        onChange={(e) => setPowerSupply(e.target.value as any)}
                      >
                        <option value="ORIGINAL">Original Presente</option>
                        <option value="REPLACEMENT">Paralela Homologada</option>
                        <option value="MISSING">Ausente</option>
                      </select>
                    </label>
                  </div>

                  <label className="check-label-inline">
                    <input
                      type="checkbox"
                      checked={cablesPresent}
                      onChange={(e) => setCablesPresent(e.target.checked)}
                    />
                    <span>Cabos de rede e energia inclusos</span>
                  </label>

                  <label>
                    Observações de Campo
                    <textarea
                      rows={2}
                      placeholder="Ex: Retirado por cancelamento de contrato, cliente entregou na caixa..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </label>

                  {/* Toggle Modo Próximo Equipamento (Produtividade) */}
                  <div className="next-mode-box">
                    <label className="check-label-inline">
                      <input
                        type="checkbox"
                        checked={nextMode}
                        onChange={(e) => setNextMode(e.target.checked)}
                      />
                      <div>
                        <strong>Modo Registrar Próximo (Produtividade)</strong>
                        <small className="muted">
                          Mantém a mesma OS e modelo preenchidos para você bipar o próximo aparelho do cliente.
                        </small>
                      </div>
                    </label>
                  </div>

                  <div className="actions form-actions-sticky">
                    <button
                      type="submit"
                      className="primary large-btn full-width"
                      disabled={saving}
                    >
                      {saving ? 'Gravando no Celular…' : '💾 Salvar Equipamento'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: MINHA CARTEIRA (COM SELEÇÃO PARA CRIAR LOTE) */}
        {navTab === 'CARTEIRA' && (
          <div className="tech-carteira-view">
            <div className="section-head">
              <div>
                <h3>Minha Carteira em Campo</h3>
                <p className="muted">Equipamentos sob sua responsabilidade aguardando devolução no estoque.</p>
              </div>
              {selectedForBatch.length > 0 && (
                <button
                  className="primary"
                  onClick={() => setShowCreateBatchModal(true)}
                >
                  Criar Lote ({selectedForBatch.length})
                </button>
              )}
            </div>

            {captures && captures.length > 0 ? (
              <ul className="items-list-cards">
                {captures.map((item) => {
                  const isSelected = selectedForBatch.includes(item.id)
                  return (
                    <li
                      key={item.id}
                      className={`card carteira-item-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedForBatch((prev) =>
                          prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                        )
                      }}
                    >
                      <div className="card-selection-checkbox">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                        />
                      </div>
                      <div className="carteira-item-info">
                        <strong>{item.complement?.model || 'ONU / Roteador'}</strong>
                        <div className="mono-codes">
                          <span>SN: {item.barcode?.raw_value || 'Identificando...'}</span>
                        </div>
                        {item.complement?.serviceOrder && (
                          <small className="muted">OS: {item.complement.serviceOrder}</small>
                        )}
                        <small className="muted">Coletado em: {dateTime.format(new Date(item.capturedAt))}</small>
                      </div>
                      <div className="carteira-item-status">
                        <span className="badge badge-info">Em Posse</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="empty-state">
                Você não possui equipamentos sob custódia no momento.
              </div>
            )}

            {/* Modal de Criação de Lote */}
            {showCreateBatchModal && (
              <div className="modal-overlay" onClick={() => setShowCreateBatchModal(false)}>
                <div className="modal-box card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-head">
                    <h3>Criar Lote de Devolução (Cap. 07)</h3>
                    <button className="close-btn" onClick={() => setShowCreateBatchModal(false)}>
                      ✕
                    </button>
                  </div>
                  <p className="muted">
                    Será gerado um código e QR Code com os <strong>{selectedForBatch.length} equipamentos</strong>{' '}
                    selecionados para você apresentar na mesa do estoquista.
                  </p>

                  <label>
                    Depósito de Destino
                    <input type="text" readOnly value="Depósito Piloto - Sala 01" />
                  </label>

                  <label>
                    Observações da Entrega (Opcional)
                    <textarea
                      rows={3}
                      placeholder="Ex: Recolhidos na rota da zona leste, todos com fonte..."
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

        {/* TAB 4: MEUS LOTES DE DEVOLUÇÃO */}
        {navTab === 'LOTES' && (
          <div className="tech-lotes-view">
            <div className="section-head">
              <div>
                <h3>Meus Lotes de Entrega</h3>
                <p className="muted">Toque no lote para abrir o QR Code e apresentar na mesa de conferência.</p>
              </div>
            </div>

            {batches && batches.length > 0 ? (
              <ul className="items-list-cards">
                {batches.map((batch) => (
                  <li
                    key={batch.id}
                    className="card batch-card-mobile"
                    onClick={() => setActiveBatchModal(batch)}
                  >
                    <div className="batch-card-top">
                      <strong>{batch.code}</strong>
                      <span className="badge badge-info">{batch.status}</span>
                    </div>
                    <p className="muted small-text">
                      {batch.total_items} equipamento(s) · Destino: {batch.warehouse_name}
                    </p>
                    <div className="progress-cell">
                      <div className="progress-bar-small">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${batch.total_items > 0 ? Math.round((batch.accepted_items / batch.total_items) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <small className="muted">
                        {batch.accepted_items}/{batch.total_items} confirmados
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">
                Nenhum lote criado ainda. Vá até a aba <em>Minha Carteira</em>, selecione os equipamentos e clique em{' '}
                <em>Criar Lote</em>.
              </div>
            )}

            {/* Modal Visualização do QR Code do Lote */}
            {activeBatchModal && (
              <div className="modal-overlay" onClick={() => setActiveBatchModal(null)}>
                <div className="modal-box card text-center" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-head">
                    <h3>Lote {activeBatchModal.code}</h3>
                    <button className="close-btn" onClick={() => setActiveBatchModal(null)}>
                      ✕
                    </button>
                  </div>

                  <div className="qr-container-mobile">
                    <QRCodeSVG
                      value={`newlife:batch:${activeBatchModal.id}:${activeBatchModal.code}`}
                      size={180}
                    />
                  </div>
                  <p className="muted small-text">
                    Apresente este QR Code para o estoquista bipar na central desktop.
                  </p>

                  <div className="batch-modal-stats">
                    <p>
                      <strong>Status:</strong> {activeBatchModal.status}
                    </p>
                    <p>
                      <strong>Itens:</strong> {activeBatchModal.accepted_items} de {activeBatchModal.total_items} aceitos
                    </p>
                  </div>

                  <button className="full-width" onClick={() => setActiveBatchModal(null)}>
                    Fechar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 5: FILA DE FOTOS OFFLINE */}
        {navTab === 'QUEUE' && (
          <div className="tech-queue-view">
            <div className="section-head">
              <div>
                <h3>Fila de Sincronização Local</h3>
                <p className="muted">{pendingCount} foto(s) salvas no celular.</p>
              </div>
              <button
                className="primary"
                disabled={syncing}
                onClick={() => void run(true)}
              >
                {syncing ? 'Sincronizando…' : '🔄 Sincronizar Agora'}
              </button>
            </div>

            {captures && captures.length > 0 ? (
              <ul className="items-list-compact">
                {captures.map((capture) => (
                  <li key={capture.id} className="queue-row-card card">
                    <div className="queue-row-info">
                      <strong className={`badge ${capture.state === 'UPLOADED' ? 'badge-success' : 'badge-warning'}`}>
                        {capture.state === 'UPLOADED' ? 'Enviada ao Servidor' : 'Salva no Celular (Offline)'}
                      </strong>
                      <div className="mono small-text">
                        {capture.barcode?.raw_value || 'Serial em processamento'}
                      </div>
                      <small className="muted">{dateTime.format(new Date(capture.capturedAt))}</small>
                      {capture.error && <p className="alert small-text">{capture.error}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">Nenhuma foto salva no dispositivo.</div>
            )}
          </div>
        )}
      </main>

      {/* BOTTOM NAVIGATION BAR PARA MOBILE (Capítulo 12) */}
      <nav className="tech-bottom-nav">
        <button
          className={`nav-btn ${navTab === 'HOME' ? 'active' : ''}`}
          onClick={() => setNavTab('HOME')}
        >
          <span className="nav-icon">🏠</span>
          <span className="nav-label">Início</span>
        </button>

        <button
          className={`nav-btn ${navTab === 'CAPTURE' ? 'active' : ''}`}
          onClick={() => setNavTab('CAPTURE')}
        >
          <span className="nav-icon">📸</span>
          <span className="nav-label">Registrar</span>
        </button>

        <button
          className={`nav-btn ${navTab === 'CARTEIRA' ? 'active' : ''}`}
          onClick={() => setNavTab('CARTEIRA')}
        >
          <span className="nav-icon">💼</span>
          <span className="nav-label">Carteira</span>
        </button>

        <button
          className={`nav-btn ${navTab === 'LOTES' ? 'active' : ''}`}
          onClick={() => setNavTab('LOTES')}
        >
          <span className="nav-icon">📋</span>
          <span className="nav-label">Lotes</span>
        </button>

        <button
          className={`nav-btn ${navTab === 'QUEUE' ? 'active' : ''}`}
          onClick={() => setNavTab('QUEUE')}
        >
          <span className="nav-icon">🔄</span>
          <span className="nav-label">Fila ({pendingCount})</span>
        </button>
      </nav>
    </div>
  )
}
