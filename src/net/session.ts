import { validRoom, validToken } from './protocol'

const prefix = 'chungbuk-memory-v1:resume:'
const key = (room: string): string => `${prefix}${room}`

/** Tokens remain in sessionStorage, never in URLs or localStorage. Bind each to its server. */
export function loadResume(room: string, endpoint: string): string {
  if (!validRoom(room)) return ''
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key(room)) ?? 'null')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const saved = value as { endpoint?: unknown; token?: unknown }
      if (saved.endpoint === endpoint && validToken(saved.token)) return saved.token
    }
  } catch { /* Storage can be unavailable, corrupt, or disabled. */ }
  return ''
}

export function storeResume(room: string, endpoint: string, token: string): boolean {
  if (!validRoom(room) || !validToken(token)) return false
  try {
    sessionStorage.setItem(key(room), JSON.stringify({ endpoint, token }))
    return true
  } catch { return false }
}

export function clearResume(room: string): void {
  if (!validRoom(room)) return
  try { sessionStorage.removeItem(key(room)) } catch { /* Storage may be blocked. */ }
}

/**
 * sessionStorage can initially be cloned by window.open. A cross-tab exclusive lock on a hash
 * prevents a cloned token from taking over a live seat. The lock name never contains the token.
 * Without Web Locks, callers may reconnect from memory but must not use persisted credentials.
 */
export async function claimResume(room: string, token: string): Promise<{ supported: boolean; release: (() => void) | null }> {
  if (typeof navigator === 'undefined' || !navigator.locks || !globalThis.crypto?.subtle) return { supported: false, release: null }
  try {
    const bytes = new TextEncoder().encode(`${room}\0${token}`)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    const name = `${prefix}lock:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
    return await new Promise(resolve => {
      void navigator.locks.request(name, { ifAvailable: true, mode: 'exclusive' }, async lock => {
        if (!lock) { resolve({ supported: true, release: null }); return }
        await new Promise<void>(unlock => resolve({ supported: true, release: unlock }))
      }).catch(() => resolve({ supported: true, release: null }))
    })
  } catch { return { supported: false, release: null } }
}

/** Remove ALL existing query parameters and fragments, including accidental secrets. */
export function makeInviteUrl(room: string, href: string = location.href): string {
  if (!validRoom(room)) return ''
  const url = new URL(href)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.searchParams.set('room', room)
  return url.href
}
