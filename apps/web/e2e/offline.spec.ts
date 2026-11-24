import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'

const technician = { id: '00000000-0000-4000-8000-000000000042', name: 'Técnica de teste', login: 'tecnica' }
const photo = {
  name: 'etiqueta.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X2QAAAAASUVORK5CYII=', 'base64'),
}

async function signIn(page: Page, login = technician.login) {
  await page.getByLabel('Login').fill(login)
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recolhimentos' })).toBeVisible()
}

function technicianNav(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Área do técnico' }).getByRole('button', { name, exact: true })
}

async function saveFromGallery(page: Page, file = photo, serial?: string) {
  await technicianNav(page, 'Registrar').click()
  await page.locator('input[type=file]:not([capture])').setInputFiles(file)
  if (serial) await page.getByLabel('Número de Série (SN)').fill(serial)
  await page.getByRole('button', { name: /Salvar no Dispositivo/ }).click()
}

test('técnico consulta sua custódia atual e volta a consultar ao reconectar', async ({ page, context }) => {
  let received = false
  await page.setViewportSize({ width: 320, height: 640 })
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/auth/web/login')) {
      return route.fulfill({ json: { access_token: 'tech-token', expires_in: 3600, user: technician } })
    }
    if (path === '/api/v1/me/inventory') {
      expect(request.headers().authorization).toBe('Bearer tech-token')
      expect(new URL(request.url()).search).toBe('')
      return route.fulfill({ json: {
        items: received ? [] : [{
          id: 'router',
          identifiers: [{ kind: 'SERIAL', raw_value: '0001-O', normalized_value: '0001-O' }],
        }],
        next_cursor: null,
      } })
    }
    return route.fulfill({ status: 404 })
  })

  await page.goto('/')
  await signIn(page)
  const stockTab = technicianNav(page, 'Meu estoque')
  await stockTab.click()
  await expect(stockTab).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Serial: 0001-O')).toBeVisible()

  received = true
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click()
  await expect(page.getByText('Nenhum equipamento identificado em custódia.')).toBeVisible()
  await expect(page.getByText('Serial: 0001-O')).toHaveCount(0)

  await context.setOffline(true)
  await expect(page.getByText('Conecte-se à internet para consultar os equipamentos em sua custódia.')).toBeVisible()
  await technicianNav(page, 'Carteira').click()
  await stockTab.click()
  await context.setOffline(false)
  await expect(page.getByText('Nenhum equipamento identificado em custódia.')).toBeVisible()
})

test('mantém dez fotos offline após fechar a aba e retoma um envio interrompido', async ({ page, context }) => {
  let interrupted = false
  const ids = new Set<string>()
  const completed = new Set<string>()

  await context.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/v1/auth/web/')) {
      return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: technician } })
    }
    if (request.method() === 'POST' && path === '/api/v1/captures') {
      const input = request.postDataJSON()
      expect(input.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(input.byte_length).toBe(photo.buffer.length)
      ids.add(input.client_capture_id)
      return route.fulfill({ json: { id: input.client_capture_id, received: false, status: 'AWAITING_IMAGE' } })
    }
    const id = path.split('/')[4]
    if (path.endsWith('/image')) {
      if (!interrupted) {
        interrupted = true
        return route.abort('connectionreset')
      }
      expect(request.postDataBuffer()).toEqual(photo.buffer)
      return route.fulfill({ json: { id, received: false, status: 'AWAITING_IMAGE' } })
    }
    if (path.endsWith('/complete')) {
      completed.add(id)
      return route.fulfill({ json: { id, received: true, status: 'OCR_PENDING' } })
    }
    return route.fulfill({ status: 404 })
  })

  await page.goto('/')
  await signIn(page)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
  await expect(page.getByRole('heading', { name: 'Recolhimentos' })).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText('Sem conexão', { exact: true })).toBeVisible()
  for (let index = 1; index <= 10; index++) {
    await saveFromGallery(page)
    await expect(page.getByText(`${index} fotos pendentes`, { exact: true })).toBeVisible()
  }
  expect(ids.size).toBe(0)

  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/')
  await technicianNav(reopened, 'Fila').click()
  await expect(reopened.getByText('10 fotos pendentes', { exact: true })).toBeVisible()
  await expect(reopened.getByText('Aguardando envio', { exact: true })).toHaveCount(10)
  await reopened.evaluate(async () => { await Promise.all((await caches.keys()).map((key) => caches.delete(key))) })
  await expect(reopened.getByText('10 fotos pendentes', { exact: true })).toBeVisible()

  await context.setOffline(false)
  await expect(reopened.getByText('Envio interrompido.', { exact: false })).toBeVisible()
  await reopened.getByRole('button', { name: 'Sincronizar agora' }).click()
  await expect(reopened.getByText('0 fotos pendentes', { exact: true })).toBeVisible()
  await expect(reopened.getByText('Recebida, aguardando processamento', { exact: true })).toHaveCount(10)
  expect(ids.size).toBe(10)
  expect(completed.size).toBe(10)
})

