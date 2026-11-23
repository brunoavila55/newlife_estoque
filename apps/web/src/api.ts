import { db, type User, type UserRole } from './db'

type Session = { user: User; access_token: string; expires_in: number }
export type Receipt = { id: string; received: boolean; status: string }
export type Equipment = { id: string; identifiers: { kind: string; raw_value: string; normalized_value: string }[] }
export type Inventory = { items: Equipment[]; next_cursor: string | null }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

let session: (Session & { expiresAt: number }) | undefined
let renewing: Promise<Session> | undefined
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
        body?.message ?? 'O servidor está indisponível. Tente novamente.')
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
  if ((fresh.user.role ?? 'technician') !== 'technician') await db.profiles.delete('current')
  else await remember(fresh.user)
  session = { ...fresh, expiresAt: Date.now() + fresh.expires_in * 1000 }
  return fresh.user
}

export async function leave(): Promise<void> {
  await withWebSessionLock(() => request('/auth/web/logout', { method: 'POST', headers: { 'X-Stock-Web': '1' } }))
  await lockDevice()
}

export async function lockDevice(): Promise<void> {
  session = undefined
  await db.profiles.delete('current')
}

async function renew(owner: string, role: UserRole = 'technician'): Promise<Session> {
  renewing ??= webSession('refresh').finally(() => { renewing = undefined })
  const fresh = await renewing
  // Outra aba pode ter entrado com uma conta diferente enquanto a requisição estava em andamento.
  if (fresh.user.id !== owner || role !== (fresh.user.role ?? 'technician')) {
    throw new ApiError(401, 'ACCOUNT_CHANGED', 'Entre novamente com a conta autorizada.')
  }
  if (role === 'technician') await db.transaction('rw', db.profiles, async () => {
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
  return signedRequest(owner, path, input, 'warehouse_clerk')
}

async function signedRequest<T>(owner: string, path: string, input: RequestInit, role: UserRole): Promise<T> {
  const active = session?.user.id === owner && Date.now() < session.expiresAt ? session : await renew(owner, role)
  const send = (token: string) => {
    const headers = new Headers(input.headers)
    headers.set('Authorization', 'Bearer ' + token)
    return request<T>(path, { ...input, headers })
  }
  try {
    return await send(active.access_token)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    const next = session?.user.id === owner && session !== active ? session : await renew(owner, role)
    return send(next.access_token)
  }
}
