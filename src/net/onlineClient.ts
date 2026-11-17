import type { GameState } from '../game/memoryRules'
import { discoverEndpoint } from './connection'
import { BUILD, decodeServerMessage, validCardId, validName, validRoom, type Member, type RoomStatus, type Snapshot, type Welcome } from './protocol'
import { claimResume, clearResume, loadResume, makeInviteUrl, storeResume } from './session'

export interface OnlineRoom {
  room: string
  seat: number
  revision: number
  status: 'waiting' | 'playing' | 'finished'
  members: { id: number; name: string; connected: boolean }[]
  game: GameState | null
}

export type OnlineStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'
type Handlers = { onRoom: (room: OnlineRoom) => void; onStatus: (status: OnlineStatus, message: string) => void }
type Action = 'reveal' | 'next' | 'restart'
type Mode = 'create' | 'join' | 'resume'

const GRACE_MS = 60_000
const HANDSHAKE_MS = 10_000
const ACTION_TIMEOUT_MS = 12_000
const MAX_BUFFERED_BYTES = 64 * 1024

/** The server alone decides card identities, legality, points and all state transitions. */
export class OnlineClient {
  private socket: WebSocket | null = null
  private abort: AbortController | null = null
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private endpoint = ''
  private expectedRoom = ''
  private name = ''
  private mode: Mode = 'create'
  private token = ''
  private tokenRelease: (() => void) | null = null
  private current: OnlineRoom | null = null
  private welcomed = false
  private snapshotRevision = -1
  private pending: { revision: number; actionId: string; ackRevision?: number } | null = null
  private deadline = 0
  private retryMs = 500
  private initialDone: (() => void) | null = null
  private messageChain = Promise.resolve()

  constructor(private readonly handlers: Handlers) {}

  async create(name: string): Promise<void> {
    await this.start('create', '', name)
  }

  async join(room: string, name: string): Promise<void> {
    await this.start('join', room.trim(), name)
  }