test('protege a fila ao trocar de conta e exibe falha de cota', async ({ page, context }) => {
  const next = { id: '00000000-0000-4000-8000-000000000073', name: 'Outra pessoa', login: 'outra' }
  await context.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/login')) {
      const user = route.request().postDataJSON().login === technician.login ? technician : next
      return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user } })
    }
    if (path.endsWith('/logout')) return route.fulfill({ status: 204 })
    return route.fulfill({ status: 503, json: { message: 'Armazenamento indisponível.' } })
  })
  await page.goto('/')
  await signIn(page)
  await page.evaluate(() => {
    navigator.storage.estimate = async () => ({ usage: 0, quota: 10 })
  })
  await saveFromGallery(page)
  await expect(page.getByText('Pouco espaço. Sincronize as fotos antes de liberar espaço no dispositivo.', { exact: true })).toBeVisible()
  await technicianNav(page, 'Fila').click()
  await expect(page.getByText('0 fotos pendentes', { exact: true })).toBeVisible()

  await page.evaluate(() => {
    navigator.storage.estimate = async () => ({ usage: 0, quota: 1024 ** 3 })
  })
  await technicianNav(page, 'Registrar').click()
  await page.getByRole('button', { name: /Salvar no Dispositivo/ }).click()
  await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.name === 'photos') throw new DOMException('Cota insuficiente', 'QuotaExceededError')
      return add.call(this, value, key)
    }
  })
  await saveFromGallery(page)
  await expect(page.getByText('A foto não foi salva', { exact: false })).toBeVisible()
  await technicianNav(page, 'Fila').click()
  await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await page.getByRole('button', { name: 'Sair e Manter', exact: true }).click()
  await signIn(page, next.login)
  await technicianNav(page, 'Fila').click()
  await expect(page.getByText('0 fotos pendentes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await signIn(page)
  await technicianNav(page, 'Fila').click()
  await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
})

test('lê código por ZXing offline e aceita preenchimento manual', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true })
  })
  await context.route('**/api/v1/auth/web/**', (route) =>
    route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: technician } }))
  await page.goto('/')
  await signIn(page)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
  await expect(page.getByRole('heading', { name: 'Recolhimentos' })).toBeVisible()
  await context.setOffline(true)
  const qr = {
    name: 'qr-etiqueta.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFcAAABXAQAAAABZs+TBAAAA3klEQVR4nM2TMW7CQBBF/yBLprILqkhG7BXoXERyjmS6dJADADfIWUyFO47ASr7AjisjWf5UKNWOyzDVFF9/5s/bFeJVXOCv/qsHA7BnAWymuF446hJ7mp4Xl22hy5m5cvazu+nOzWgqnzc+HywNJelv7kes7CSnlCSN7H27PsD1D8tnKjtteErjPqA2RV36urI0oWJAkRv7gMoxH6iM8wJJ6rU7wcqlIsfvdWfeUDhK439bZ3PXr8/a4JUAQHbpspuPvvkEAHp8rIK7m9yzMj2YLAKwG0ak8fvIm/3BJ3tAbMHKibfMAAAAAElFTkSuQmCC', 'base64'),
  }
  await saveFromGallery(page, qr)
  await expect(page.getByText('NEWLIFE-00123', { exact: true })).toBeVisible()

  await saveFromGallery(page, photo, 'MANUAL-00234')
  await expect(page.getByText('MANUAL-00234', { exact: true })).toBeVisible()
  await expect(page.getByText('2 fotos pendentes', { exact: true })).toBeVisible()
})

test('lê pela câmera, confirma a foto offline e libera o dispositivo', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: class {
      async detect() { return [{ rawValue: 'SN-00042' }] }
    } })
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const stream = canvas.captureStream(5)
      const draw = () => canvas.getContext('2d')!.fillRect(0, 0, 640, 480)
      const timer = setInterval(() => {
        if (stream.active) draw()
        else clearInterval(timer)
      }, 150)
      return stream
    }
  })
  await context.route('**/api/v1/auth/web/**', route =>
    route.fulfill({ json: { access_token: 'mock', expires_in: 3600, user: technician } }))
  await page.goto('/')
  await signIn(page)
  await context.setOffline(true)
  await technicianNav(page, 'Registrar').click()
  await page.getByRole('button', { name: 'Abrir câmera traseira' }).click()
  await expect(page.getByText('Código: SN-00042')).toBeVisible()
  const track = await page.locator('video').evaluateHandle(video => (video.srcObject as MediaStream).getVideoTracks()[0])
  await page.getByRole('button', { name: 'Disparar Foto' }).click()
  await page.getByRole('button', { name: 'Usar esta foto' }).click()
  await expect(page.getByText('Código na foto: SN-00042')).toBeVisible()
  await expect.poll(() => track.evaluate(t => t.readyState)).toBe('ended')
  await page.getByRole('button', { name: /Salvar no Dispositivo/ }).click()
  await expect(page.getByText('SN-00042', { exact: true })).toBeVisible()
  await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
})

