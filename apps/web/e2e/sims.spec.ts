import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const city = { id: '00000000-0000-4000-8000-000000000001', name: 'São Gabriel' }
const clerk = { id: '00000000-0000-4000-8000-000000000043', name: 'Estoquista', login: 'estoquista', role: 'warehouse_clerk', location_id: city.id }
const bruno = { id: '00000000-0000-4000-8000-000000000044', name: 'Bruno', login: 'bruno', active: true, whatsapp: '5555999990000', sims: 0, last_delivery_at: null }
const iccids = ['89554000090000000019', '89554000090000000027', '89554000090000000035', '89554000090000000043']
const date = '2026-11-27T14:00:00.000Z'

function card(iccid: string, technician?: { id: string; name: string }) {
  return {
    id: 'card-' + iccid, iccid, carrier: 'VIVO', mvno_display: 'NEW LIFE', operator_status: 'Livre', subscriber: null,
    location_id: technician ? null : city.id, location_name: technician ? null : city.name,
    technician_id: technician?.id ?? null, technician_name: technician?.name ?? null,
    holder_location_id: city.id, holder_location_name: city.name, since: date,
  }
}

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Login').fill(clerk.login)
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral do estoque' })).toBeVisible()
}

test('importa a planilha da operadora com conferência prévia e linhas recusadas', async ({ page, context }) => {
  const posts: { client_import_id: string; dry_run: boolean; rows: { row: number; iccid: string; operator_status?: string; subscriber?: string }[] }[] = []
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/login')) return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: clerk } })
    if (path === '/api/v1/locations') return route.fulfill({ json: { items: [city] } })
    if (path === '/api/v1/warehouse/overview') return route.fulfill({ json: { items: [] } })
    if (path === '/api/v1/sims') return route.fulfill({ json: { items: [], next_cursor: null, totals: { stock: 0, with_technicians: 0 } } })
    if (path === '/api/v1/sims/imports' && request.method() === 'GET') return route.fulfill({ json: { items: [] } })
    if (path === '/api/v1/sims/imports') {
      const body = request.postDataJSON()
      posts.push(body)
      return route.fulfill({ json: {
        import_id: body.client_import_id, dry_run: body.dry_run, file_name: body.file_name, location_name: city.name,
        total_rows: body.rows.length, created: 4, updated: 0, unchanged: 0,
        invalid: [{ row: 6, value: '8.9554000000414257E+19', reason: 'O ICCID deve ter apenas números.' }],
        other_location_count: 0, other_location: [], status_changes: [],
      } })
    }
    return route.fulfill({ status: 404 })
  })

  await signIn(page)
  await page.getByRole('navigation', { name: 'Módulos do estoque' }).getByRole('button', { name: 'Estoque de chips' }).click()
  await page.getByRole('button', { name: 'Importar planilha' }).click()
  await page.locator('input[type=file]').setInputFiles(fileURLToPath(new URL('./fixtures/chips.xlsx', import.meta.url)))
  await expect(page.getByRole('heading', { name: 'Conferência antes de importar' })).toBeVisible()
  await expect(page.getByText(/ICCID salvo como número/)).toBeVisible()
  expect(posts).toHaveLength(1)
  expect(posts[0].dry_run).toBe(true)
  expect(posts[0].rows.map((row) => row.iccid)).toEqual([...iccids, '8.9554000000414257E+19'])
  expect(posts[0].rows[3]).toMatchObject({ row: 5, operator_status: 'Ativo', subscriber: 'Cliente de teste' })
  await expect(page.getByText('O ICCID deve ter apenas números.')).toBeVisible()

  await page.getByRole('button', { name: 'Importar para São Gabriel' }).click()
  await expect(page.getByRole('heading', { name: 'Importação concluída' })).toBeVisible()
  expect(posts).toHaveLength(2)
  expect(posts[1].dry_run).toBe(false)
  expect(posts[1].client_import_id).toBe(posts[0].client_import_id)
})