  sendAction(action: Action, cardId?: string): boolean {
    const socket = this.socket
    const room = this.current
    if (!room || !this.welcomed || !socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES || this.pending) return false
    if (!['reveal', 'next', 'restart'].includes(action) || (action === 'reveal' ? !validCardId(cardId) : cardId !== undefined)) return false
    let actionId: string
    try {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      actionId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      this.handlers.onStatus('error', '안전한 요청 번호를 만들 수 없습니다. 브라우저 설정을 확인해 주세요.')
      return false
    }
    const command = action === 'reveal'
      ? { type: 'action', build: BUILD, actionId, revision: room.revision, action, cardId }
      : { type: 'action', build: BUILD, actionId, revision: room.revision, action }
    try { socket.send(JSON.stringify(command)) } catch {
      this.handlers.onStatus('error', '요청을 전송하지 못했습니다. 연결 상태를 확인해 주세요.')
      return false
    }
    this.pending = { revision: room.revision, actionId }
    this.handlers.onStatus('connected', '요청을 보냈습니다. 서버 확인을 기다리고 있습니다.')
    if (this.socket !== socket || !this.pending) return true
    // If the connection silently stalls, reconnect for a fresh authoritative snapshot.
    const generation = this.generation
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      if (generation === this.generation && this.pending && this.socket === socket) this.lost(socket, 1006)
    }, ACTION_TIMEOUT_MS)
    return true
  }

  disconnect(): void {
    this.stop()
    this.handlers.onStatus('offline', '온라인 연결을 종료했습니다.')
  }

  inviteUrl(): string {
    return this.current ? makeInviteUrl(this.current.room) : ''
  }

  private async start(mode: 'create' | 'join', room: string, name: string): Promise<void> {
    this.stop()
    const generation = this.generation
    name = name.trim()
    if (!validName(name)) {
      this.handlers.onStatus('error', '이름은 1~24자이며 제어 문자와 <, >, &를 사용할 수 없습니다.')
      return
    }
    if (mode === 'join' && !validRoom(room)) {
      this.handlers.onStatus('error', '올바른 방 코드를 입력해 주세요.')
      return
    }
    this.name = name
    this.mode = mode
    this.expectedRoom = room
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.handlers.onStatus('connecting', '온라인 서버에 연결하고 있습니다.')
    if (generation !== this.generation) return
    try {
      this.endpoint = await discoverEndpoint(signal)
    } catch (error) {
      if (generation === this.generation) this.handlers.onStatus('error', error instanceof Error ? error.message : '온라인 서버에 연결할 수 없습니다.')
      return
    }
    if (generation !== this.generation) return
    if (mode === 'join') {
      const saved = loadResume(room, this.endpoint)
      if (saved) {
        const claim = await claimResume(room, saved)
        if (generation !== this.generation) { claim.release?.(); return }
        if (claim.supported && claim.release) {
          this.token = saved
          this.tokenRelease = claim.release
          this.mode = 'resume'
        } else {
          // Browsers may clone sessionStorage on opening a tab. Never resume a cloned seat.
          clearResume(room)
        }
      }
    }
    if (generation !== this.generation) return
    await new Promise<void>(resolve => {
      this.initialDone = resolve
      this.open(generation)
    })
  }

  private open(generation: number): void {
    if (generation !== this.generation) return
    if (this.deadline && Date.now() >= this.deadline) { this.expired(); return }
    this.clearTimer()
    let socket: WebSocket
    try { socket = new WebSocket(this.endpoint) } catch {
      this.scheduleRetry(generation)
      return
    }
    this.socket = socket
    this.welcomed = false
    this.snapshotRevision = -1
    const wait = this.deadline ? Math.min(HANDSHAKE_MS, Math.max(1, this.deadline - Date.now())) : HANDSHAKE_MS
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.socket === socket && generation === this.generation) this.lost(socket, 1006)
    }, wait)
    socket.onopen = () => {
      if (generation !== this.generation || this.socket !== socket) return
      const hello = this.mode === 'create'
        ? { type: 'hello', build: BUILD, mode: 'create', name: this.name }
        : this.mode === 'join'
          ? { type: 'hello', build: BUILD, mode: 'join', room: this.expectedRoom, name: this.name }
          : { type: 'hello', build: BUILD, mode: 'resume', room: this.expectedRoom, token: this.token }
      try { socket.send(JSON.stringify(hello)) } catch { this.lost(socket, 1006) }
    }
    socket.onmessage = event => {
      if (generation !== this.generation || this.socket !== socket || typeof event.data !== 'string') return
      const message = decodeServerMessage(event.data)
      if (!message) return
      // Serializing also preserves snapshot order while a tab-isolation lock is acquired.
      this.messageChain = this.messageChain.then(async () => {
        if (generation !== this.generation || this.socket !== socket) return
        if (message.type === 'error') {
          if (!this.welcomed) {
            if (this.mode === 'resume') clearResume(this.expectedRoom)
            const text = message.message
            this.stop()
            this.handlers.onStatus('error', `온라인 연결 오류: ${text}`)
          } else if (message.actionId && message.actionId === this.pending?.actionId) {
            // Only the matching action can release this request; late errors are harmless.
            this.clearPending()
            this.handlers.onStatus('connected', `서버가 요청을 거절했습니다: ${message.message}`)
          }
          return
        }
        if (message.type === 'welcome') await this.acceptWelcome(message, socket, generation)
        else if (this.welcomed && message.type === 'snapshot') this.acceptSnapshot(message)
        else if (this.welcomed && message.type === 'ack' && message.actionId === this.pending?.actionId && message.revision > this.pending.revision) {
          this.pending.ackRevision = Math.max(this.pending.ackRevision ?? 0, message.revision)
          this.confirmPending()
        }
      }).catch(() => {
        if (generation === this.generation && this.socket === socket) {
          this.stop()
          this.handlers.onStatus('error', '서버 응답을 처리하지 못했습니다. 다시 시도해 주세요.')
        }
      })
    }
    socket.onclose = event => {
      if (generation === this.generation && this.socket === socket) this.lost(socket, event.code)
    }
  }

  private async acceptWelcome(message: Welcome, socket: WebSocket, generation: number): Promise<void> {
    if ((this.expectedRoom && message.room !== this.expectedRoom) || (this.welcomed && message.token !== this.token)) return
    if (this.current && message.revision < this.current.revision) {
      this.stop()
      this.handlers.onStatus('error', '이전 방 상태로 복구할 수 없습니다. 다시 입장해 주세요.')
      return
    }
    let storageWarning = ''
    if (message.token !== this.token || !this.tokenRelease) {
      const claim = await claimResume(message.room, message.token)
      if (generation !== this.generation || this.socket !== socket) { claim.release?.(); return }
      if (claim.supported && !claim.release) {
        this.stop()
        this.handlers.onStatus('error', '다른 탭에서 이미 이 참가자 자리를 사용하고 있습니다.')
        return
      }
      this.tokenRelease?.()
      this.tokenRelease = claim.release
      if (!claim.supported) storageWarning = ' 이 브라우저에서는 새로고침 후 자리 복구를 사용할 수 없습니다.'
    }
    this.clearTimer()
    this.token = message.token
    this.expectedRoom = message.room
    this.mode = 'resume'
    this.welcomed = true
    this.deadline = 0
    this.retryMs = 500
    if (!storeResume(message.room, this.endpoint, message.token)) storageWarning = ' 브라우저 저장소를 사용할 수 없어 새로고침 후 자리 복구가 불가능합니다.'
    this.setRoom(message, message.seat)
    if (generation !== this.generation || this.socket !== socket) return
    this.finishInitial()
    this.handlers.onStatus('connected', (message.status === 'waiting' ? '방에 입장했습니다. 다른 참가자를 기다리고 있습니다.' : '온라인 방에 연결되었습니다.') + storageWarning)
  }

  private acceptSnapshot(message: Snapshot): void {
    if (!this.current || message.room !== this.current.room || message.revision < this.current.revision) return
    const seat = this.current.seat
    const generation = this.generation
    this.setRoom(message, seat)
    if (generation === this.generation) {
      this.snapshotRevision = message.revision
      this.confirmPending()
    }
  }

  private confirmPending(): void {
    if (!this.pending || this.pending.ackRevision === undefined || !this.current || this.snapshotRevision < this.pending.ackRevision) return
    this.clearPending()
    this.handlers.onStatus('connected', '서버에서 요청을 확인했습니다.')
  }

  private setRoom(message: { room: string; revision: number; status: RoomStatus; members: Member[]; game: GameState | null }, seat: number): void {
    this.current = { room: message.room, seat, revision: message.revision, status: message.status, members: message.members, game: message.game }
    // A UI may modify its copy; it must never mutate the client's authoritative revision/state.
    this.handlers.onRoom(structuredClone(this.current))
  }

  private lost(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return
    this.closeSocket()
    this.clearTimer()
    this.clearPending()
    this.welcomed = false
    if (code === 4001) {
      if (this.expectedRoom) clearResume(this.expectedRoom)
      this.stop()
      this.handlers.onStatus('error', '다른 연결이 이 참가자 자리를 사용하여 재접속을 중지했습니다.')
      return
    }
    if (this.mode !== 'resume' || !this.token) {
      this.stop()
      this.handlers.onStatus('offline', '연결이 끊어졌습니다. 방 만들기 또는 입장을 다시 시도해 주세요.')
      return
    }
    if (!this.deadline) this.deadline = Date.now() + GRACE_MS
    this.handlers.onStatus('reconnecting', '연결이 끊어졌습니다. 60초 안에 기존 자리로 재접속합니다.')
    this.scheduleRetry(this.generation)
  }

  private scheduleRetry(generation: number): void {
    if (generation !== this.generation) return
    if (this.mode !== 'resume' || !this.token) {
      this.stop()
      this.handlers.onStatus('offline', '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.')
      return
    }
    if (!this.deadline) this.deadline = Date.now() + GRACE_MS
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) { this.expired(); return }
    this.clearTimer()
    const delay = Math.min(this.retryMs, remaining)
    this.retryMs = Math.min(5000, Math.ceil(this.retryMs * 1.8))
    this.timer = setTimeout(() => { this.timer = null; this.open(generation) }, delay)
  }

  private expired(): void {
    if (this.expectedRoom) clearResume(this.expectedRoom)
    this.stop()
    this.handlers.onStatus('offline', '재접속 유예 시간 60초가 지났습니다. 방 입장을 다시 시도해 주세요.')
  }

  private clearPending(): void {
    this.pending = null
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer)
    this.pendingTimer = null
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      try { socket.close(1000) } catch { /* Already closed. */ }
    }
  }

  private finishInitial(): void {
    const resolve = this.initialDone
    this.initialDone = null
    resolve?.()
  }

  private stop(): void {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    this.clearTimer()
    this.clearPending()
    this.closeSocket()
    this.tokenRelease?.()
    this.tokenRelease = null
    this.endpoint = ''
    this.expectedRoom = ''
    this.name = ''
    this.token = ''
    this.current = null
    this.mode = 'create'
    this.welcomed = false
    this.snapshotRevision = -1
    this.deadline = 0
    this.retryMs = 500
    this.finishInitial()
  }
}
