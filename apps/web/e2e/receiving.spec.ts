import { expect, test } from '@playwright/test'

const technician = { id: '00000000-0000-4000-8000-000000000042', name: 'Técnica de teste', login: 'tecnica' }

test('scanner Enter ou Tab registra a leitura e a confirmação física é separada', async ({ page, context }) => {
  const id = '00000000-0000-4000-8000-000000000081'
  const equipmentId = '00000000-0000-4000-8000-000000000082'
  const date = '2026-11-23T14:00:00.000Z'
  const session = { id, technician_id: technician.id, technician_name: technician.name, warehouse_id: id,
    warehouse_name: 'Depósito piloto', opened_at: date, closed_at: null as string | null, closing_reason: null as string | null }
  const item = { equipment_id: equipmentId, matched_scan_id: null as string | null, confirmed_at: null as string | null,
    identifiers: [{ kind: 'SERIAL', raw_value: '0001-O' }] }
  const scans: { value: string; id: string; equipment_id: string | null; secondary_value: null; result: string; created_at: string }[] = []
  let confirmations = 0
  let opened = false
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/login')) return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600,
      user: { ...technician, role: 'warehouse_clerk', name: 'Estoquista', login: 'estoquista' } } })
    if (path.endsWith('/receipt-technicians')) return route.fulfill({ json: { items: [technician], next_cursor: null } })
    if (path.endsWith('/receipt-sessions')) {
      if (request.method() === 'GET') return route.fulfill({ json: { items: opened ? [session] : [], next_cursor: null } })
      expect(request.postDataJSON().technician_id).toBe(technician.id)
      opened = true
      return route.fulfill({ json: session })
    }
    if (path.endsWith('/scan')) {
      const input = request.postDataJSON()
      const matched = input.value === '0001-o'
      const scan = { id: input.client_scan_id, value: input.value, result: matched ? 'MATCHED' : 'UNKNOWN',
        equipment_id: matched ? equipmentId : null, secondary_value: null, created_at: date }
      if (matched) item.matched_scan_id = scan.id
      scans.unshift(scan)
      return route.fulfill({ json: scan })
    }
    if (path.endsWith('/items/' + equipmentId)) return route.fulfill({ json: item })
    if (path.endsWith('/confirm')) {
      expect(request.postDataJSON()).toEqual({ equipment_id: equipmentId, scan_id: item.matched_scan_id })
      confirmations++
      item.confirmed_at = date
      return route.fulfill({ json: { equipment_id: equipmentId, scan_id: item.matched_scan_id, movement_id: id, confirmed_at: date } })
    }
    if (path.endsWith('/close')) {
      session.closed_at = date
      session.closing_reason = request.postDataJSON().reason
      return route.fulfill({ json: session })
    }
    if (path.endsWith('/receipt-sessions/' + id)) {
      const totals = { expected: 1, confirmed: confirmations, missing: 1 - confirmations,
        duplicates: 0, divergences: scans.filter((scan) => scan.result !== 'MATCHED').length }
      return route.fulfill({ json: { session, totals, items: [item], scans, next_item: null, next_scan: null } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByLabel('Login').fill('estoquista')
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recebimento de equipamentos' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Técnico', exact: true }).selectOption(technician.id)
  await page.getByRole('button', { name: 'Abrir sessão' }).click()
  const scanner = page.getByLabel('Código lido', { exact: true })
  await expect(scanner).toBeFocused()
  await scanner.pressSequentially('0001-o')
  await scanner.press('Enter')
  await expect(page.getByRole('heading', { name: 'Conferir equipamento' })).toBeVisible()
  const confirm = page.getByRole('button', { name: 'Confirmar recebimento físico' })
  await expect(confirm).toBeDisabled()
  await scanner.press('Enter')
  expect(confirmations).toBe(0)
  await page.getByLabel('Conferi a etiqueta e recebi o equipamento fisicamente.').check()
  await confirm.click()
  await expect(page.getByText('Recebimento confirmado.', { exact: false })).toBeVisible()
  expect(confirmations).toBe(1)

  await page.getByRole('combobox', { name: 'Sufixo do scanner' }).selectOption('Tab')
  await scanner.fill('desconhecido')
  await scanner.press('Tab')
  await expect(page.getByRole('status').filter({ hasText: 'Código desconhecido' })).toBeVisible()
  await page.getByRole('button', { name: 'Encerrar sessão' }).click()
  const close = page.getByRole('button', { name: 'Confirmar encerramento' })
  await expect(close).toBeDisabled()
  await page.getByLabel('Justificativa (obrigatória)').fill('Código avulso separado para revisão.')
  await close.click()
  await expect(page.getByText('Sessão encerrada', { exact: false })).toBeVisible()
  await expect(page.getByText('Justificativa do encerramento:', { exact: false })).toBeVisible()
  expect(confirmations).toBe(1)
})
