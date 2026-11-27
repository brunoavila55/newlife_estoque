// Leitura mínima de planilhas .xlsx no navegador, sem dependências.
// Um .xlsx é um ZIP com XML: lemos o diretório central, descomprimimos com
// DecompressionStream('deflate-raw') e interpretamos a primeira planilha.
// A validação definitiva dos ICCIDs acontece na API.

export type SimSheetRow = {
  row: number
  iccid: string
  operator_status?: string
  subscriber?: string
  carrier?: string
  mvno_display?: string
}

export type SimSheet = {
  rows: SimSheetRow[]
  /** Linhas cujo ICCID foi salvo como número e perdeu dígitos. */
  numericIccids: number[]
  columns: Partial<Record<keyof Omit<SimSheetRow, 'row'>, string>>
}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024

class SheetError extends Error {}

function u16(view: DataView, offset: number) { return view.getUint16(offset, true) }
function u32(view: DataView, offset: number) { return view.getUint32(offset, true) }

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new SheetError('Este navegador não consegue abrir planilhas. Use o Chrome, Edge ou Safari atualizado.')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unzip(buffer: ArrayBuffer): Promise<Map<string, () => Promise<Uint8Array>>> {
  const view = new DataView(buffer)
  if (buffer.byteLength < 22 || u32(view, 0) !== 0x04034b50) {
    throw new SheetError('O arquivo não é uma planilha .xlsx. No Excel, use Salvar como › Pasta de Trabalho do Excel (.xlsx).')
  }
  let end = -1
  for (let offset = buffer.byteLength - 22; offset >= Math.max(0, buffer.byteLength - 65_557); offset--) {
    if (u32(view, offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new SheetError('A planilha está corrompida ou incompleta.')
  const count = u16(view, end + 10)
  let cursor = u32(view, end + 16)
  const decoder = new TextDecoder()
  const entries = new Map<string, () => Promise<Uint8Array>>()
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.byteLength || u32(view, cursor) !== 0x02014b50) {
      throw new SheetError('A planilha está corrompida ou usa um formato não suportado.')
    }
    const method = u16(view, cursor + 10)
    const compressed = u32(view, cursor + 20)
    const size = u32(view, cursor + 24)
    const nameLength = u16(view, cursor + 28)
    const extraLength = u16(view, cursor + 30)
    const commentLength = u16(view, cursor + 32)
    const local = u32(view, cursor + 42)
    const name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
    if (compressed === 0xffffffff || size > MAX_ENTRY_BYTES) continue
    entries.set(name, async () => {
      if (u32(view, local) !== 0x04034b50) throw new SheetError('A planilha está corrompida.')
      const start = local + 30 + u16(view, local + 26) + u16(view, local + 28)
      const data = new Uint8Array(buffer, start, compressed)
      if (method === 0) return data
      if (method === 8) return inflate(data)
      throw new SheetError('A planilha usa uma compressão não suportada.')
    })
  }
  return entries
}

async function xml(entries: Map<string, () => Promise<Uint8Array>>, path: string): Promise<Document | undefined> {
  const read = entries.get(path)
  if (!read) return undefined
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(await read()), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new SheetError('A planilha tem um XML inválido.')
  return doc
}

function elements(node: Document | Element, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS('*', name))
}

function child(node: Element, name: string): Element | undefined {
  return Array.from(node.children).find((item) => item.localName === name)
}

/** Texto de um <si> ou <is>, juntando trechos de texto formatado e ignorando a fonética. */
function richText(node: Element): string {
  return elements(node, 't')
    .filter((t) => t.parentElement?.localName !== 'rPh')
    .map((t) => t.textContent ?? '')
    .join('')
}

