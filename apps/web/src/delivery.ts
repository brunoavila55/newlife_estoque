// Tipos e rótulos dos lotes de devolução, compartilhados entre técnico e estoque.

export type BatchStatus = 'SUBMITTED' | 'RECEIVING' | 'CLOSED' | 'CANCELLED'

export type Identifier = { kind: string; raw_value: string }
export type Suggestion = { kind: string; raw_value: string; normalized_value: string; confidence?: number }

export type BatchSummary = {
  id: string
  number: number
  technician_id: string
  technician_name: string
  status: BatchStatus
  notes: string | null
  receipt_session_id: string | null
  clerk_name: string | null
  created_at: string
  finished_at: string | null
  total: number
  unidentified: number
  received: number
}

type CaptureRow = {
  capture_id: string
  equipment_id: string | null
  capture_status: string
  captured_at: string
  complement: { service_order?: string; notes?: string; model?: string } | null
  typed_code: string | null
  identifiers: Identifier[]
  suggestions: Suggestion[]
  received_at: string | null
}

export type BatchItem = CaptureRow & { added_by_clerk: boolean }
export type CustodyItem = CaptureRow & {
  batch_id: string | null
  batch_number: number | null
  batch_status: BatchStatus | null
}
export type BatchDetail = { batch: BatchSummary; items: BatchItem[] }
export type Page<T> = { items: T[]; next_cursor: string | null }

export const batchStatus: Record<BatchStatus, { label: string; tone: string }> = {
  SUBMITTED: { label: 'Aguardando conferência', tone: 'badge-info' },
  RECEIVING: { label: 'Em conferência', tone: 'badge-warning' },
  CLOSED: { label: 'Conferido', tone: 'badge-success' },
  CANCELLED: { label: 'Cancelado', tone: 'badge-muted' },
}

export const kindLabel: Record<string, string> = { SERIAL: 'SN', MAC: 'MAC', BARCODE: 'Código' }

export const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
export const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' })

export function batchName(batch: Pick<BatchSummary, 'number'>): string {
  return 'Lote ' + String(batch.number).padStart(4, '0')
}

/** Texto principal para identificar uma coleta: valores verificados ou, na falta, a melhor sugestão. */
export function describe(row: CaptureRow): { text: string; verified: boolean } {
  if (row.identifiers.length) {
    return { text: row.identifiers.map((item) => kindLabel[item.kind] + ' ' + item.raw_value).join(' · '), verified: true }
  }
  const hint = row.typed_code ?? row.suggestions.find((item) => item.kind === 'SERIAL')?.raw_value
    ?? row.suggestions[0]?.raw_value
  return { text: hint ? hint + ' (sugerido)' : 'Etiqueta ainda não lida', verified: false }
}

export function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

/** Situação de um item do lote, do ponto de vista de quem acompanha a entrega. */
export function itemState(item: BatchItem, status: BatchStatus): { label: string; tone: string } {
  if (item.received_at) return { label: 'Recebido', tone: 'badge-success' }
  if (status === 'CANCELLED') return { label: 'Lote cancelado', tone: 'badge-muted' }
  if (status === 'CLOSED') return { label: 'Não entregue · continua com o técnico', tone: 'badge-danger' }
  if (!item.equipment_id) return { label: 'Identificar no balcão', tone: 'badge-purple' }
  return { label: 'Aguardando bipe', tone: 'badge-info' }
}

export function jsonPost(body: object = {}): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