test('preserva a foto pendente depois de atualizar o Service Worker', async ({ page, context }) => {
  let revision = 1
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
  }
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://127.0.0.1').pathname
    const asset = pathname === '/' ? '/index.html' : pathname
    try {
      const bytes = await readFile(new URL('../dist' + asset, import.meta.url))
      response.setHeader('content-type', types[extname(asset)] ?? 'application/octet-stream')
      response.setHeader('cache-control', 'no-cache')
      response.end(asset === '/sw.js' ? bytes.toString() + '\n// Revisão ' + revision : bytes)
    } catch {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await context.route('**/api/v1/**', (route) => route.request().url().includes('/auth/web/')
      ? route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: technician } })
      : route.fulfill({ status: 503, json: { message: 'Armazenamento indisponível.' } }))

    await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port)
    await page.getByLabel('Login').fill(technician.login)
    await page.getByLabel('Senha').fill('senha-de-teste-local')
    await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
    await page.locator('nav').getByRole('button', { name: /Registrar/ }).click()

    await context.setOffline(true)
    await page.locator('input[type=file]:not([capture])').setInputFiles(photo)
    await page.getByLabel('Número de Série (SN)').fill('0001')
    await page.getByRole('button', { name: /Salvar no Dispositivo/ }).click()
    await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
    await context.setOffline(false)

    revision = 2
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
    const update = page.getByRole('button', { name: 'Atualizar aplicativo' })
    await expect(update).toBeVisible()
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), update.click()])
    await page.locator('nav').getByRole('button', { name: /Fila/ }).click()
    await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
    const size = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const open = indexedDB.open('newlife-stock')
      open.onerror = reject
      open.onsuccess = () => {
        const database = open.result
        const request = database.transaction('photos').objectStore('photos').getAll()
        request.onerror = reject
        request.onsuccess = () => {
          database.close()
          resolve(request.result[0]?.blob?.size ?? 0)
        }
      }
    }))
    expect(size).toBe(photo.buffer.length)
  } finally {
    server.close()
  }
})

