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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Coletar' })).toBeVisible()
}

function technicianNav(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Área do técnico' }).getByRole('button', { name, exact: true })
}

async function saveFromGallery(page: Page, file = photo, code?: string) {
  await technicianNav(page, 'Coletar').click()
  await page.locator('input[type=file]:not([capture])').setInputFiles(file)
  if (code) await page.getByLabel(/Código da etiqueta/).fill(code)
  await page.getByRole('button', { name: 'Salvar e parar' }).click()
}

/** Abre Envios e confere quantas fotos ainda estão só no celular. */
async function expectPending(page: Page, count: number) {
  await technicianNav(page, 'Envios').click()
  await expect(page.getByText(count === 0 ? 'Tudo enviado' : `${count} foto${count > 1 ? 's' : ''} para enviar`, { exact: true })).toBeVisible()
}

const city = { id: '00000000-0000-4000-8000-000000000001', name: 'São Gabriel' }
const cityMock: Record<string, unknown> = {
  '/api/v1/locations': { items: [city] },
  '/api/v1/warehouse/overview': { items: [{ ...city, technicians: 1, clerks: 1, equipment_in_stock: 0,
    equipment_with_technicians: 0, open_batches: 0, sims_in_stock: 0, sims_with_technicians: 0 }] },
  '/api/v1/me/sims': { items: [] },
}