test('entrega chips ao técnico bipando cada ICCID e envia o comprovante pelo WhatsApp', async ({ page, context }) => {
  const other = { id: 'outro', name: 'Carla' }
  const transfers: { client_transfer_id: string; kind: string; technician_id: string; iccids: string[] }[] = []
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.endsWith('/login')) return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: clerk } })
    if (path === '/api/v1/locations') return route.fulfill({ json: { items: [city] } })
    if (path === '/api/v1/warehouse/overview') return route.fulfill({ json: { items: [] } })
    if (path === '/api/v1/sims/technicians') return route.fulfill({ json: { items: [bruno] } })
    if (path === '/api/v1/sims/lookup') {
      const code = url.searchParams.get('code')!
      if (code === iccids[2]) return route.fulfill({ json: { result: 'FOUND', card: card(code, other), history: [] } })
      if (code === '123') return route.fulfill({ json: { result: 'INVALID', reason: 'O ICCID deve ter 19 ou 20 dígitos.' } })
      const full = iccids.find((iccid) => iccid.startsWith(code))
      return route.fulfill({ json: full ? { result: 'FOUND', card: card(full), history: [] } : { result: 'UNKNOWN', iccid: code } })
    }
    if (path === '/api/v1/sims/transfers' && request.method() === 'POST') {
      const body = request.postDataJSON()
      transfers.push(body)
      return route.fulfill({ status: 201, json: {
        transfer: { id: body.client_transfer_id, number: 7, kind: body.kind, location_id: city.id, location_name: city.name,
          technician_id: bruno.id, technician_name: bruno.name, technician_whatsapp: bruno.whatsapp, clerk_name: clerk.name,
          notes: body.notes, created_at: date, total: body.iccids.length },
        items: body.iccids.map((iccid: string) => ({ iccid, operator_status: 'Livre' })),
      } })
    }
    return route.fulfill({ status: 404 })
  })

  await signIn(page)
  await page.getByRole('navigation', { name: 'Módulos do estoque' }).getByRole('button', { name: 'Entregar chips' }).click()
  await page.getByRole('button', { name: /Bruno/ }).click()
  const field = page.getByLabel('Bipe o chip')
  await expect(field).toBeFocused()

  // Leitor HID: digita e termina com Enter. O segundo chip vem sem o dígito verificador.
  await page.keyboard.type(iccids[0] + '\n')
  await expect(page.getByRole('status')).toContainText(iccids[0] + ' · adicionado')
  await page.keyboard.type(iccids[1].slice(0, 19) + '\n')
  await expect(page.getByRole('status')).toContainText(iccids[1] + ' · adicionado')
  await page.keyboard.type(iccids[0] + '\n')
  await expect(page.getByRole('status')).toContainText('já está na lista')
  await page.keyboard.type(iccids[2] + '\n')
  await expect(page.getByRole('status')).toContainText('está com Carla')
  await page.keyboard.type('123\n')
  await expect(page.getByRole('status')).toContainText('19 ou 20 dígitos')
  await expect(page.getByRole('heading', { name: /Chips na lista/ })).toContainText('2')
  expect(transfers).toHaveLength(0)

  await field.press('Control+Enter')
  await expect(page.getByRole('heading', { name: 'Entrega 0007 registrada' })).toBeVisible()
  expect(transfers).toHaveLength(1)
  expect(transfers[0]).toMatchObject({ kind: 'DELIVERY', technician_id: bruno.id, iccids: [iccids[0], iccids[1]] })
  const link = await page.getByRole('link', { name: 'Enviar pelo WhatsApp' }).getAttribute('href')
  expect(link).toContain('phone=' + bruno.whatsapp)
  const text = decodeURIComponent(link!.split('text=')[1])
  expect(text).toContain('Comprovante de entrega de chips')
  expect(text).toContain('Quantidade: 2 chips')
  expect(text).toContain('1. ' + iccids[0])
  expect(text).toContain('2. ' + iccids[1])
})
