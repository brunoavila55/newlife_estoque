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
      expect(request.postDataJSON()).toEqual({ equipment_id: equipmentId, scan_id: item.matched_scan_id, inspection: { power_supply: 'ORIGINAL', cables_present: true, condition: 'GOOD' } })
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
  await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
  await page.getByRole('navigation', { name: 'Módulos do estoque' }).getByRole('button', { name: 'Mesa de recebimento', exact: true }).click()
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
  await page.getByRole('combobox', { name: 'Fonte', exact: true }).selectOption('ORIGINAL')
  await page.getByRole('combobox', { name: 'Cabos', exact: true }).selectOption('yes')
  await page.getByRole('combobox', { name: 'Conservação', exact: true }).selectOption('GOOD')
  await confirm.click()
  await expect(page.getByText('Recebimento confirmado.', { exact: false })).toBeVisible()
  expect(confirmations).toBe(1)

  await page.getByRole('combobox', { name: 'Sufixo do scanner' }).selectOption('Tab')
  await scanner.fill('desconhecido')
  await scanner.press('Enter')
  await expect(scanner).toHaveValue('desconhecido')
  expect(scans).toHaveLength(1)
  await scanner.press('Tab')
  await expect(page.getByRole('status').filter({ hasText: 'Código desconhecido' })).toBeVisible()
  await page.getByRole('button', { name: 'Encerrar sessão' }).click()
  const close = page.getByRole('button', { name: 'Confirmar encerramento' })
  await expect(close).toBeDisabled()
  await page.getByLabel('Justificativa (obrigatória)').fill('Código avulso separado para revisão.')
  await close.click()
  await expect(page.getByText('Sessão encerrada', { exact: false })).toBeVisible()
  await expect(page.getByText('Justificativa do encerramento:', { exact: false })).toBeVisible()
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.receipt-print li').filter({ hasText: '0001-O' })).toBeVisible()
  expect(confirmations).toBe(1)
})

test('pilha misturada encaminha cada etiqueta à sessão do técnico e exige confirmação', async ({ page }) => {
  const confirmed: string[] = []
  const unknown = 'AVULSO'
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const reply = (json: unknown) => route.fulfill({ json })
    if (path.endsWith('/login')) return reply({ access_token: 'mock', expires_in: 3600,
      user: { ...technician, role: 'warehouse_clerk' } })
    if (path.endsWith('/receipt-technicians') || path.endsWith('/receipt-sessions')) return reply({ items: [], next_cursor: null })
    if (path.endsWith('/receipt-lookup')) {
      const { value } = request.postDataJSON()
      if (value === unknown) return reply({ result: 'UNKNOWN' })
      if (confirmed.includes(value)) return reply({ result: 'ALREADY_RECEIVED' })
      return reply({ result: 'MATCHED', equipment_id: value, technician_id: 'tec-' + value,
        technician_name: 'Técnico ' + value, session_id: 'sessao-' + value })
    }
    const match = path.match(/\/receipt-sessions\/sessao-(A|B)\/(.*)$/)
    if (!match) return route.fulfill({ status: 404 })
    const [, code, action] = match
    if (action === 'scan') {
      expect(request.postDataJSON().value).toBe(code)
      return reply({ equipment_id: code, result: 'MATCHED' })
    }
    if (action === 'items/' + code) return reply({ equipment_id: code, matched_scan_id: 'leitura-' + code, confirmed_at: null })
    if (action === 'confirm') {
      expect(request.postDataJSON()).toEqual({ equipment_id: code, scan_id: 'leitura-' + code, inspection: { power_supply: 'ORIGINAL', cables_present: true, condition: 'GOOD' } })
      confirmed.push(code)
      return reply({})
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByLabel('Login').fill('estoquista')
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
  await page.getByRole('navigation', { name: 'Módulos do estoque' }).getByRole('button', { name: 'Mesa de recebimento', exact: true }).click()
  const field = page.getByLabel('Serial ou MAC da etiqueta')
  for (const code of ['B', 'A']) {
    await field.fill(code)
    await field.press('Tab')
    await expect(page.getByText('Técnico ' + code, { exact: false })).toBeVisible()
    expect(confirmed).not.toContain(code)
    await page.getByRole('combobox', { name: 'Fonte', exact: true }).selectOption('ORIGINAL')
    await page.getByRole('combobox', { name: 'Cabos', exact: true }).selectOption('yes')
    await page.getByRole('combobox', { name: 'Conservação', exact: true }).selectOption('GOOD')
    await page.getByRole('button', { name: 'Confirmar entrega física' }).click()
    await expect(field).toBeFocused()
  }
  for (const [code, message] of [['A', 'já recebido'], [unknown, 'desconhecido']]) {
    await field.fill(code)
    await field.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
  }
  expect(confirmed).toEqual(['B', 'A'])
})

test('preserva a sessão diante de falta de permissão e consulta o código da busca global', async ({ page, context }) => {
  const clerk = { ...technician, role: 'warehouse_clerk', name: 'Estoquista', login: 'estoquista' }
  const credentials = { access_token: 'mock-token', expires_in: 3600, user: clerk }
  let refreshes = 0
  let lookups = 0
  await context.route('**/api/v1/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/login')) return route.fulfill({ json: credentials })
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
    if (url.pathname.endsWith('/receipt-sessions')) return route.fulfill({ json: { items: [], next_cursor: null } })
    if (url.pathname.endsWith('/receipt-exceptions')) return route.fulfill({ json: {
      items: [{ value: '0001-O', result: 'UNKNOWN', seen_at: '2026-11-23T14:00:00Z' }], next_cursor: null,
    } })
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204 })
    return route.fulfill({ status: 404 })
  })

  await page.goto('/')
  await page.getByLabel('Login').fill(clerk.login)
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar no Sistema' }).click()
  const search = page.getByRole('searchbox', { name: 'Buscar por serial ou MAC' })
  await search.fill('0001-O')
  await search.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Você não tem permissão para esta operação.')
  await search.press('Enter')
  await expect(page.getByRole('status')).toHaveText('Código desconhecido')
  expect(refreshes).toBe(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible()
  expect(refreshes).toBe(1)
  const menu = page.getByRole('navigation', { name: 'Módulos do estoque' })
  await menu.getByRole('button', { name: 'Histórico e comprovantes' }).click()
  await expect(page.getByText('Nenhuma sessão registrada.')).toBeVisible()
  await menu.getByRole('button', { name: 'Divergências' }).click()
  await expect(page.getByText('0001-O', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Entrar no Sistema' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Entrar no Sistema' })).toBeVisible()
  expect(refreshes).toBe(1)
})
