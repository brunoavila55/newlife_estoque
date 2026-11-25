import { Icon } from './components/icon'
import { useEffect, useRef, useState } from 'react'
import type { BarcodeEvidence } from './db'
import { readFrame } from './photo'
import { playSound } from './audio'

// Recursos de câmera fora do tipo padrão do DOM (Chrome Android; Safari ignora).
type Caps = MediaTrackCapabilities & {
  focusMode?: string[]
  exposureMode?: string[]
  pointsOfInterest?: unknown
  zoom?: { min: number; max: number; step?: number }
  focusDistance?: { min: number; max: number }
  torch?: boolean
}
type Extra = MediaTrackConstraintSet & Record<string, unknown>

// v2: a escolha automática mudou; ignora lentes salvas pela versão anterior.
const CAMERA_KEY = 'label-camera-device-v2'

function capabilities(track?: MediaStreamTrack): Caps {
  try {
    return (track?.getCapabilities?.() as Caps) ?? {}
  } catch {
    return {}
  }
}

async function apply(track: MediaStreamTrack, set: Extra) {
  try {
    await track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] })
    return true
  } catch {
    return false
  }
}

/** Pede foco e exposição contínuos quando a lente permitir. Sem isso, alguns Androids travam o foco no infinito. */
async function tune(track: MediaStreamTrack) {
  const caps = capabilities(track)
  if (caps.focusMode?.includes('continuous')) await apply(track, { focusMode: 'continuous' })
  if (caps.exposureMode?.includes('continuous')) await apply(track, { exposureMode: 'continuous' })
}

const VIDEO = { width: { ideal: 1920 }, height: { ideal: 1080 } }

function backCameras(devices: MediaDeviceInfo[]) {
  return devices.filter((item) => item.kind === 'videoinput' && !/front|frontal|user|facetime|selfie/i.test(item.label))
}

/**
 * Celulares com várias lentes traseiras expõem principal, ultra-angular e teleobjetiva.
 * Só a principal foca de perto; o navegador nem sempre abre ela. Abre cada lente uma
 * vez, compara foco automático e distância mínima de foco e fica com a melhor.
 */
async function pickBackCamera(devices: MediaDeviceInfo[]) {
  let best: { id: string; score: number } | undefined
  for (const [index, device] of devices.entries()) {
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: device.deviceId }, ...VIDEO } })
      const caps = capabilities(stream.getVideoTracks()[0])
      const autofocus = caps.focusMode?.includes('continuous') ?? false
      const nearest = caps.focusDistance?.min ?? 0.1
      const width = Number(caps.width?.max ?? 0)
      // Foco automático manda; depois, quem foca mais perto; depois, resolução; empate: ordem do sistema.
      const score = (autofocus ? 1_000_000 : 0) - Math.round(nearest * 10_000) + Math.min(width, 9999) / 10 - index
      if (!best || score > best.score) best = { id: device.deviceId, score }
    } catch {
      // Lente ocupada ou indisponível: ignora.
    } finally {
      stream?.getTracks().forEach((item) => item.stop())
    }
  }
  return best?.id
}

function describe(track: MediaStreamTrack) {
  const caps = capabilities(track)
  const settings = track.getSettings() as MediaTrackSettings & { focusMode?: string; focusDistance?: number }
  return [
    track.label || 'câmera',
    `${settings.width ?? '?'}x${settings.height ?? '?'}`,
    `foco ${settings.focusMode ?? (caps.focusMode?.join('/') || 'não informado')}`,
    caps.focusDistance ? `mín ${caps.focusDistance.min}m` : '',
  ].filter(Boolean).join(' · ')
}

