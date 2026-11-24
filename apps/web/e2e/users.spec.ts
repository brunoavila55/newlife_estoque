import { expect, test } from '@playwright/test'

test('administrador cadastra técnico e consulta os equipamentos da conta', async ({ page, context }) => {
  const admin = { id: 'admin', name: 'Administração', login: 'admin', role: 'administrator', active: true }
  const technician = { id: 'tech', name: 'Técnica de campo', login: 'tecnica-01', role: 'technician', active: true }
  let created = false
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/auth/web/login')) {
      return route.fulfill({ json: { user: admin, access_token: 'mock-token', expires_in: 3600 } })
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
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByLabel('Login').fill('admin')
  await page.getByLabel('Senha', { exact: true }).fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
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
  await page.getByRole('button', { name: 'Ver estoque' }).click()
  await expect(page.getByRole('heading', { name: 'Estoque de Técnica de campo' })).toBeVisible()
  await expect(page.getByText('Serial: 0001-O')).toBeVisible()
})
