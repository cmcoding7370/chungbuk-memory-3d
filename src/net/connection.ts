import { BUILD } from './protocol'

const MAX_BOOTSTRAP_BYTES = 4096
const DISCOVERY_TIMEOUT_MS = 10_000

/** The endpoint is operator-configured, never supplied by the invitation or a query string. */
export function validEndpoint(value: unknown, development = import.meta.env.DEV): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#]/.test(value)) return false
  // Require the literal protocol and path; URL normalization must not hide credentials or paths.
  if (!/^(?:wss|ws):\/\/[^/]+\/ws$/.test(value)) return false
  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password || url.pathname !== '/ws' || url.search || url.hash) return false
    if (url.protocol === 'wss:') return true
    return development && url.protocol === 'ws:' && /^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/ws$/.test(value)
  } catch { return false }
}

export function bootstrapUrl(base: string = document.baseURI): string {
  return new URL('multiplayer/bootstrap.json', base).href
}

export class DiscoveryError extends Error {}

/** Fetch relative to the document base, with no cache and a bounded response. */
export async function discoverEndpoint(signal: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) throw new DiscoveryError('온라인 연결이 취소되었습니다.')
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch(bootstrapUrl(), { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
    if (!response.ok) throw new DiscoveryError('온라인 서버 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
    const length = response.headers.get('content-length')
    if (length && Number(length) > MAX_BOOTSTRAP_BYTES) throw new DiscoveryError('온라인 서버 설정이 올바르지 않습니다.')
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > MAX_BOOTSTRAP_BYTES) {
            void reader.cancel().catch(() => {})
            throw new DiscoveryError('온라인 서버 설정이 올바르지 않습니다.')
          }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError('온라인 서버 설정이 올바르지 않습니다.')
    const config = value as { build?: unknown; signalingUrl?: unknown; iceTransportPolicy?: unknown }
    if (config.build !== BUILD) throw new DiscoveryError('게임과 온라인 서버의 버전이 다릅니다. 새로고침 후 다시 시도해 주세요.')
    if (config.iceTransportPolicy !== 'all' && config.iceTransportPolicy !== 'relay') throw new DiscoveryError('온라인 서버 설정이 올바르지 않습니다.')
    if (config.signalingUrl === '') throw new DiscoveryError('온라인 서버가 아직 설정되지 않았습니다. 관리자에게 문의해 주세요.')
    if (!validEndpoint(config.signalingUrl)) throw new DiscoveryError('온라인 서버 주소가 안전하지 않거나 올바르지 않습니다.')
    return config.signalingUrl
  } catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError(signal.aborted ? '온라인 연결이 취소되었습니다.' : '온라인 서버 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