test('técnico consulta o que está com ele e monta um lote de entrega', async ({ page, context }) => {
  let received = false
  let created: Record<string, unknown> | undefined
  const item = (id: string, serial: string | null) => ({
    capture_id: id, equipment_id: serial ? 'eq-' + id : null, capture_status: serial ? 'IDENTIFIED' : 'NEEDS_REVIEW',
    captured_at: '2026-11-23T14:00:00Z', complement: null, typed_code: serial ? null : 'SN-DIGITADO',
    identifiers: serial ? [{ kind: 'SERIAL', raw_value: serial }] : [], suggestions: [], received_at: null,
    batch_id: null, batch_number: null, batch_status: null,
  })
  await page.setViewportSize({ width: 320, height: 640 })
  await context.route('**/api/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/auth/web/login')) {
      return route.fulfill({ json: { access_token: 'tech-token', expires_in: 3600, user: technician } })
    }
    if (cityMock[path]) return route.fulfill({ json: cityMock[path] })
    if (path === '/api/v1/me/custody') {
      expect(request.headers().authorization).toBe('Bearer tech-token')
      return route.fulfill({ json: { items: received ? [] : [item('c1', '0001-O'), item('c2', null)] } })
    }
    if (path === '/api/v1/me/batches' && request.method() === 'POST') {
      created = request.postDataJSON()
      const batch = { id: 'b1', number: 12, technician_id: technician.id, technician_name: technician.name,
        status: 'SUBMITTED', notes: 'Pilha de hoje', receipt_session_id: null, clerk_name: null,
        created_at: '2026-11-23T15:00:00Z', finished_at: null, total: 2, unidentified: 1, received: 0 }
      return route.fulfill({ json: { batch, items: [item('c1', '0001-O'), item('c2', null)]
        .map((entry) => ({ ...entry, added_by_clerk: false })) } })
    }
    return route.fulfill({ status: 404 })
  })

  await page.goto('/')
  await signIn(page)
  const holdings = technicianNav(page, 'Comigo')
  await holdings.click()
  await expect(holdings).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('SN 0001-O')).toBeVisible()
  await expect(page.getByText('SN-DIGITADO (sugerido)')).toBeVisible()

  await page.getByRole('button', { name: 'Selecionar todos' }).click()
  await page.getByRole('button', { name: 'Montar lote' }).click()
  await page.getByLabel(/Observação para o estoque/).fill('Pilha de hoje')
  await page.getByRole('button', { name: 'Confirmar lote' }).click()
  await expect(page.getByText('Lote 0012')).toBeVisible()
  await expect(page.getByText('Informe no balcão')).toBeVisible()
  expect(created).toMatchObject({ capture_ids: ['c1', 'c2'], notes: 'Pilha de hoje' })
  expect(created?.client_batch_id).toMatch(/^[0-9a-f-]{36}$/)

  received = true
  await holdings.click()
  await expect(page.getByText('Nada pendente de entrega fora de lotes.')).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText('Sem conexão. Conecte-se para consultar e montar lotes.')).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByText('Nada pendente de entrega fora de lotes.')).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Coletar' })).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByText('Sem conexão', { exact: true })).toBeVisible()
  for (let index = 1; index <= 10; index++) {
    await saveFromGallery(page)
    await expect(page.getByText('Salvo no celular.', { exact: true })).toBeVisible()
  }
  await expectPending(page, 10)
  expect(ids.size).toBe(0)

  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/')
  await expectPending(reopened, 10)
  await expect(reopened.getByText('Aguardando envio', { exact: true })).toHaveCount(10)
  await reopened.evaluate(async () => { await Promise.all((await caches.keys()).map((key) => caches.delete(key))) })
  await expect(reopened.getByText('10 fotos para enviar', { exact: true })).toBeVisible()

  await context.setOffline(false)
  await expect(reopened.getByText('Envio interrompido.', { exact: false })).toBeVisible()
  await reopened.getByRole('button', { name: 'Sincronizar agora' }).click()
  await expect(reopened.getByText('Tudo enviado', { exact: true })).toBeVisible()
  await expect(reopened.getByText('Recebida · lendo etiqueta', { exact: true })).toHaveCount(10)
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
  await page.evaluate(() => {
    navigator.storage.estimate = async () => ({ usage: 0, quota: 1024 ** 3 })
  })
  // A foto continua na tela depois da falha e pode ser salva de novo.
  await page.getByRole('button', { name: 'Salvar e parar' }).click()
  await expect(page.getByText('Salvo no celular.', { exact: true })).toBeVisible()
  await expectPending(page, 1)
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.name === 'photos') throw new DOMException('Cota insuficiente', 'QuotaExceededError')
      return add.call(this, value, key)
    }
  })
  await saveFromGallery(page)
  await expect(page.getByText('A foto não foi salva', { exact: false })).toBeVisible()
  await expectPending(page, 1)
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await page.getByRole('button', { name: 'Sair mesmo assim', exact: true }).click()
  await signIn(page, next.login)
  await expectPending(page, 0)
  await page.getByRole('button', { name: 'Sair', exact: true }).click()
  await signIn(page)
  await expectPending(page, 1)
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
  await expect(page.getByRole('heading', { name: 'Coletar' })).toBeVisible()
  await context.setOffline(true)
  const qr = {
    name: 'qr-etiqueta.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFcAAABXAQAAAABZs+TBAAAA3klEQVR4nM2TMW7CQBBF/yBLprILqkhG7BXoXERyjmS6dJADADfIWUyFO47ASr7AjisjWf5UKNWOyzDVFF9/5s/bFeJVXOCv/qsHA7BnAWymuF446hJ7mp4Xl22hy5m5cvazu+nOzWgqnzc+HywNJelv7kes7CSnlCSN7H27PsD1D8tnKjtteErjPqA2RV36urI0oWJAkRv7gMoxH6iM8wJJ6rU7wcqlIsfvdWfeUDhK439bZ3PXr8/a4JUAQHbpspuPvvkEAHp8rIK7m9yzMj2YLAKwG0ak8fvIm/3BJ3tAbMHKibfMAAAAAElFTkSuQmCC', 'base64'),
  }
  await saveFromGallery(page, qr)
  await saveFromGallery(page, photo, 'MANUAL-00234')
  await expectPending(page, 2)
  await expect(page.getByText('NEWLIFE-00123', { exact: true })).toBeVisible()
  await expect(page.getByText('MANUAL-00234', { exact: true })).toBeVisible()
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
  await page.getByRole('button', { name: 'Fotografar etiqueta' }).click()
  await expect(page.getByText('Código: SN-00042')).toBeVisible()
  const track = await page.locator('video').evaluateHandle(video => (video.srcObject as MediaStream).getVideoTracks()[0])
  await page.getByRole('button', { name: 'Disparar Foto' }).click()
  await page.getByRole('button', { name: 'Usar esta foto' }).click()
  await expect(page.getByLabel(/Código da etiqueta/)).toHaveValue('SN-00042')
  await expect(page.getByText('Código lido pela câmera. Confira antes de salvar.')).toBeVisible()
  await expect.poll(() => track.evaluate(t => t.readyState)).toBe('ended')
  await page.getByRole('button', { name: 'Salvar e parar' }).click()
  await expectPending(page, 1)
  await expect(page.getByText('SN-00042', { exact: true })).toBeVisible()
})