function columnOf(reference: string | null, fallback: number): number {
  const letters = /^([A-Z]+)/.exec(reference ?? '')?.[1]
  if (!letters) return fallback
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

type Cell = { text: string; numeric: boolean }

async function firstSheet(file: File): Promise<Cell[][]> {
  const entries = await unzip(await file.arrayBuffer())
  const workbook = await xml(entries, 'xl/workbook.xml')
  if (!workbook) throw new SheetError('Arquivo sem planilha. Confira se é um .xlsx exportado da operadora.')
  const sheet = elements(workbook, 'sheet')[0]
  const relation = sheet && Array.from(sheet.attributes).find((attribute) => attribute.localName === 'id')?.value
  const rels = await xml(entries, 'xl/_rels/workbook.xml.rels')
  let target = rels && elements(rels, 'Relationship').find((item) => item.getAttribute('Id') === relation)?.getAttribute('Target')
  if (!target) target = 'worksheets/sheet1.xml'
  const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')
  const strings = await xml(entries, 'xl/sharedStrings.xml')
  const shared = strings ? elements(strings, 'si').map(richText) : []
  const data = await xml(entries, path)
  if (!data) throw new SheetError('Não foi possível abrir a primeira aba da planilha.')
  return elements(data, 'row').map((row) => {
    const cells: Cell[] = []
    Array.from(row.children).filter((item) => item.localName === 'c').forEach((cell, index) => {
      const type = cell.getAttribute('t')
      const value = child(cell, 'v')?.textContent ?? ''
      let text: string
      if (type === 's') text = shared[Number(value)] ?? ''
      else if (type === 'inlineStr') text = child(cell, 'is') ? richText(child(cell, 'is')!) : ''
      else text = value
      cells[columnOf(cell.getAttribute('r'), index)] = { text, numeric: !type || type === 'n' }
    })
    return cells
  })
}

function plain(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

const headers: Record<keyof SimSheet['columns'], string[]> = {
  iccid: ['iccid', 'numero', 'numero do chip', 'numero iccid', 'sim card', 'chip'],
  operator_status: ['status', 'situacao'],
  subscriber: ['assinante', 'cliente'],
  carrier: ['rede', 'operadora'],
  mvno_display: ['display mvno', 'mvno'],
}

const looksLikeIccid = (value: string) => /^89\d{17,18}F?$/i.test(value.replace(/[\s-]/g, ''))

/** Lê a primeira aba e localiza as colunas pelo cabeçalho (Número/ICCID, Status, Assinante, Rede, Display MVNO). */
export async function readSimSheet(file: File): Promise<SimSheet> {
  const table = await firstSheet(file)
  let headerIndex = table.findIndex((cells) => cells.some((cell) => cell && headers.iccid.includes(plain(cell.text))))
  const positions: Partial<Record<keyof SimSheet['columns'], number>> = {}
  const columns: SimSheet['columns'] = {}
  if (headerIndex >= 0) {
    table[headerIndex].forEach((cell, index) => {
      if (!cell) return
      const name = plain(cell.text)
      for (const [field, aliases] of Object.entries(headers) as [keyof SimSheet['columns'], string[]][]) {
        if (positions[field] === undefined && aliases.includes(name)) {
          positions[field] = index
          columns[field] = cell.text.trim()
        }
      }
    })
  } else {
    // Sem cabeçalho reconhecido: usa a primeira coluna que parece ter ICCIDs.
    for (const cells of table) {
      const index = cells.findIndex((cell) => cell && looksLikeIccid(cell.text))
      if (index >= 0) { positions.iccid = index; columns.iccid = 'coluna ' + String.fromCharCode(65 + index); break }
    }
  }
  if (positions.iccid === undefined) {
    throw new SheetError('Não encontrei a coluna de ICCID. A primeira linha deve ter o título "Número" ou "ICCID".')
  }
  const rows: SimSheetRow[] = []
  const numericIccids: number[] = []
  table.slice(headerIndex + 1).forEach((cells, offset) => {
    const row = headerIndex + 2 + offset
    const iccid = cells[positions.iccid!]
    if (!iccid || !iccid.text.trim()) return
    if (iccid.numeric && /e\+?/i.test(iccid.text)) numericIccids.push(row)
    const pick = (field: keyof SimSheet['columns']) => {
      const index = positions[field]
      return index === undefined ? undefined : cells[index]?.text
    }
    rows.push({
      row,
      iccid: iccid.text.trim(),
      operator_status: pick('operator_status'),
      subscriber: pick('subscriber'),
      carrier: pick('carrier'),
      mvno_display: pick('mvno_display'),
    })
  })
  if (rows.length === 0) throw new SheetError('A planilha não tem chips abaixo do cabeçalho.')
  return { rows, numericIccids, columns }
}

export function sheetErrorMessage(error: unknown): string {
  if (error instanceof SheetError) return error.message
  return 'Não foi possível ler a planilha. Confira se o arquivo é um .xlsx válido.'
}
