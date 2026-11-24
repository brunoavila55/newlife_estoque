// AGENTS.md & Especificação New Life (24 Capítulos)
// Definições de Tipos e Entidades do Domínio

export type UserRole =
  | 'technician'
  | 'warehouse_clerk'
  | 'supervisor'
  | 'administrator'
  | 'auditor'
  | 'platform_admin'

export type EquipmentLifecycleStatus =
  | 'LOCAL_DRAFT'
  | 'WITH_TECHNICIAN'
  | 'BATCH_PRESENTED'
  | 'RECEIVED_IN_TRIAGE'
  | 'AVAILABLE'
  | 'MAINTENANCE'
  | 'QUARANTINE'
  | 'SCRAP'
  | 'SUPPLIER_RETURN'

export type BatchStatus =
  | 'DRAFT'
  | 'PRESENTED'
  | 'IN_CHECK'
  | 'PARTIAL'
  | 'COMPLETED'
  | 'CANCELLED'

export interface BatchItem {
  equipment_id: string
  serial: string
  mac: string
  model?: string
  status: 'PENDING' | 'ACCEPTED' | 'DIVERGENT'
  confirmed_at?: string
  divergence_reason?: string
}

export interface Batch {
  id: string
  code: string
  technician_id: string
  technician_name: string
  warehouse_id: string
  warehouse_name: string
  status: BatchStatus
  notes?: string
  items: BatchItem[]
  total_items: number
  accepted_items: number
  created_at: string
  presented_at?: string
  closed_at?: string
}

export type TriageOutcome = 'APPROVED' | 'REJECTED' | 'INCONCLUSIVE' | 'UNTESTED'
export type TriageDestination = 'AVAILABLE' | 'MAINTENANCE' | 'QUARANTINE' | 'SCRAP' | 'SUPPLIER_RETURN'

export interface TriageChecklist {
  case_condition: 'INTACT' | 'SCRATCHED' | 'BROKEN'
  connectors_condition: 'INTACT' | 'DAMAGED'
  power_supply: 'ORIGINAL' | 'REPLACEMENT' | 'MISSING' | 'FAULTY'
  cables: 'PRESENT' | 'MISSING'
  functional_test: 'POWER_ON' | 'FACTORY_RESET' | 'LIGHTS_OK' | 'NO_POWER' | 'FAILED'
  cleaning_and_reset: boolean // LGPD: higienização e limpeza de credenciais anteriores
  outcome: TriageOutcome
  destination: TriageDestination
  notes?: string
}

export interface TriageRecord {
  id: string
  equipment_id: string
  serial: string
  mac: string
  model: string
  technician_name: string
  received_at: string
  inspected_at?: string
  inspected_by?: string
  checklist?: TriageChecklist
  status: 'PENDING' | 'COMPLETED'
}

export type DiscrepancyType =
  | 'UNKNOWN_CODE'
  | 'DUPLICATE_CODE'
  | 'WRONG_TECHNICIAN'
  | 'MISSING_IN_BATCH'
  | 'DAMAGED_PHYSICAL'
  | 'UNREADABLE_LABEL'
  | 'UNBATCHED_ITEM'

export type DiscrepancyStatus =
  | 'OPEN'
  | 'IN_ANALYSIS'
  | 'AWAITING_INFO'
  | 'RESOLVED'
  | 'REOPENED'

export interface Discrepancy {
  id: string
  type: DiscrepancyType
  code_scanned: string
  equipment_id?: string
  declared_technician_id?: string
  declared_technician_name?: string
  warehouse_id: string
  warehouse_name?: string
  clerk_id: string
  clerk_name?: string
  status: DiscrepancyStatus
  priority: 'LOW' | 'MEDIUM' | 'HIGH'
  notes?: string
  resolution?: string
  resolved_by?: string
  resolved_at?: string
  created_at: string
}

export interface AssetModel {
  id: string
  manufacturer: string
  model: string
  category: 'ONT_GPON' | 'ROUTER_WIFI6' | 'ROUTER_MESH' | 'MODEM' | 'REPEATER' | 'OTHER'
  has_wifi: boolean
  ports_description: string
  label_pattern: string
  active: boolean
}

export interface WarehouseLocation {
  id: string
  name: string
  code: string
  city: string
  address?: string
  areas: string[]
}

export interface InAppNotification {
  id: string
  type: 'BATCH_PRESENTED' | 'DISCREPANCY_ALERT' | 'RETENTION_EXPIRED' | 'SESSION_CONFIRMED' | 'INFO'
  title: string
  message: string
  read: boolean
  link_module?: string
  created_at: string
}

export interface ScannerDiagnostic {
  raw_value: string
  keystroke_cadence_ms: number
  is_hardware_scanner: boolean
  terminator: 'ENTER' | 'TAB' | 'NONE'
  detected_symbology: 'CODE_128' | 'CODE_39' | 'EAN_13' | 'QR_CODE' | 'FREE_TEXT'
  mac_valid: boolean
  serial_valid: boolean
  timestamp: string
}

export interface OnboardingStep {
  id: string
  title: string
  description: string
  completed: boolean
}