test('lê só o código de barras pela câmera e preenche o campo', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: class {
      async detect() { return [{ rawValue: 'MAC-AABBCC' }] }
    } })
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const stream = canvas.captureStream(5)
      const timer = setInterval(() => {
        if (stream.active) canvas.getContext('2d')!.fillRect(0, 0, 640, 480)
        else clearInterval(timer)
      }, 150)
      return stream
    }
  })
  await context.route('**/api/v1/auth/web/**', route =>
    route.fulfill({ json: { access_token: 'mock', expires_in: 3600, user: technician } }))
  await page.goto('/')
  await signIn(page)
  await technicianNav(page, 'Coletar').click()
  await page.locator('input[type=file]:not([capture])').setInputFiles(photo)
  await page.getByRole('button', { name: 'Ler código de barras com a câmera' }).click()
  await expect(page.getByLabel(/Código da etiqueta/)).toHaveValue('MAC-AABBCC')
  await expect(page.locator('video')).toHaveCount(0)
})

test('com dois códigos na etiqueta, lê o que está sob a linha de mira', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: class {
      async detect(image: HTMLCanvasElement) {
        const h = image.height
        return [
          { rawValue: 'MAC-FORA-DA-MIRA', boundingBox: new DOMRectReadOnly(0, 0, image.width, h * 0.2) },
          { rawValue: 'SN-NA-MIRA', boundingBox: new DOMRectReadOnly(0, h * 0.4, image.width, h * 0.2) },
        ]
      }
    } })
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const stream = canvas.captureStream(5)
      const timer = setInterval(() => {
        if (stream.active) canvas.getContext('2d')!.fillRect(0, 0, 640, 480)
        else clearInterval(timer)
      }, 150)
      return stream
    }
  })
  await context.route('**/api/v1/auth/web/**', route =>
    route.fulfill({ json: { access_token: 'mock', expires_in: 3600, user: technician } }))
  await page.goto('/')
  await signIn(page)
  await technicianNav(page, 'Coletar').click()
  await page.locator('input[type=file]:not([capture])').setInputFiles(photo)
  await page.getByRole('button', { name: 'Ler código de barras com a câmera' }).click()
  await expect(page.getByLabel(/Código da etiqueta/)).toHaveValue('SN-NA-MIRA')
  await expect(page.locator('video')).toHaveCount(0)
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
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
    await context.setOffline(true)
    await saveFromGallery(page, photo, '0001')
    await expectPending(page, 1)
    await context.setOffline(false)

    revision = 2
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
    const update = page.getByRole('button', { name: 'Atualizar aplicativo' })
    await expect(update).toBeVisible()
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), update.click()])
    await expectPending(page, 1)
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
    if (cityMock[path]) return route.fulfill({ json: cityMock[path] })
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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.getByRole('button', { name: /Revisão de fotos/ }).click()
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
  await expectPending(page, 1)
  await expect(page.getByText('Envio interrompido.', { exact: false })).toBeVisible()
  preferredRetry = true
  await page.getByRole('button', { name: 'Sincronizar agora' }).click()
  await expect(page.getByText('Recebida · lendo etiqueta')).toBeVisible()
  expect(uploadRequests).toBe(1)
  expect(durableReceipts).toBe(1)
})

test('sincroniza o código, a OS e a observação da coleta', async ({ page, context }) => {
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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.locator('input[type=file]:not([capture])').setInputFiles(photo)
  await page.getByLabel(/Código da etiqueta/).fill('0001')
  await page.getByLabel(/Ordem de serviço/).fill('OS-10492')
  await page.getByLabel(/Observação/).fill('Carcaça riscada.')
  const request = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/captures')
  await page.getByRole('button', { name: 'Salvar e parar' }).click()
  const body = (await request).postDataJSON()
  expect(body.barcode_evidence).toEqual({ raw_value: '0001', source: 'MANUAL' })
  expect(body.complement).toEqual({ service_order: 'OS-10492', notes: 'Carcaça riscada.' })
})
