import { useEffect, useRef, useState } from 'react'
import type { BarcodeEvidence } from './db'
import { readFrame } from './photo'

function frame(video: HTMLVideoElement, maxWidth: number) {
  const scale = Math.min(1, maxWidth / Math.max(video.videoWidth, video.videoHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error('Aguarde a imagem da câmera.')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function LabelCamera({ save, close, fallback }: {
  save: (file: File, evidence?: BarcodeEvidence) => Promise<boolean>
  close: () => void
  fallback: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [shot, setShot] = useState<{ file: File; evidence?: BarcodeEvidence; url: string }>()
  useEffect(() => {
    if (shot) return () => URL.revokeObjectURL(shot.url)
    let active = true
    let stream: MediaStream | undefined
    let timer: number | undefined
    const stop = () => stream?.getTracks().forEach(track => track.stop())
    const scan = async () => {
      const element = video.current
      if (!active || !element) return
      if (element.readyState >= 2) {
        const evidence = await readFrame(frame(element, 1280))
        if (active) setCode(evidence?.raw_value ?? '')
      }
      if (active) timer = window.setTimeout(() => void scan(), 500)
    }
    async function open() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 },
        } })
        if (!active || !video.current) { stop(); return }
        video.current.srcObject = stream
        await video.current.play()
        if (active) { setReady(true); void scan() }
      } catch {
        stop()
        if (active) setError('Não foi possível abrir a câmera. Confira a permissão ou use a câmera do celular.')
      }
    }
    void open()
    return () => { active = false; window.clearTimeout(timer); stop() }
  }, [shot])

  useEffect(() => {
    const hide = () => { if (document.hidden) close() }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [close])

  async function capture() {
    if (!video.current || busy) return
    setBusy(true)
    try {
      const canvas = frame(video.current, 4096)
      const evidence = await readFrame(canvas)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .94))
      if (!blob) throw new Error()
      const file = new File([blob], 'etiqueta.jpg', { type: blob.type })
      setShot({ file, evidence, url: URL.createObjectURL(file) })
    } catch { setError('Não foi possível fotografar. Tente novamente.') }
    finally { setBusy(false) }
  }
  return <section aria-label="Leitor de código de barras">
    {shot ? <img className="review-photo" src={shot.url} alt="Foto da etiqueta para conferência" />
      : <video ref={video} muted playsInline autoPlay aria-label="Câmera da etiqueta" style={{ width: '100%' }} />}
    <p role="status">{shot ? (shot.evidence ? 'Código na foto: ' + shot.evidence.raw_value : 'Foto sem código legível.')
      : code ? 'Código na câmera: ' + code : 'Enquadre a etiqueta inteira e mantenha o código em foco.'}</p>
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      {shot ? <>
        <button disabled={busy} onClick={async () => { setBusy(true); try { if (await save(shot.file, shot.evidence)) close() } finally { setBusy(false) } }}>Salvar coleta</button>
        <button disabled={busy} onClick={() => { setReady(false); setCode(''); setError(''); setShot(undefined) }}>Fotografar novamente</button>
      </> : <>
        <button disabled={busy || !ready} onClick={() => void capture()}>Fotografar etiqueta</button>
        <button disabled={busy} onClick={fallback}>Usar câmera do celular</button>
      </>}
      <button disabled={busy} onClick={close}>Cancelar</button>
    </div>
  </section>
}
