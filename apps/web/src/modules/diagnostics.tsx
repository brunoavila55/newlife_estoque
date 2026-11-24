import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { playSound } from '../audio'
import type { ScannerDiagnostic } from '../types'

export function DiagnosticsModule() {
  const [history, setHistory] = useState<ScannerDiagnostic[]>([])
  const [currentBuffer, setCurrentBuffer] = useState('')
  const [cadence, setCadence] = useState<number | null>(null)
  const [audioEnabled, setAudioEnabled] = useState(true)

  const lastKeyTime = useRef<number>(0)
  const bufferRef = useRef<string>('')
  const timingsRef = useRef<number[]>([])

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Manter foco no campo de teste
    inputRef.current?.focus()
  }, [])

  function analyzeCode(code: string, avgCadence: number, terminator: 'ENTER' | 'TAB' | 'NONE'): ScannerDiagnostic {
    const clean = code.trim()

    // Validação MAC: 12 hex caracteres (com ou sem dois pontos / traços)
    const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^[0-9A-Fa-f]{12}$/
    const isMac = macRegex.test(clean)

    // Validação Serial: Alfanumérico entre 4 e 40 caracteres, com zeros preservados
    const isSerial = clean.length >= 4 && clean.length <= 40 && !clean.includes(' ')

    // Formato de código provável
    let symbology: ScannerDiagnostic['detected_symbology'] = 'FREE_TEXT'
    if (clean.length === 13 && /^\d{13}$/.test(clean)) {
      symbology = 'EAN_13'
    } else if (clean.length > 20 && (clean.startsWith('http') || clean.includes(':'))) {
      symbology = 'QR_CODE'
    } else if (/^[A-Z0-9\-\.\ \$\/\+\%]+$/.test(clean) && clean.length <= 40) {
      symbology = 'CODE_128'
    }

    const isHardware = avgCadence > 0 && avgCadence < 35

    return {
      raw_value: clean,
      keystroke_cadence_ms: Math.round(avgCadence),
      is_hardware_scanner: isHardware,
      terminator,
      detected_symbology: symbology,
      mac_valid: isMac,
      serial_valid: isSerial,
      timestamp: new Date().toLocaleTimeString('pt-BR'),
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const now = performance.now()
    if (lastKeyTime.current > 0) {
      const diff = now - lastKeyTime.current
      timingsRef.current.push(diff)
    }
    lastKeyTime.current = now

    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const val = bufferRef.current.trim()
      if (val) {
        const sum = timingsRef.current.reduce((a, b) => a + b, 0)
        const avg = timingsRef.current.length > 0 ? sum / timingsRef.current.length : 0
        const term = e.key === 'Enter' ? 'ENTER' : 'TAB'

        const diag = analyzeCode(val, avg, term)
        setHistory((prev) => [diag, ...prev.slice(0, 19)])
        setCadence(avg)

        if (audioEnabled) {
          if (diag.mac_valid || diag.serial_valid) {
            playSound('MATCHED')
          } else {
            playSound('UNKNOWN')
          }
        }
      }

      // Reset
      bufferRef.current = ''
      timingsRef.current = []
      setCurrentBuffer('')
    }
  }

  function handleInputChange(val: string) {
    bufferRef.current = val
    setCurrentBuffer(val)
  }

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h2>Diagnóstico e Bancada de Teste de Leitores HID (Cap. 09)</h2>
          <p className="muted">
            Homologação de scanners USB HID e leitores Bluetooth em modo teclado. Medição de rajada em milissegundos,
            detecção de sufixo (Enter/Tab) e validação de padrões sem alterar o estoque.
          </p>
        </div>
        <div className="actions">
          <label className="check-label-inline">
            <input
              type="checkbox"
              checked={audioEnabled}
              onChange={(e) => setAudioEnabled(e.target.checked)}
            />
            <span>Feedback Sonoro Ativo (Web Audio API)</span>
          </label>
          <button onClick={() => setHistory([])}>Limpar Histórico de Teste</button>
        </div>
      </div>

      <div className="desk-grid">
        <section className="card diagnostic-card">
          <div className="card-header">
            <h3>Área de Captura do Leitor</h3>
            <span className="badge badge-success">● Pronto para Bipar</span>
          </div>

          <p className="muted">
            Conecte o leitor à porta USB ou emparelhe via Bluetooth. Posicione o feixe no código de barras da etiqueta
            e acione o gatilho.
          </p>

          <div className="scanner-input-box">
            <label>
              <strong>Campo de Leitura Contínua</strong>
              <input
                ref={inputRef}
                type="text"
                autoComplete="off"
                spellCheck="false"
                placeholder="Aponte o leitor e bipe aqui..."
                value={currentBuffer}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                className="input-large mono text-center"
              />
            </label>
            <small className="muted">
              Pressione Enter ou aguarde o leitor enviar o terminador automático.
            </small>
          </div>

          <div className="diagnostic-summary-grid">
            <div className="summary-box">
              <span className="label">Última Cadência</span>
              <strong className="value">
                {cadence !== null ? `${Math.round(cadence)} ms/char` : '—'}
              </strong>
              <small className="muted">
                {cadence !== null
                  ? cadence < 35
                    ? '⚡ Scanner Óptico (Alta Velocidade)'
                    : '⌨️ Digitação Manual Detectada'
                  : 'Aguardando bipe'}
              </small>
            </div>

            <div className="summary-box">
              <span className="label">Status de Homologação</span>
              <strong className="value text-success">Compatível</strong>
              <small className="muted">Sufixo Enter e Tab suportados</small>
            </div>
          </div>

          <div className="callout-box">
            <strong>Instrução para Leitores Zebra / Honeywell / Elgin:</strong>
            <p>
              Recomendamos configurar o leitor com sufixo <code>Enter</code> (Carriage Return). Desta forma o sistema
              processa o bipe instantaneamente sem necessidade de clicar na tela.
            </p>
          </div>
        </section>

        <section className="card history-card">
          <h3>Bipes Registrados na Sessão ({history.length})</h3>
          <p className="muted">Registros temporários para conferência visual do formato detectado:</p>

          {history.length === 0 ? (
            <div className="empty-state">
              Nenhum bipe registrado nesta sessão de teste. Posicione o leitor na etiqueta e acione o gatilho.
            </div>
          ) : (
            <ul className="diagnostic-list">
              {history.map((item, idx) => (
                <li key={idx} className="diagnostic-item">
                  <div className="diag-top">
                    <code className="diag-code">{item.raw_value}</code>
                    <span className="diag-time">{item.timestamp}</span>
                  </div>
                  <div className="diag-tags">
                    <span className="badge badge-info">{item.detected_symbology}</span>
                    <span className={`badge ${item.is_hardware_scanner ? 'badge-success' : 'badge-muted'}`}>
                      {item.is_hardware_scanner ? 'Leitor HID' : 'Teclado Manual'} ({item.keystroke_cadence_ms}ms)
                    </span>
                    <span className="badge badge-purple">Sufixo: {item.terminator}</span>
                    {item.mac_valid && <span className="badge badge-success">✓ Formato MAC Válido</span>}
                    {item.serial_valid && <span className="badge badge-success">✓ Formato Serial Válido</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
