import { MAX_PHOTO } from './db'

export async function preparePhoto(file: File): Promise<Blob> {
  if (file.size > 32 * 1024 * 1024) throw new Error('Selecione uma foto menor que 32 MiB.')
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  const mime = bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
    : bytes[0] === 137 && text(1, 4) === 'PNG' ? 'image/png'
    : text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' ? 'image/webp' : null
  const heic = text(4, 8) === 'ftyp' && (/hei|hev|mif/.test(text(8, 12)) || /heic|heif/i.test(file.type))
  if (!mime && !heic) throw new Error('Selecione uma foto JPEG, PNG, WebP ou HEIC compatível com o dispositivo.')

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error('O dispositivo não conseguiu abrir esta foto. Tente uma foto JPEG.')
    })
    const { naturalWidth: width, naturalHeight: height } = image
    if (mime && file.size <= MAX_PHOTO && width * height <= 24_000_000 && Math.max(width, height) <= 8192) {
      return file.slice(0, file.size, mime)
    }
    // Preserva o arquivo original quando possível. A versão JPEG só é usada para
    // imagens acima do limite ou para formatos que o servidor não recebe.
    const scale = Math.min(1, 4096 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Não foi possível preparar a imagem.')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const converted = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94))
    if (!converted || converted.size > MAX_PHOTO) throw new Error('A foto excede 12 MiB após o preparo. Faça uma nova captura.')
    return converted
  } finally {
    URL.revokeObjectURL(url)
  }
}

type DetectedCode = { rawValue: string }
type Detector = new () => { detect(image: ImageBitmapSource): Promise<DetectedCode[]> }
type ZxingReader = { decodeFromCanvas(canvas: HTMLCanvasElement): { getText(): string } }

let zxing: Promise<ZxingReader> | undefined

/** Um único leitor ZXing com TRY_HARDER: mais lento por quadro, mas lê etiquetas pequenas e inclinadas. */
function zxingReader(): Promise<ZxingReader> {
  zxing ??= Promise.all([import('@zxing/browser'), import('@zxing/library')]).then(([browser, library]) =>
    new browser.BrowserMultiFormatReader(new Map([[library.DecodeHintType.TRY_HARDER, true]])))
  return zxing
}

/**
 * Lê um código de barras do quadro. Se o leitor nativo encontrar mais de um código,
 * não escolhe nenhum: a etiqueta tem SN e MAC e o primeiro não é necessariamente o serial.
 */
export async function readFrame(canvas: HTMLCanvasElement): Promise<import('./db').BarcodeEvidence | undefined> {
  const NativeDetector = (window as Window & { BarcodeDetector?: Detector }).BarcodeDetector
  if (NativeDetector) {
    try {
      const codes = await new NativeDetector().detect(canvas)
      if (codes.length > 1) return
      if (codes.length && validBarcode(codes[0].rawValue)) {
        return { raw_value: codes[0].rawValue, source: 'BARCODE_DETECTOR' }
      }
    } catch { /* Alguns navegadores expõem a API sem implementar a leitura. */ }
  }
  try {
    const raw = (await zxingReader()).decodeFromCanvas(canvas).getText()
    if (validBarcode(raw)) return { raw_value: raw, source: 'ZXING' }
  } catch { /* Quadro sem leitura. */ }
}

export async function readBarcode(photo: Blob): Promise<import('./db').BarcodeEvidence | undefined> {
  const url = URL.createObjectURL(photo)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await readFrame(canvas)
  } catch {
    // A leitura local é complementar. A foto permanece utilizável.
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function validBarcode(raw: string): boolean {
  return !!raw.trim() && new TextEncoder().encode(raw).length <= 128 && !/\p{Cc}/u.test(raw)
}
