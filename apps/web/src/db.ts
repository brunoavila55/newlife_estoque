import Dexie, { type EntityTable } from 'dexie'
import type { UserRole } from './types'

export type { UserRole }
export type User = { id: string; name: string; login: string; role?: UserRole }
export type Profile = User & { slot: 'current'; offlineUntil: number }
export type BarcodeEvidence = { raw_value: string; source: 'MANUAL' | 'BARCODE_DETECTOR' | 'ZXING' }
export type QueueState = 'LOCAL_PENDING' | 'UPLOADING' | 'UPLOADED' | 'ACTION_REQUIRED'

export type CaptureComplement = {
  model?: string
  serviceOrder?: string
  condition?: 'GOOD' | 'DAMAGED'
  powerSupply?: 'ORIGINAL' | 'REPLACEMENT' | 'MISSING'
  cables?: boolean
  notes?: string
}

export type Capture = {
  id: string
  owner: string
  capturedAt: string
  sha256: string
  size: number
  state: QueueState
  attempts: number
  nextAttemptAt: number
  lastAttemptAt?: number
  lease?: string
  leaseUntil?: number
  error?: string
  authRequired?: boolean
  remoteId?: string
  remoteStatus?: string
  receivedAt?: number
  barcode?: BarcodeEvidence
  complement?: CaptureComplement
}

type Photo = { id: string; blob: Blob; size: number }

export type StockDb = Dexie & {
  captures: EntityTable<Capture, 'id'>
  photos: EntityTable<Photo, 'id'>
  profiles: EntityTable<Profile, 'slot'>
}

const db = new Dexie('newlife-stock') as StockDb

db.version(1).stores({
  captures: 'id, owner, [owner+capturedAt]',
  photos: 'id, size',
  profiles: 'slot',
})

db.version(2).stores({
  captures: 'id, owner, [owner+capturedAt]',
  photos: 'id, size',
  profiles: 'slot',
  batches: 'id, technician_id, status, created_at, code',
  triage: 'id, equipment_id, outcome, destination, inspected_at, status',
  discrepancies: 'id, status, type, priority, created_at',
  models: 'id, manufacturer, model, active',
  notifications: 'id, read, created_at, type',
  locations: 'id, name, code',
})

// Versão 3 remove as tabelas locais de demonstração. Fotos, fila e perfis são preservados.
db.version(3).stores({
  captures: 'id, owner, [owner+capturedAt]',
  photos: 'id, size',
  profiles: 'slot',
  batches: null,
  triage: null,
  discrepancies: null,
  models: null,
  notifications: null,
  locations: null,
})

export const MAX_PHOTO = 12 * 1024 * 1024
const PHOTO_BUDGET = 320 * 1024 * 1024
const DISK_RESERVE = 24 * 1024 * 1024
const RETENTION_MS = 7 * 24 * 3600 * 1000

export async function freeSpace(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate()
    if (estimate?.quota !== undefined && estimate.usage !== undefined) {
      return Math.max(0, estimate.quota - estimate.usage)
    }
  } catch {
    // A cota do navegador ainda será aplicada na transação.
  }
  return null
}

export async function storePhoto(
  owner: string,
  blob: Blob,
  capturedAt: string,
  barcode?: BarcodeEvidence,
  complement?: CaptureComplement
): Promise<string> {
  if (blob.size === 0 || blob.size > MAX_PHOTO) {
    throw new Error('Selecione uma foto de até 12 MiB.')
  }
  const free = await freeSpace()
  if (free !== null && free < blob.size + DISK_RESERVE) {
    throw new Error('Pouco espaço. Sincronize as fotos antes de liberar espaço no dispositivo.')
  }
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const id = crypto.randomUUID()
  await db.transaction('rw', [db.captures, db.photos, db.profiles], async () => {
    const profile = await db.profiles.get('current')
    if (profile?.id !== owner || Date.now() > profile.offlineUntil) {
      throw new Error('Entre novamente para registrar a foto nesta conta.')
    }
    const pending = await db.captures.where('owner').equals(owner).filter((item) => item.state !== 'UPLOADED').count()
    const sizes = (await db.photos.orderBy('size').keys()) as number[]
    const total = sizes.reduce((sum, size) => sum + size, 0)
    if (pending >= 100 || total + blob.size > PHOTO_BUDGET) {
      throw new Error('Limite local atingido. Sincronize as fotos pendentes e libere espaço com segurança.')
    }
    await db.photos.add({ id, blob, size: blob.size })
    await db.captures.add({
      id,
      owner,
      capturedAt,
      sha256,
      barcode,
      complement,
      size: blob.size,
      state: 'LOCAL_PENDING',
      attempts: 0,
      nextAttemptAt: 0,
    })
  })
  return id
}

export async function removeExpiredPhotos(owner: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS
  await db.transaction('rw', [db.captures, db.photos], async () => {
    const expired = await db.captures
      .where('owner')
      .equals(owner)
      .filter(
        (item) =>
          item.state === 'UPLOADED' &&
          (item.receivedAt ?? Infinity) <= cutoff &&
          item.remoteStatus === 'IDENTIFIED'
      )
      .primaryKeys()
    await db.photos.bulkDelete(expired)
  })
}

export async function claim(
  owner: string,
  force: boolean,
  tried: ReadonlySet<string>,
  exclusive: boolean
): Promise<Capture | undefined> {
  return db.transaction('rw', [db.captures, db.profiles], async () => {
    const profile = await db.profiles.get('current')
    if (profile?.id !== owner) return
    const now = Date.now()
    const next = await db.captures
      .where('[owner+capturedAt]')
      .between([owner, Dexie.minKey], [owner, Dexie.maxKey])
      .filter(
        (item) =>
          !tried.has(item.id) &&
          ((item.state === 'LOCAL_PENDING' && (force || item.nextAttemptAt <= now)) ||
            (item.state === 'UPLOADING' && (exclusive || (item.leaseUntil ?? 0) <= now)) ||
            (item.state === 'ACTION_REQUIRED' && item.authRequired === true))
      )
      .first()
    if (!next) return
    const claimed: Capture = {
      ...next,
      state: 'UPLOADING',
      lease: crypto.randomUUID(),
      leaseUntil: now + 65_000,
      lastAttemptAt: now,
      attempts: next.attempts + 1,
    }
    await db.captures.put(claimed)
    return claimed
  })
}

export async function settle(capture: Capture, changes: Partial<Capture>): Promise<void> {
  await db.transaction('rw', db.captures, async () => {
    const current = await db.captures.get(capture.id)
    if (current?.lease !== capture.lease) return
    await db.captures.update(capture.id, { ...changes, lease: undefined, leaseUntil: undefined })
  })
}

export { db }