function frame(video: HTMLVideoElement, maxWidth: number, crop?: { x: number; y: number; w: number; h: number }) {
  const source = crop ?? { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight }
  const scale = Math.min(1, maxWidth / Math.max(source.w, source.h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.w * scale)
  canvas.height = Math.round(source.h * scale)
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error('Aguarde a imagem da câmera.')
  context.drawImage(video, source.x, source.y, source.w, source.h, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Converte o quadro de mira da tela para pixels do vídeo (object-fit: cover), com margem. */
function targetArea(video: HTMLVideoElement, target: HTMLElement) {
  const { videoWidth: vw, videoHeight: vh } = video
  if (!vw || !vh) return
  const box = video.getBoundingClientRect()
  const aim = target.getBoundingClientRect()
  const scale = Math.max(box.width / vw, box.height / vh)
  const offsetX = (box.width - vw * scale) / 2
  const offsetY = (box.height - vh * scale) / 2
  const marginX = aim.width * 0.15
  const marginY = aim.height * 0.25
  const x = Math.max(0, (aim.left - box.left - offsetX - marginX) / scale)
  const y = Math.max(0, (aim.top - box.top - offsetY - marginY) / scale)
  const w = Math.min(vw - x, (aim.width + marginX * 2) / scale)
  const h = Math.min(vh - y, (aim.height + marginY * 2) / scale)
  return w > 16 && h > 16 ? { x, y, w, h } : undefined
}

export function LabelCamera({
  mode = 'photo',
  save,
  close,
  fallback,
  pickFromGallery,
}: {
  /** `photo` fotografa a etiqueta; `scan` só lê um código de barras e devolve. */
  mode?: 'photo' | 'scan'
  save: (file: File | undefined, evidence?: BarcodeEvidence) => Promise<boolean>
  close: () => void
  fallback?: () => void
  pickFromGallery?: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const target = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState<BarcodeEvidence>()
  const [busy, setBusy] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [zoom, setZoom] = useState<{ min: number; max: number; value: number }>()
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem(CAMERA_KEY) ?? '')
  const [focusAt, setFocusAt] = useState<{ x: number; y: number; key: number }>()
  const [shot, setShot] = useState<{ file: File; evidence?: BarcodeEvidence; url: string }>()

  const streamRef = useRef<MediaStream | null>(null)
  const lastCode = useRef('')
  const probed = useRef(false)
  const [info, setInfo] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const [probing, setProbing] = useState(false)
  const finished = useRef(false)
  // Callbacks do pai mudam a cada render; manter em ref evita reabrir a câmera.
  const saveRef = useRef(save)
  const closeRef = useRef(close)
  saveRef.current = save
  closeRef.current = close

  const track = () => streamRef.current?.getVideoTracks()[0]

  useEffect(() => {
    if (shot) return () => URL.revokeObjectURL(shot.url)
    let active = true
    let timer: number | undefined

    const stop = () => {
      streamRef.current?.getTracks().forEach((item) => item.stop())
      streamRef.current = null
    }

    const scan = async () => {
      const element = video.current
      if (!active || !element) return
      if (element.readyState >= 2 && target.current) {
        try {
          const area = targetArea(element, target.current)
          const evidence = await readFrame(frame(element, 1280, area), true)
          if (active && evidence?.raw_value) {
            if (evidence.raw_value !== lastCode.current) {
              lastCode.current = evidence.raw_value
              setCode(evidence)
              playSound('MATCHED')
              navigator.vibrate?.(60)
            }
            if (mode === 'scan' && !finished.current) {
              finished.current = true
              if (await saveRef.current(undefined, evidence)) closeRef.current()
              else finished.current = false
            }
          }
        } catch {
          // Quadro sem leitura.
        }
      }
      if (active) timer = window.setTimeout(() => void scan(), 250)
    }

    async function open() {
      setReady(false)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
            ...VIDEO,
            // Pedido já na abertura: alguns Androids ignoram o foco aplicado depois.
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          },
        })
        if (!active || !video.current) {
          stream.getTracks().forEach((item) => item.stop())
          return
        }
        streamRef.current = stream
        const current = stream.getVideoTracks()[0]

        // Os rótulos só aparecem depois da permissão concedida.
        const back = backCameras(await navigator.mediaDevices.enumerateDevices().catch(() => []))
        if (!active) return
        setCameras(back)

        // Primeira vez neste aparelho: escolhe a lente principal e lembra a escolha.
        if (!deviceId && back.length > 1 && !probed.current) {
          probed.current = true
          stop()
          setError('')
          setProbing(true)
          const chosen = await pickBackCamera(back)
          setProbing(false)
          if (!active) return
          if (chosen) {
            localStorage.setItem(CAMERA_KEY, chosen)
            setDeviceId(chosen)
            return
          }
          // Nenhuma lente respondeu ao teste: segue com a padrão.
          return void open()
        }

        video.current.srcObject = stream
        await video.current.play()
        await tune(current)
        setInfo(describe(current))

        const caps = capabilities(current)
        setHasTorch(!!caps.torch)
        setTorchOn(false)
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          const value = Number(current.getSettings()['zoom' as keyof MediaTrackSettings] ?? caps.zoom.min)
          setZoom({ min: caps.zoom.min, max: caps.zoom.max, value })
        } else setZoom(undefined)

        if (active) {
          setReady(true)
          void scan()
        }
      } catch {
        stop()
        if (!active) return
        if (deviceId) {
          // Câmera salva não existe mais neste aparelho: volta ao padrão sem novo teste.
          localStorage.removeItem(CAMERA_KEY)
          probed.current = true
          setDeviceId('')
          return
        }
        setError('Não foi possível acessar a câmera. Verifique as permissões do navegador ou escolha uma foto da galeria.')
      }
    }

    void open()
    return () => {
      active = false
      window.clearTimeout(timer)
      stop()
    }
  }, [shot, deviceId, mode])

  useEffect(() => {
    const hide = () => {
      if (document.hidden) close()
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [close])

  async function toggleTorch() {
    const current = track()
    if (!current) return
    const next = !torchOn
    if (await apply(current, { torch: next })) setTorchOn(next)
  }

  async function changeZoom() {
    const current = track()
    if (!current || !zoom) return
    // Alterna 1x → 2x → 3x: aproxima sem encostar o celular abaixo da distância mínima de foco.
    const steps = [1, 2, 3].map((item) => Math.min(zoom.max, Math.max(zoom.min, item))).filter((item, index, all) => all.indexOf(item) === index)
    const next = steps[(steps.indexOf(steps.find((item) => item >= zoom.value - 0.05) ?? steps[0]) + 1) % steps.length]
    if (await apply(current, { zoom: next })) setZoom({ ...zoom, value: next })
  }

  function switchCamera() {
    if (cameras.length < 2) return
    const currentId = track()?.getSettings().deviceId
    const index = cameras.findIndex((item) => item.deviceId === currentId)
    const next = cameras[(index + 1) % cameras.length]
    localStorage.setItem(CAMERA_KEY, next.deviceId)
    setDeviceId(next.deviceId)
  }

  /** Toque para focar: usa ponto de interesse quando suportado; senão refaz o foco automático. */
  async function focus(event: React.PointerEvent<HTMLVideoElement>) {
    const current = track()
    if (!current) return
    const box = event.currentTarget.getBoundingClientRect()
    setFocusAt({ x: event.clientX - box.left, y: event.clientY - box.top, key: Date.now() })
    const caps = capabilities(current)
    const point = { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
    if (caps.focusMode?.includes('single-shot')) {
      await apply(current, { focusMode: 'single-shot', ...(caps.pointsOfInterest ? { pointsOfInterest: [point] } : {}) })
      window.setTimeout(() => void tune(current), 1500)
    } else if (caps.pointsOfInterest) {
      await apply(current, { pointsOfInterest: [point] })
    }
  }

  async function capture() {
    if (!video.current || busy) return
    setBusy(true)
    playSound('SHUTTER')
    try {
      const canvas = frame(video.current, 4096)
      const area = target.current ? targetArea(video.current, target.current) : undefined
      const evidence = code
        ?? (area ? await readFrame(frame(video.current, 1800, area), true) : undefined)
        ?? await readFrame(canvas)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94))
      if (!blob) throw new Error()
      const file = new File([blob], 'etiqueta.jpg', { type: blob.type })
      setShot({ file, evidence, url: URL.createObjectURL(file) })
    } catch {
      setError('Não foi possível fotografar. Tente novamente.')
    } finally {
      setBusy(false)
    }
  }

  const scanning = mode === 'scan'

  return (
    <div className="mobile-viewfinder-overlay">
      <div className="viewfinder-top-bar">
        <button type="button" className="vf-icon-btn close-circle" onClick={close} title="Fechar câmera">
          <Icon name="close" />
        </button>

        <div className="vf-status-chip" role="status">
          {code ? (
            <span className="code-detected">Código: <strong>{code.raw_value}</strong></span>
          ) : (
            <span>{scanning ? 'Mire um código de barras' : 'Posicione a etiqueta no quadro'}</span>
          )}
        </div>

        {hasTorch ? (
          <button
            type="button"
            className={`vf-icon-btn ${torchOn ? 'active' : ''}`}
            onClick={() => void toggleTorch()}
            aria-label={torchOn ? 'Desligar lanterna' : 'Ligar lanterna'}
            aria-pressed={torchOn}
          >
            <Icon name="torch" />
          </button>
        ) : <span className="vf-icon-spacer" />}
      </div>

      <div className="viewfinder-center">
        {shot ? (
          <img className="viewfinder-preview-img" src={shot.url} alt="Foto capturada da etiqueta" />
        ) : (
          <div className="viewfinder-video-wrap">
            <video
              ref={video}
              muted
              playsInline
              autoPlay
              aria-label="Câmera do equipamento. Toque para focar."
              className="viewfinder-video-feed"
              onPointerDown={(event) => void focus(event)}
            />
            <div ref={target} className={`scan-target-frame ${scanning ? 'barcode' : ''} ${code ? 'locked' : ''}`}>
              <span className="corner top-left" />
              <span className="corner top-right" />
              <span className="corner bottom-left" />
              <span className="corner bottom-right" />
              <span className="aim-line" />
            </div>
            {focusAt && <span key={focusAt.key} className="vf-focus-ring" style={{ left: focusAt.x, top: focusAt.y }} />}
            <div className="vf-lens-controls">
              {zoom && (
                <button type="button" className="vf-pill-btn" onClick={() => void changeZoom()} aria-label="Alterar zoom">
                  {zoom.value.toFixed(zoom.value % 1 ? 1 : 0)}x
                </button>
              )}
              <button type="button" className="vf-pill-btn" onClick={() => setShowInfo(!showInfo)} aria-pressed={showInfo}
                aria-label="Mostrar dados da câmera">?</button>
              {cameras.length > 1 && (
                <button type="button" className="vf-pill-btn" onClick={switchCamera} aria-label="Trocar lente da câmera">
                  <Icon name="sync" /> Lente
                </button>
              )}
            </div>
            <p className="vf-hint">{probing ? 'Escolhendo a melhor lente deste celular…' : showInfo && info ? info : 'Ponha a linha vermelha sobre o código. Desfocado? Afaste um palmo e use o zoom.'}</p>
          </div>
        )}
      </div>

      {error && <p className="vf-error-toast">{error}</p>}

      <div className="viewfinder-bottom-bar">
        {shot ? (
          <div className="vf-review-actions">
            <button
              type="button"
              className="secondary vf-btn"
              disabled={busy}
              onClick={() => {
                setCode(undefined)
                lastCode.current = ''
                setError('')
                setShot(undefined)
              }}
            >
              Fotografar de novo
            </button>
            <button
              type="button"
              className="primary vf-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  if (await save(shot.file, shot.evidence)) close()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Usar esta foto
            </button>
          </div>
        ) : scanning ? (
          <p className="vf-scan-note">Ponha a linha vermelha sobre o código desejado. A leitura é automática.</p>
        ) : (
          <div className="vf-controls-row">
            {pickFromGallery ? (
              <button type="button" className="vf-gallery-thumb-btn" onClick={pickFromGallery} aria-label="Escolher da galeria">
                <Icon name="image" />
              </button>
            ) : <span />}

            <button
              type="button"
              className="vf-shutter-btn"
              disabled={busy || !ready}
              onClick={() => void capture()}
              title="Disparar foto"
            >
              <div className="vf-shutter-inner" />
            </button>

            {fallback ? (
              <button type="button" className="vf-text-btn" onClick={fallback} title="Usar câmera do celular">
                Usar câmera do celular
              </button>
            ) : <span />}
          </div>
        )}
      </div>
    </div>
  )
}
