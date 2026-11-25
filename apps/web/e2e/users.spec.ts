import { expect, test } from '@playwright/test'

test('administrador abre o perfil do técnico e consulta a posse e as entregas', async ({ page, context }) => {
  const admin = { id: 'admin', name: 'Administração', login: 'admin', role: 'administrator', active: true }
  const technician = { id: 'tech', name: 'Técnica de campo', login: 'tecnica-01', role: 'technician', active: true }
  let created = false
  let refreshed = false
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/auth/web/login')) {
      return route.fulfill({ json: { user: admin, access_token: 'mock-token', expires_in: 3600 } })
    }
    if (path.endsWith('/auth/web/refresh')) {
      refreshed = true
      return route.fulfill({ json: { user: admin, access_token: 'renewed-token', expires_in: 3600 } })
    }
    if (path.endsWith('/receipt-sessions')) {
      return route.fulfill({ json: { items: [], next_cursor: null } })
    }
    if (path.endsWith('/warehouse/batches')) {
      if (request.headers().authorization !== 'Bearer renewed-token') return route.fulfill({ status: 401 })
      return route.fulfill({ json: { items: [{ id: 'batch', number: 7, technician_id: 'tech', technician_name: technician.name,
        status: 'SUBMITTED', notes: null, receipt_session_id: null, clerk_name: null, created_at: '2026-11-24T14:30:00Z',
        finished_at: null, total: 3, unidentified: 0, received: 0 }], next_cursor: null } })
    }
    if (path.endsWith('/admin/users')) {
      if (request.method() === 'GET') {
        return route.fulfill({ json: { items: created ? [admin, technician] : [admin], next_cursor: null } })
      }
      expect(request.postDataJSON()).toEqual({
        name: technician.name, login: technician.login, role: 'technician', password: 'senha-inicial-local',
      })
      created = true
      return route.fulfill({ status: 201, json: technician })
    }
    if (path.endsWith('/admin/users/tech/inventory')) {
      return route.fulfill({ json: {
        items: [{ id: 'router', identifiers: [{ kind: 'SERIAL', raw_value: '0001-O', normalized_value: '0001-O' }] }],
        next_cursor: null,
      } })
    }
    if (path.endsWith('/admin/users/tech/deliveries')) {
      return route.fulfill({ json: {
        items: [{
          id: 'receipt',
          delivered_at: '2026-11-24T14:30:00Z',
          warehouse_name: 'Depósito piloto',
          identifiers: [{ kind: 'SERIAL', raw_value: '0002-O', normalized_value: '0002-O' }],
        }],
        next_cursor: null,
      } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByLabel('Login').fill('admin')
  await page.getByLabel('Senha', { exact: true }).fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
  const menu = page.getByRole('navigation', { name: 'Módulos do estoque' })
  await expect(menu.getByRole('button', { name: 'Revisão de fotos' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Lotes para conferir' })).toBeVisible()
  await expect(page.getByText('Lote 0007')).toBeVisible()
  await expect(page.getByText(technician.name)).toBeVisible()
  expect(refreshed).toBe(true)
  await menu.getByRole('button', { name: 'Usuários e permissões', exact: true }).click()
  await expect(page.getByText('admin · Administrador · Ativo')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Criar usuário' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Configurações' }).click()
  await page.getByLabel('Nome', { exact: true }).fill(technician.name)
  await page.getByLabel('Login', { exact: true }).fill(technician.login)
  await page.getByLabel('Senha inicial').fill('senha-inicial-local')
  await page.getByRole('button', { name: 'Criar usuário', exact: true }).click()
  await expect(page.getByText('Conta criada para Técnica de campo (tecnica-01).')).toBeVisible()
  await expect(page.getByLabel('Senha inicial')).toHaveValue('')
  await page.getByRole('button', { name: 'Usuários', exact: true }).click()
  await page.getByRole('button', { name: 'Abrir técnico' }).click()
  await expect(page.getByRole('heading', { name: technician.name })).toBeVisible()
  const profile = page.getByRole('navigation', { name: 'Perfil do técnico' })
  await expect(profile.getByRole('button', { name: 'Em posse' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Serial: 0001-O')).toBeVisible()
  await profile.getByRole('button', { name: 'Já entregues' }).click()
  await expect(page.getByText('Serial: 0002-O')).toBeVisible()
  await expect(page.getByText('Depósito piloto')).toBeVisible()
  await expect(page.getByText('Serial: 0001-O')).toHaveCount(0)
  await page.getByRole('button', { name: 'Voltar aos usuários' }).click()
  await expect(page.getByRole('heading', { name: 'Usuários cadastrados' })).toBeVisible()
})
