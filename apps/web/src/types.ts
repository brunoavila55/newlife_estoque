export type UserRole = 'technician' | 'warehouse_clerk' | 'administrator'

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
