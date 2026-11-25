import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/icon'
import { LabelCamera } from '../label-camera'
import { storePhoto, type BarcodeEvidence } from '../db'
import { preparePhoto, readBarcode, validBarcode } from '../photo'
import { playSound } from '../audio'

/** Fotografar a etiqueta e salvar no celular. O envio acontece pela fila. */
export function CaptureTab({ owner, saved, savedToday }: {
  owner: string
  saved: () => void
  savedToday: number
}) {
  const [file, setFile] = useState<File>()
  const [preview, setPreview] = useState<string>()
  const [evidence, setEvidence] = useState<BarcodeEvidence>()
  const [code, setCode] = useState('')
  const [serviceOrder, setServiceOrder] = useState('')
  const [notes, setNotes] = useState('')
  const [liveCamera, setLiveCamera] = useState(false)
  const [scanner, setScanner] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  function choose(next?: File, detected?: BarcodeEvidence) {
    if (!next) return
    setFile(next)
    setPreview(URL.createObjectURL(next))
    setEvidence(detected)
    setCode(detected?.raw_value ?? '')
    setLiveCamera(false)
    setError('')
    setDone('')
  }

  function openCamera() {
    if (typeof navigator.mediaDevices?.getUserMedia === 'function') setLiveCamera(true)
    else cameraInput.current?.click()
  }

  function discard() {
    setFile(undefined)
    setPreview(undefined)
    setEvidence(undefined)
    setCode('')
    setNotes('')
  }

  async function save(next: boolean) {
    if (!file || saving) return
    setSaving(true)
    setError('')
    try {
      void navigator.storage?.persist?.().catch(() => false)
      const typed = code.trim()
      if (typed && !validBarcode(typed)) {
        throw new Error('Confira o código. Use até 128 caracteres, sem símbolos de controle.')
      }
      const photo = await preparePhoto(file)
      const proof: BarcodeEvidence | undefined = typed
        ? (evidence && evidence.raw_value === typed ? evidence : { raw_value: typed, source: 'MANUAL' })
        : await readBarcode(photo)
      await storePhoto(owner, photo, new Date().toISOString(), proof, {
        serviceOrder: serviceOrder.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      playSound('SHUTTER')
      discard()
      setDone(next ? 'Salvo no celular. Fotografe o próximo.' : 'Salvo no celular.')
      saved()
      if (next) openCamera()
    } catch (failure) {
      setError(failure instanceof Error && failure.name === 'QuotaExceededError'
        ? 'A foto não foi salva por falta de espaço. Envie as fotos pendentes antes de liberar espaço.'
        : failure instanceof Error ? failure.message : 'Não foi possível salvar a foto.')
    } finally {
      setSaving(false)
    }
  }

  const inputs = <>
    <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden
      onChange={(event) => { choose(event.target.files?.[0]); event.target.value = '' }} />
    <input ref={galleryInput} type="file" accept="image/*" hidden
      onChange={(event) => { choose(event.target.files?.[0]); event.target.value = '' }} />
  </>

  if (scanner) {
    return <div className="tech-view">
      <LabelCamera
        mode="scan"
        close={() => setScanner(false)}
        save={async (_photo, detected) => {
          if (!detected) return false
          setEvidence(detected)
          setCode(detected.raw_value)
          return true
        }}
      />
    </div>
  }

  if (liveCamera) {
    return <div className="tech-view">
      <LabelCamera
        close={() => setLiveCamera(false)}
        fallback={() => { setLiveCamera(false); cameraInput.current?.click() }}
        pickFromGallery={() => { setLiveCamera(false); galleryInput.current?.click() }}
        save={async (photo, detected) => { if (!photo) return false; choose(photo, detected); return true }}
      />
      {inputs}
    </div>
  }

  if (!file || !preview) {
    return <div className="tech-view">
      <header className="tech-view-head">
        <h1>Coletar</h1>
        <p className="muted">Fotografe a etiqueta de cada roteador recolhido. Funciona sem internet.</p>
      </header>
      {done && <p className="success" role="status">{done}</p>}
      <button type="button" className="primary tech-capture-cta" onClick={openCamera}>
        <Icon name="camera" /> Fotografar etiqueta
      </button>
      <button type="button" className="tech-secondary-cta" onClick={() => galleryInput.current?.click()}>
        <Icon name="image" /> Escolher da galeria
      </button>
      {savedToday > 0 && <p className="tech-tally"><strong>{savedToday}</strong> foto{savedToday > 1 ? 's' : ''} hoje</p>}
      <ul className="tech-tips">
        <li>Enquadre a etiqueta inteira, com o serial e o MAC legíveis.</li>
        <li>Quando terminar o dia, vá em <strong>Comigo</strong> e monte o lote para entregar.</li>
      </ul>
      {inputs}
    </div>
  }

  return <div className="tech-view">
    <header className="tech-view-head row">
      <h1>Conferir foto</h1>
      <button type="button" className="small-btn" onClick={discard} disabled={saving}>Descartar</button>
    </header>
    <img src={preview} alt="Etiqueta fotografada" className="tech-preview" />
    <form className="tech-form" onSubmit={(event) => { event.preventDefault(); void save(true) }}>
      <div className="tech-code-field">
        <label>Código da etiqueta <span className="muted">(opcional)</span>
          <input className="mono" value={code} maxLength={128} autoCapitalize="characters" spellCheck={false}
            placeholder="Serial ou MAC" onChange={(event) => setCode(event.target.value)} />
        </label>
        {typeof navigator.mediaDevices?.getUserMedia === 'function' &&
          <button type="button" className="small-btn" disabled={saving} onClick={() => setScanner(true)}
            aria-label="Ler código de barras com a câmera"><Icon name="scan" /> Ler</button>}
      </div>
      {evidence && code === evidence.raw_value && <p className="muted small-text">Código lido pela câmera. Confira antes de salvar.</p>}
      <label>Ordem de serviço <span className="muted">(opcional)</span>
        <input value={serviceOrder} maxLength={160} placeholder="Mantida para as próximas fotos"
          onChange={(event) => setServiceOrder(event.target.value)} />
      </label>
      <label>Observação <span className="muted">(opcional)</span>
        <textarea value={notes} maxLength={2000} rows={2} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="tech-form-actions">
        <button type="submit" className="primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar e fotografar próximo'}</button>
        <button type="button" disabled={saving} onClick={() => void save(false)}>Salvar e parar</button>
      </div>
    </form>
  </div>
}
