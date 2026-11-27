import { db, type User, type UserRole } from './db'

type Session = { user: User; access_token: string; expires_in: number }
export type Receipt = { id: string; received: boolean; status: string }
export type Equipment = { id: string; identifiers: { kind: string; raw_value: string; normalized_value: string }[] }
export type Inventory = { items: Equipment[]; next_cursor: string | null }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: unknown) {
    super(message)
  }
}

let session: (Session & { expiresAt: number }) | undefined
/** Cidade em que o administrador está operando. Estoquistas usam sempre a própria. */
let activeLocation: string | undefined

export function setActiveLocation(id: string | undefined): void {
  activeLocation = id
}
let renewing: Promise<Session> | undefined
const staffAccountKey = 'newlife-staff-account'
const day = 24 * 3600 * 1000

async function request<T>(path: string, input: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch('/api/v1' + path, {
      ...input,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new ApiError(response.status, body?.code ?? 'API_ERROR',
        body?.message ?? 'O servidor está indisponível. Tente novamente.', body)
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  } finally {
    window.clearTimeout(timeout)
  }
}

async function withWebSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  return navigator.locks ? await navigator.locks.request('newlife-web-session', operation) : operation()
}

function webSession(path: string, input?: { login: string; password: string }): Promise<Session> {
  return withWebSessionLock(() => request('/auth/web/' + path, {
    method: 'POST',
    headers: { 'X-Stock-Web': '1', ...(input ? { 'Content-Type': 'application/json' } : {}) },
    body: input ? JSON.stringify(input) : undefined,
  }))
}

async function remember(user: User): Promise<void> {
  await db.profiles.put({ id: user.id, name: user.name, login: user.login, slot: 'current', offlineUntil: Date.now() + day })
}

export async function enter(login: string, password: string): Promise<User> {
  const fresh = await webSession('login', { login, password })
  if (fresh.user.role === 'administrator' || fresh.user.role === 'warehouse_clerk') {
    await db.profiles.delete('current')
    sessionStorage.setItem(staffAccountKey, fresh.user.id)
  } else {
    sessionStorage.removeItem(staffAccountKey)
    await remember(fresh.user)
  }
  session = { ...fresh, expiresAt: Date.now() + fresh.expires_in * 1000 }
  return fresh.user
}

export async function leave(): Promise<void> {
  await withWebSessionLock(() => request('/auth/web/logout', { method: 'POST', headers: { 'X-Stock-Web': '1' } }))
  await lockDevice()
}

export async function lockDevice(): Promise<void> {
  clearAccess()
  await db.profiles.delete('current')
}

type SessionScope = UserRole | 'warehouse'

function matchesScope(user: User, scope: SessionScope): boolean {
  const role = user.role ?? 'technician'
  return scope === 'warehouse' ? role === 'administrator' || role === 'warehouse_clerk' : role === scope
}

async function renew(owner: string, scope: SessionScope = 'technician'): Promise<Session> {
  renewing ??= webSession('refresh').finally(() => { renewing = undefined })
  const fresh = await renewing
  // Outra aba pode ter entrado com uma conta diferente enquanto a requisição estava em andamento.
  if (fresh.user.id !== owner || !matchesScope(fresh.user, scope)) {
    throw new ApiError(401, 'ACCOUNT_CHANGED', 'Entre novamente com a conta autorizada.')
  }
  if (scope === 'technician') await db.transaction('rw', db.profiles, async () => {
    const profile = await db.profiles.get('current')
    if (profile?.id !== owner) {
      throw new ApiError(401, 'ACCOUNT_CHANGED', 'Entre com a conta que registrou estas fotos.')
    }
    await remember(fresh.user)
  })
  session = { ...fresh, expiresAt: Date.now() + fresh.expires_in * 1000 }
  return fresh
}

export async function resumeSession(owner: string): Promise<void> {
  if (session?.user.id !== owner || Date.now() >= session.expiresAt) await renew(owner)
}

export function clearAccess(): void {
  session = undefined
  sessionStorage.removeItem(staffAccountKey)
}

export async function restoreStaff(): Promise<User | undefined> {
  const owner = sessionStorage.getItem(staffAccountKey)
  if (!owner || !navigator.onLine) return
  try {
    const fresh = await webSession('refresh')
    if (fresh.user.id !== owner || (fresh.user.role !== 'administrator' && fresh.user.role !== 'warehouse_clerk')) {
      clearAccess()
      return
    }
    session = { ...fresh, expiresAt: Date.now() + fresh.expires_in * 1000 }
    return fresh.user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) clearAccess()
  }
}

export async function authenticated<T>(owner: string, path: string, input: RequestInit = {}): Promise<T> {
  const profile = await db.profiles.get('current')
  if (profile?.id !== owner) {
    throw new ApiError(401, 'ACCOUNT_CHANGED', 'Entre com a conta que registrou estas fotos.')
  }
  return signedRequest(owner, path, input, 'technician')
}

export function administrator<T>(owner: string, path: string, input: RequestInit = {}): Promise<T> {
  return signedRequest(owner, path, input, 'administrator')
}

export function warehouse<T>(owner: string, path: string, input: RequestInit = {}): Promise<T> {
  return signedRequest(owner, path, input, 'warehouse')
}

async function signedRequest<T>(owner: string, path: string, input: RequestInit, scope: SessionScope): Promise<T> {
  const active = session?.user.id === owner && matchesScope(session.user, scope) && Date.now() < session.expiresAt
    ? session : await renew(owner, scope)
  const send = (token: string) => {
    const headers = new Headers(input.headers)
    headers.set('Authorization', 'Bearer ' + token)
    if (scope !== 'technician' && activeLocation) headers.set('X-Location-Id', activeLocation)
    return request<T>(path, { ...input, headers })
  }
  try {
    return await send(active.access_token)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    const next = session?.user.id === owner && matchesScope(session.user, scope) && session !== active
      ? session : await renew(owner, scope)
    return send(next.access_token)
  }
}
