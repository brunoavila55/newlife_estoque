import { Icon } from './components/icon'
import { useEffect, useRef, useState } from 'react'
import type { BarcodeEvidence } from './db'
import { readFrame } from './photo'
import { playSound } from './audio'

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

export function LabelCamera({
  save,
  close,
  fallback,
  pickFromGallery,
}: {
  save: (file: File, evidence?: BarcodeEvidence) => Promise<boolean>
  close: () => void
  fallback: () => void
  pickFromGallery: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [shot, setShot] = useState<{ file: File; evidence?: BarcodeEvidence; url: string }>()

  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (shot) return () => URL.revokeObjectURL(shot.url)
    let active = true
    let timer: number | undefined

    const stop = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    const scan = async () => {
      const element = video.current
      if (!active || !element) return
      if (element.readyState >= 2) {
        try {
          const evidence = await readFrame(frame(element, 1280))
          if (active && evidence?.raw_value) {
            setCode(evidence.raw_value)
            playSound('MATCHED')
          }
        } catch {
          // ignore scan errors
        }
      }
      if (active) timer = window.setTimeout(() => void scan(), 400)
    }

    async function open() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        })
        if (!active || !video.current) {
          stop()
          return
        }
        streamRef.current = stream
        video.current.srcObject = stream
        await video.current.play()

        // Checar suporte à lanterna
        const track = stream.getVideoTracks()[0]
        const capabilities = (track.getCapabilities?.() as any) || {}
        if (capabilities.torch) {
          setHasTorch(true)
        }

        if (active) {
          setReady(true)
          void scan()
        }
      } catch {
        stop()
        if (active) {
          setError(
            'Não foi possível acessar a câmera. Verifique as permissões do navegador ou escolha uma foto da galeria.'
          )
        }
      }
    }

    void open()
    return () => {
      active = false
      window.clearTimeout(timer)
      stop()
    }
  }, [shot])

  useEffect(() => {
    const hide = () => {
      if (document.hidden) close()
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [close])

  async function toggleTorch() {
    if (!streamRef.current) return
    const track = streamRef.current.getVideoTracks()[0]
    if (!track) return
    try {
      const next = !torchOn
      await (track.applyConstraints as any)({
        advanced: [{ torch: next }],
      })
      setTorchOn(next)
    } catch {
      // ignore torch error
    }
  }

  async function capture() {
    if (!video.current || busy) return
    setBusy(true)
    playSound('SHUTTER')
    try {
      const canvas = frame(video.current, 4096)
      const evidence = await readFrame(canvas)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.94)
      )
      if (!blob) throw new Error()
      const file = new File([blob], 'etiqueta.jpg', { type: blob.type })
      setShot({ file, evidence, url: URL.createObjectURL(file) })
    } catch {
      setError('Não foi possível fotografar. Tente novamente.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mobile-viewfinder-overlay">
      <div className="viewfinder-top-bar">
        <button
          type="button"
          className="vf-icon-btn close-circle"
          onClick={close}
          title="Fechar Câmera"
        >
          <Icon name="close" />
        </button>

        <div className="vf-status-chip">
          {code ? (
            <span className="code-detected">
              Código: <strong>{code}</strong>
            </span>
          ) : (
            <span>Posicione a etiqueta no quadro</span>
          )}
        </div>

        {hasTorch && (
          <button
            type="button"
            className={`vf-icon-btn ${torchOn ? 'active' : ''}`}
            onClick={() => void toggleTorch()}
            aria-label={torchOn ? 'Desligar lanterna' : 'Ligar lanterna'}
            aria-pressed={torchOn}
          >
            <Icon name="torch" />
          </button>
        )}
      </div>

      <div className="viewfinder-center">
        {shot ? (
          <img
            className="viewfinder-preview-img"
            src={shot.url}
            alt="Foto capturada da etiqueta"
          />
        ) : (
          <div className="viewfinder-video-wrap">
            <video
              ref={video}
              muted
              playsInline
              autoPlay
              aria-label="Câmera do equipamento"
              className="viewfinder-video-feed"
            />
            {/* Retículo de enquadramento com feixe de laser animado */}
            <div className="scan-target-frame">
              <span className="corner top-left" />
              <span className="corner top-right" />
              <span className="corner bottom-left" />
              <span className="corner bottom-right" />
            </div>
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
                setReady(false)
                setCode('')
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
        ) : (
          <div className="vf-controls-row">
            <button
              type="button"
              className="vf-gallery-thumb-btn"
              onClick={pickFromGallery}
              aria-label="Escolher da galeria"
            >
              <Icon name="image" />
            </button>

            {/* Shutter Circular estilo Câmera Nativa */}
            <button
              type="button"
              className="vf-shutter-btn"
              disabled={busy || !ready}
              onClick={() => void capture()}
              title="Disparar Foto"
            >
              <div className="vf-shutter-inner" />
            </button>

            <button
              type="button"
              className="vf-text-btn"
              onClick={fallback}
              title="Usar câmera do celular"
            >
              Usar câmera do celular
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
