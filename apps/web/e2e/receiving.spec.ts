import { expect, test, type Page } from '@playwright/test'

const technician = { id: '00000000-0000-4000-8000-000000000042', name: 'Técnica de teste', login: 'tecnica' }
const clerk = { ...technician, id: '00000000-0000-4000-8000-000000000043', role: 'warehouse_clerk', name: 'Estoquista', login: 'estoquista',
  location_id: '00000000-0000-4000-8000-000000000001' }
const city = { id: '00000000-0000-4000-8000-000000000001', name: 'São Gabriel' }
const cityMock: Record<string, unknown> = {
  '/api/v1/locations': { items: [city] },
  '/api/v1/warehouse/overview': { items: [{ ...city, technicians: 1, clerks: 1, equipment_in_stock: 0,
    equipment_with_technicians: 0, open_batches: 0, sims_in_stock: 0, sims_with_technicians: 0 }] },
  '/api/v1/me/sims': { items: [] },
}

const date = '2026-11-23T14:00:00.000Z'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Login').fill(clerk.login)
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral do estoque' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Módulos do estoque' }).getByRole('button', { name: 'Lotes para conferir' }).click()
}

test('confere um lote com o leitor: bipe, Enter confirma, inclusão, identificação pela foto e comprovante', async ({ page, context }) => {
  const sessionId = '00000000-0000-4000-8000-000000000081'
  const known = '00000000-0000-4000-8000-000000000082'
  const forgotten = '00000000-0000-4000-8000-000000000083'
  const captureId = '00000000-0000-4000-8000-000000000084'
  const batch = { id: 'b7', number: 7, technician_id: technician.id, technician_name: technician.name, status: 'SUBMITTED',
    notes: 'Pilha da manhã', receipt_session_id: null as string | null, clerk_name: null as string | null,
    created_at: date, finished_at: null, total: 2, unidentified: 1, received: 0 }
  const session = { id: sessionId, technician_id: technician.id, technician_name: technician.name, technician_whatsapp: '5511987654321', warehouse_id: 'w',
    warehouse_name: 'Depósito piloto', opened_at: date, closed_at: null as string | null, closing_reason: null as string | null,
    batch_id: batch.id, batch_number: 7, batch_notes: batch.notes }
  type Item = { equipment_id: string; matched_scan_id: string | null; confirmed_at: string | null; identifiers: { kind: string; raw_value: string }[]; inspection: unknown }
  const items: Item[] = [{ equipment_id: known, matched_scan_id: null, confirmed_at: null, identifiers: [{ kind: 'SERIAL', raw_value: '0001-O' }], inspection: null }]
  let unidentified = [{ capture_id: captureId, captured_at: date, typed_code: 'SN-FOTO-9', complement: null, suggestions: [] }]
  const scans: { id: string; value: string; result: string; equipment_id: string | null; secondary_value: null; created_at: string }[] = []
  const confirmations: unknown[] = []
  let receiveKey: string | undefined
  let included = false

  await context.route('**/private-label.png', (route) => route.fulfill({ contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X2QAAAAASUVORK5CYII=', 'base64') }))
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/login')) return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: clerk } })
    if (cityMock[path]) return route.fulfill({ json: cityMock[path] })
    if (path === '/api/v1/warehouse/batches') return route.fulfill({ json: { items: [batch], next_cursor: null } })
    if (path === '/api/v1/warehouse/batches/b7/receive') {
      const key = request.postDataJSON().client_session_id
      receiveKey ??= key
      expect(key).toBe(receiveKey)
      batch.status = 'RECEIVING'
      batch.receipt_session_id = sessionId
      return route.fulfill({ json: { batch, receipt_session_id: sessionId } })
    }
    const base = '/api/v1/receipt-sessions/' + sessionId
    if (path === base + '/scan') {
      const input = request.postDataJSON()
      const value = String(input.value).toUpperCase()
      const item = items.find((entry) => entry.identifiers.some((identifier) => identifier.raw_value.toUpperCase() === value))
      const result = item ? (item.matched_scan_id ? 'DUPLICATE_SCAN' : 'MATCHED')
        : value === 'AA:BB:CC:00:00:03' && !included ? 'NOT_IN_SESSION' : 'UNKNOWN'
      const scan = { id: input.client_scan_id, value: input.value, result, equipment_id: item?.equipment_id ?? null,
        secondary_value: null, created_at: date, capture_candidates: value === 'SN-FOTO-9' ? [captureId] : [] }
      if (item && result === 'MATCHED') item.matched_scan_id = scan.id
      scans.unshift(scan)
      return route.fulfill({ json: scan })
    }
    if (path === base + '/include') {
      expect(request.postDataJSON()).toEqual({ value: 'AA:BB:CC:00:00:03' })
      included = true
      items.push({ equipment_id: forgotten, matched_scan_id: null, confirmed_at: null, identifiers: [{ kind: 'MAC', raw_value: 'AA:BB:CC:00:00:03' }], inspection: null })
      return route.fulfill({ json: { equipment_id: forgotten } })
    }
    if (path === base + '/confirm') {
      const input = request.postDataJSON()
      confirmations.push(input)
      const item = items.find((entry) => entry.equipment_id === input.equipment_id)!
      expect(input.scan_id).toBe(item.matched_scan_id)
      item.confirmed_at = date
      item.inspection = input.inspection
      return route.fulfill({ json: { equipment_id: item.equipment_id, scan_id: input.scan_id, movement_id: 'm', confirmed_at: date } })
    }
    if (path === base + '/captures/' + captureId + '/image-url') {
      return route.fulfill({ json: { url: 'http://127.0.0.1:4173/private-label.png', expires_in: 120 } })
    }
    if (path === base + '/identify') {
      const input = request.postDataJSON()
      expect(input).toMatchObject({ capture_id: captureId, identifiers: [{ kind: 'SERIAL', raw_value: 'SN-FOTO-9' }],
        inspection: { power_supply: 'MISSING', cables_present: true, condition: 'GOOD' } })
      unidentified = []
      items.push({ equipment_id: 'new', matched_scan_id: 'auto', confirmed_at: date, identifiers: [{ kind: 'SERIAL', raw_value: 'SN-FOTO-9' }], inspection: input.inspection })
      return route.fulfill({ json: { result: 'RECEIVED', confirmation: {} } })
    }
    if (path === base + '/close') {
      session.closed_at = date
      session.closing_reason = request.postDataJSON().reason
      return route.fulfill({ json: session })
    }
    if (path === base) {
      const confirmed = items.filter((entry) => entry.confirmed_at).length
      const totals = { expected: items.length, confirmed, missing: items.length - confirmed, duplicates: 0,
        divergences: scans.filter((entry) => !['MATCHED', 'DUPLICATE_SCAN'].includes(entry.result)).length,
        unidentified: unidentified.length }
      return route.fulfill({ json: { session, totals, items, scans, next_item: null, next_scan: null, unidentified } })
    }
    return route.fulfill({ status: 404 })
  })

  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Lotes para conferir' })).toBeVisible()
  await expect(page.getByText('1 para identificar pela foto')).toBeVisible()
  await page.getByRole('button', { name: /Conferir/ }).click()
  await expect(page.getByRole('heading', { name: 'Lote 0007' })).toBeVisible()
  // Durante a conferência a busca global some para não desviar bipes.
  await expect(page.getByRole('searchbox', { name: 'Buscar por serial ou MAC' })).toHaveCount(0)

  const scanner = page.getByLabel('Bipe o equipamento')
  await expect(scanner).toBeFocused()
  await scanner.pressSequentially('0001-o')
  await scanner.press('Enter')
  await expect(page.getByText('Está no lote')).toBeVisible()
  expect(confirmations).toHaveLength(0)
  // Enter com o campo vazio confirma o item em destaque.
  await scanner.press('Enter')
  await expect(page.getByText('Recebido · SN 0001-O')).toBeVisible()
  expect(confirmations).toEqual([{ equipment_id: known, scan_id: items[0].matched_scan_id,
    inspection: { power_supply: 'ORIGINAL', cables_present: true, condition: 'GOOD' } }])
  await expect(scanner).toBeFocused()

  // Equipamento do técnico fora do lote: incluir não recebe, ainda exige confirmação.
  await scanner.fill('AA:BB:CC:00:00:03')
  await scanner.press('Enter')
  await expect(page.locator('.counter-focus').getByText('Fora do lote', { exact: true })).toBeVisible()
  await scanner.press('Enter')
  await expect(page.getByText('Está no lote')).toBeVisible()
  expect(confirmations).toHaveLength(1)
  await page.getByRole('button', { name: 'Não', exact: true }).click()
  await expect(scanner).toBeFocused()
  await scanner.press('Enter')
  await expect(page.getByText('Recebido · MAC AA:BB:CC:00:00:03')).toBeVisible()
  expect(confirmations[1]).toMatchObject({ equipment_id: forgotten, inspection: { cables_present: false } })

  // Sufixo Tab: Enter não envia a leitura.
  await page.getByLabel('Sufixo').selectOption('Tab')
  await scanner.fill('SN-FOTO-9')
  await scanner.press('Enter')
  expect(scans.filter((entry) => entry.value === 'SN-FOTO-9')).toHaveLength(0)
  await scanner.press('Tab')
  await expect(page.getByText('Identificar pela foto')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Foto da etiqueta' })).toBeVisible()
  await page.getByRole('button', { name: 'Ausente' }).click()
  await page.getByRole('button', { name: /É este equipamento/ }).click()
  await expect(page.getByText('Identificado e recebido · SN-FOTO-9')).toBeVisible()

  await scanner.fill('DESCONHECIDO')
  await scanner.press('Tab')
  await expect(page.getByText('Código não cadastrado').first()).toBeVisible()

  await page.getByRole('button', { name: 'Encerrar conferência' }).click()
  const close = page.getByRole('button', { name: 'Encerrar e gerar comprovante' })
  await expect(close).toBeDisabled()
  await page.getByLabel('Justificativa (obrigatória)').fill('Código avulso separado para revisão.')
  await close.click()
  await expect(page.getByText('Comprovante de devolução', { exact: true })).toBeVisible()
  const voucher = page.locator('.receipt-print')
  await expect(voucher.getByText('SN 0001-O')).toBeVisible()
  await expect(voucher.getByText('Código avulso separado para revisão.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Imprimir' })).toHaveCount(0)
  const whatsapp = new URL(await page.getByRole('link', { name: 'Enviar pelo WhatsApp' }).getAttribute('href') ?? '')
  expect(whatsapp.origin + whatsapp.pathname).toBe('https://web.whatsapp.com/send')
  expect(whatsapp.searchParams.get('phone')).toBe('5511987654321')
  const message = whatsapp.searchParams.get('text') ?? ''
  expect(message).toContain('*Comprovante de devolução — New Life*')
  expect(message).toContain('SN 0001-O')
  expect(message).toContain('Justificativa: Código avulso separado para revisão.')
  expect(confirmations).toHaveLength(2)
})

test('preserva a sessão diante de falta de permissão e consulta o código da busca global', async ({ page, context }) => {
  const credentials = { access_token: 'mock-token', expires_in: 3600, user: clerk }
  let refreshes = 0
  let lookups = 0
  await context.route('**/api/v1/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/login')) return route.fulfill({ json: credentials })
    if (cityMock[url.pathname]) return route.fulfill({ json: cityMock[url.pathname] })
    if (url.pathname.endsWith('/refresh')) {
      refreshes++
      return route.fulfill({ json: credentials })
    }
    if (url.pathname.endsWith('/warehouse/equipment/lookup')) {
      lookups++
      expect(url.searchParams.get('value')).toBe('0001-O')
      return lookups === 1
        ? route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta operação.' } })
        : route.fulfill({ json: { result: 'UNKNOWN' } })
    }
    if (url.pathname.endsWith('/receipt-sessions') || url.pathname.endsWith('/warehouse/batches')) {
      return route.fulfill({ json: { items: [], next_cursor: null } })
    }
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204 })
    return route.fulfill({ status: 404 })
  })

  await signIn(page)
  const search = page.getByRole('searchbox', { name: 'Buscar serial, MAC ou ICCID' })
  await search.fill('0001-O')
  await search.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Você não tem permissão para esta operação.')
  await search.press('Enter')
  await expect(page.getByRole('status')).toHaveText('Código não cadastrado.')
  expect(refreshes).toBe(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Visão geral do estoque' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Módulos do estoque' }).getByRole('button', { name: 'Lotes para conferir' }).click()
  await expect(page.getByRole('heading', { name: 'Lotes para conferir' })).toBeVisible()
  expect(refreshes).toBe(1)
  await expect(page.getByText('Nenhum lote aguardando.', { exact: false })).toBeVisible()
  const menu = page.getByRole('navigation', { name: 'Módulos do estoque' })
  await menu.getByRole('button', { name: 'Comprovantes' }).click()
  await expect(page.getByText('Nenhuma conferência registrada.')).toBeVisible()
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible()
  expect(refreshes).toBe(1)
})
