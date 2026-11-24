import { ApiError, authenticated, type Receipt } from './api'
import { claim, db, settle, type Capture } from './db'

async function send(capture: Capture): Promise<void> {
  const owner = capture.owner
  const details = capture.complement
  const created = await authenticated<Receipt>(owner, '/captures', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_capture_id: capture.id,
      captured_at_device: capture.capturedAt,
      sha256: capture.sha256,
      barcode_evidence: capture.barcode,
      byte_length: capture.size,
      complement: details && {
        model: details.model,
        service_order: details.serviceOrder,
        condition: details.condition,
        power_supply: details.powerSupply,
        cables: details.cables,
        notes: details.notes,
      },
    }),
  })
  let receipt = created
  if (!created.received) {
    const photo = await db.photos.get(capture.id)
    if (!photo) throw new ApiError(400, 'LOCAL_BLOB_MISSING', 'Foto indisponível no dispositivo. Registre uma nova captura.')
    const path = '/captures/' + created.id
    receipt = await authenticated<Receipt>(owner, path + '/image', {
      method: 'PUT',
      body: photo.blob,
      headers: { 'Content-Type': photo.blob.type || 'application/octet-stream' },
    })
    if (!receipt.received) {
      receipt = await authenticated<Receipt>(owner, path + '/complete', { method: 'POST' })
    }
  }
  if (!receipt.received || receipt.id !== created.id) throw new Error('O servidor ainda não confirmou a foto.')
  await settle(capture, {
    state: 'UPLOADED', remoteId: receipt.id, remoteStatus: receipt.status,
    receivedAt: Date.now(), error: undefined, authRequired: false,
  })
}

export async function synchronize(owner: string, force: boolean): Promise<void> {
  if (navigator.locks) {
    return navigator.locks.request('newlife-upload:' + owner, { ifAvailable: true },
      async (lock) => { if (lock) await drain(owner, force, true) })
  }
  return drain(owner, force, false)
}

async function drain(owner: string, force: boolean, exclusive: boolean): Promise<void> {
  const tried = new Set<string>()
  // Limita tentativas explícitas de cada foto a uma por passagem.
  while (document.visibilityState === 'visible') {
    const capture = await claim(owner, force, tried, exclusive)
    if (!capture) return
    tried.add(capture.id)
    try {
      await send(capture)
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      const authRequired = status === 401 || status === 403
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429
        && !(error instanceof ApiError && error.code === 'IMAGE_NOT_READY')
      const delay = Math.min(5 * 60_000, 2 ** Math.min(capture.attempts, 10) * 1_000)
      await settle(capture, {
        state: permanent ? 'ACTION_REQUIRED' : 'LOCAL_PENDING',
        error: status === 0 ? 'Envio interrompido. A foto permanece salva no dispositivo.'
          : (error as Error).message,
        authRequired,
        nextAttemptAt: Date.now() + delay * (0.75 + Math.random() * 0.5),
      })
      // Falhas de rede ou autenticação afetam o restante da fila.
      if (authRequired) throw error
      if (!permanent) return
    }
  }
}

export async function refreshCapture(capture: Capture): Promise<void> {
  if (!capture.remoteId) return
  const result = await authenticated<Receipt>(capture.owner, '/captures/' + capture.remoteId)
  if (result.received && result.id === capture.remoteId) {
    await db.captures.update(capture.id, { remoteStatus: result.status })
  }
}