test('revisa o OCR com foto e confirma a correção feita pelo administrador', async ({ page, context }) => {
  const id = '00000000-0000-4000-8000-000000000052'
  const resultId = '00000000-0000-4000-8000-000000000053'
  const date = '2026-11-23T14:00:00.000Z'
  const raw = '5\t1\t1\t1\t1\t1\t0\t0\t0\t0\t50\t00O1'
  const capture = {
    id, technician_name: technician.name, status: 'NEEDS_REVIEW', captured_at_device: date,
    received_at_server: date, equipment_id: null as string | null, review_issue: null,
  }
  const result = {
    id: resultId, status: 'RECOGNIZED', created_at: date, provider: 'tesseract', model_version: 'teste',
    raw_tsv: raw, warnings: ['LOW_CONFIDENCE'], failure_code: null,
    suggestions: [{ kind: 'SERIAL', label: 'S/N', raw_value: '00O1', normalized_value: '00O1', confidence: 0.5 }],
  }
  let validated: { kind: string; raw_value: string; normalized_value: string }[] | null = null
  await context.route('**/private-label.png', (route) => route.fulfill({
    contentType: photo.mimeType, body: photo.buffer,
  }))
  await context.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/login')) {
      return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600,
        user: { ...technician, role: 'administrator', name: 'Administradora', login: 'admin' } } })
    }
    if (path === '/api/v1/admin/captures') {
      return route.fulfill({ json: { items: validated ? [] : [capture], next_cursor: null } })
    }
    if (path === '/api/v1/admin/captures/' + id) {
      return route.fulfill({ json: { ...capture, barcode_evidence: null, validated_identifiers: validated,
        complement: { service_order: 'OS-10492', cables: false },
        runs: [{ id: resultId, status: result.status, created_at: date }], result } })
    }
    if (path.endsWith('/image-url')) {
      return route.fulfill({ json: { url: 'http://localhost:4173/private-label.png', expires_in: 120 } })
    }
    if (path.endsWith('/review')) {
      expect(route.request().postDataJSON()).toEqual({
        decision: 'validate', ocr_result_id: resultId, identifiers: [{ kind: 'SERIAL', raw_value: '0001' }],
      })
      validated = [{ kind: 'SERIAL', raw_value: '0001', normalized_value: '0001' }]
      capture.status = 'IDENTIFIED'
      capture.equipment_id = technician.id
      return route.fulfill({ json: { status: capture.status, issue: null, equipment_id: capture.equipment_id } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByLabel('Login').fill('admin')
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
  await page.getByRole('button', { name: /Revisão de OCR/ }).click()
  await page.getByRole('button', { name: 'Abrir captura' }).click()
  await expect(page.getByRole('img', { name: 'Foto da etiqueta enviada pelo técnico' })).toBeVisible()
  const collectionDetails = page.getByRole('region', { name: 'Informações do recolhimento' })
  await expect(collectionDetails.getByText('OS-10492')).toBeVisible()
  await expect(collectionDetails.getByText('Não', { exact: true })).toBeVisible()
  await expect(page.getByText('Confiança do OCR: 50%')).toBeVisible()
  await page.getByRole('button', { name: 'Usar Serial' }).click()
  await page.getByLabel('Valor', { exact: true }).fill('0001')
  const validate = page.getByRole('button', { name: 'Validar identificação' })
  await expect(validate).toBeDisabled()
  await page.getByLabel('Conferi os valores na foto original.').check()
  await validate.click()
  await expect(page.getByRole('heading', { name: 'Identificadores validados' })).toBeVisible()
  await expect(page.getByText('Serial: 0001')).toBeVisible()
  await page.getByText('Ver leitura bruta').click()
  await expect(page.locator('pre')).toHaveText(raw)
})


test('retoma pelo mesmo UUID quando a resposta da confirmação se perde', async ({ page, context }) => {
  let captureId: string | undefined
  let uploadRequests = 0
  let durableReceipts = 0
  let preferredRetry = false
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.includes('/auth/web/')) {
      return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user: technician } })
    }
    if (path === '/api/v1/captures') {
      const id = request.postDataJSON().client_capture_id
      captureId ??= id
      expect(id).toBe(captureId)
      if (durableReceipts && !preferredRetry) return route.abort('connectionreset')
      return route.fulfill({ json: { id, received: Boolean(durableReceipts),
        status: durableReceipts ? 'OCR_PENDING' : 'AWAITING_IMAGE' } })
    }
    if (path.endsWith('/image')) {
      uploadRequests++
      return route.fulfill({ json: { id: captureId, received: false, status: 'AWAITING_IMAGE' } })
    }
    if (path.endsWith('/complete')) {
      durableReceipts++
      return route.abort('connectionreset')
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await signIn(page)
  await saveFromGallery(page)
  await expect(page.getByText('Envio interrompido.', { exact: false })).toBeVisible()
  await expect(page.getByText('1 fotos pendentes', { exact: true })).toBeVisible()
  preferredRetry = true
  await page.getByRole('button', { name: 'Sincronizar agora' }).click()
  await expect(page.getByText('Recebida, aguardando processamento')).toBeVisible()
  expect(uploadRequests).toBe(1)
  expect(durableReceipts).toBe(1)
})

test('sincroniza os dados complementares do formulário do técnico', async ({ page, context }) => {
  const user = { ...technician, role: 'technician' }
  await context.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/auth/web/login') {
      return route.fulfill({ json: { access_token: 'mock-token', expires_in: 3600, user } })
    }
    if (path === '/api/v1/captures') {
      return route.fulfill({ json: {
        id: route.request().postDataJSON().client_capture_id,
        received: true,
        status: 'OCR_PENDING',
      } })
    }
    return route.fulfill({ status: 404 })
  })

  await page.goto('/')
  await page.getByLabel('Login').fill(technician.login)
  await page.getByLabel('Senha').fill('senha-de-teste-local')
  await page.getByRole('button', { name: 'Entrar no Sistema', exact: true }).click()
  await page.locator('nav').getByRole('button', { name: /Registrar/ }).click()
  await page.locator('input[type=file]:not([capture])').setInputFiles(photo)
  await page.getByLabel('Número de Série (SN)').fill('0001')
  await page.getByLabel('Ordem de Serviço (OS) ou Contrato').fill('OS-10492')
  await page.getByRole('button', { name: /Avariado/ }).click()
  await page.getByRole('button', { name: 'Ausente' }).click()
  await page.getByLabel('Observações do recolhimento').fill('Carcaça riscada.')
  const request = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/captures')
  await page.getByRole('button', { name: /Salvar no Dispositivo/ }).click()
  expect((await request).postDataJSON().complement).toMatchObject({
    service_order: 'OS-10492', condition: 'DAMAGED', power_supply: 'MISSING', notes: 'Carcaça riscada.',
  })
})
