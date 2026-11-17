import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnlineClient, type OnlineRoom, type OnlineStatus } from '../src/net/onlineClient'
import { BUILD } from '../src/net/protocol'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}
class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static sockets: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.sockets.push(this) }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>) }
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = 1; this.onopen?.() }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
  lose(code = 1006): void { this.readyState = 3; this.onclose?.({ code }) }
}
const held = new Set<string>()
const locks = {
  request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) {
    if (held.has(name)) return callback(null)
    held.add(name)
    return Promise.resolve(callback({})).finally(() => held.delete(name))
  },
}
const members = [{ id: 0, name: '하나', connected: true }, { id: 1, name: '둘', connected: true }]
const game = {
  cards: [{ id: 'c0', regionId: -1, kind: 'place', revealed: false }, { id: 'c1', regionId: -1, kind: 'place', revealed: false }],
  players: [{ id: 0, name: '하나', score: 0, collected: [] }, { id: 1, name: '둘', score: 0, collected: [] }],
  turn: 0, phase: 'flip', selectedIds: [], claimed: [], lastMessage: '진행 중',
}
const welcome = { type: 'welcome', build: BUILD, room: 'ABCDEF', seat: 0, token: 'server-secret', revision: 5, status: 'playing', members, game }
const snapshot = { type: 'snapshot', build: BUILD, room: 'ABCDEF', revision: 6, status: 'playing', members, game }

let rooms: OnlineRoom[]
let statuses: { status: OnlineStatus; message: string }[]
let client: OnlineClient
let storage: MemoryStorage
const waitSocket = async (index: number): Promise<FakeSocket> => {
  await vi.waitFor(() => expect(FakeSocket.sockets[index]).toBeDefined(), { interval: 2, timeout: 1000 })
  return FakeSocket.sockets[index]
}
const waitUntil = async (test: () => void) => vi.waitFor(test, { interval: 2, timeout: 1000 })
async function connected(): Promise<FakeSocket> {
  const pending = client.create('하나')
  const socket = await waitSocket(0)
  socket.open()
  socket.receive(welcome)
  await pending
  return socket
}

beforeEach(() => {
  held.clear()
  FakeSocket.sockets = []
  rooms = []
  statuses = []
  storage = new MemoryStorage()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('navigator', { locks })
  vi.stubGlobal('document', { baseURI: 'https://site.example/game/' })
  vi.stubGlobal('location', { href: 'https://site.example/game/?token=bad&server=bad#fragment' })
  vi.stubGlobal('sessionStorage', storage)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ build: BUILD, signalingUrl: 'wss://server.example/ws', iceTransportPolicy: 'all' }))))
  client = new OnlineClient({ onRoom: room => rooms.push(room), onStatus: (status, message) => statuses.push({ status, message }) })
})
afterEach(() => { client.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('온라인 클라이언트', () => {
  it('미설정 서버는 한국어 오류를 표시하고 실제 또는 가짜 소켓을 만들지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ build: BUILD, signalingUrl: '', iceTransportPolicy: 'all' }))))
    await client.create('하나')
    expect(FakeSocket.sockets).toHaveLength(0)
    expect(statuses.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('아직 설정되지 않았습니다') })
  })
  it('첫 메시지는 hello이고 초대는 방 코드만 포함하며 대기 행동을 중복 전송하지 않는다', async () => {
    const socket = await connected()
    expect(socket.url).toBe('wss://server.example/ws')
    expect(socket.sent[0]).toEqual({ type: 'hello', build: BUILD, mode: 'create', name: '하나' })
    expect(client.inviteUrl()).toBe('https://site.example/game/?room=ABCDEF')
    expect([...storage.values.values()][0]).toContain('server-secret')
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    expect(statuses.at(-1)).toMatchObject({ status: 'connected', message: expect.stringContaining('기다리고') })
    expect(client.sendAction('reveal', 'c1')).toBe(false)
    expect(socket.sent[1]).toMatchObject({ type: 'action', build: BUILD, revision: 5, action: 'reveal', cardId: 'c0' })
    expect(socket.sent[1].actionId).toMatch(/^[0-9a-f]{32}$/)
    expect(rooms.at(-1)?.game?.cards[0]).toEqual({ id: 'c0', regionId: -1, kind: 'place', revealed: false })
    socket.receive({ ...snapshot, revision: 4 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rooms.at(-1)?.revision).toBe(5)
    expect(client.sendAction('next')).toBe(false)
    socket.receive(snapshot)
    await waitUntil(() => expect(rooms.at(-1)?.revision).toBe(6))
    expect(client.sendAction('next')).toBe(false)
    socket.receive({ type: 'ack', actionId: socket.sent[1].actionId, revision: 6 })
    await waitUntil(() => expect(statuses.at(-1)).toEqual({ status: 'connected', message: '서버에서 요청을 확인했습니다.' }))
    expect(client.sendAction('next')).toBe(true)
    expect(socket.sent[2].revision).toBe(6)
    expect(socket.sent[2].actionId).not.toBe(socket.sent[1].actionId)
  })
  it('서버 오류 시 대기를 해제하고 메시지를 전달한다', async () => {
    const socket = await connected()
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    socket.receive({ type: 'error', code: 'NOT_YOUR_TURN', message: '현재 참가자만 행동할 수 있습니다.', revision: 5, actionId: socket.sent[1].actionId })
    await waitUntil(() => expect(statuses.at(-1)).toMatchObject({ status: 'connected', message: expect.stringContaining('현재 참가자') }))
    expect(client.sendAction('reveal', 'c1')).toBe(true)
  })
  it('다른 참가자의 입장 snapshot과 같은 연결의 승격 welcome은 pending을 풀지 않으며 stale 오류만 푼다', async () => {
    const socket = await connected()
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    const actionId = socket.sent[1].actionId
    const joined = [...members, { id: 2, name: '셋', connected: true }]
    socket.receive({ ...snapshot, members: joined })
    await waitUntil(() => expect(rooms.at(-1)?.members).toHaveLength(3))
    expect(client.sendAction('reveal', 'c1')).toBe(false)
    socket.receive({ ...welcome, members: joined, revision: 7 })
    await waitUntil(() => expect(rooms.at(-1)?.revision).toBe(7))
    expect(client.sendAction('reveal', 'c1')).toBe(false)
    socket.receive({ type: 'error', code: 'STALE_REVISION', message: '최신 상태를 확인해 주세요.', revision: 7, actionId })
    await waitUntil(() => expect(statuses.at(-1)).toEqual({ status: 'connected', message: '서버가 요청을 거절했습니다: 최신 상태를 확인해 주세요.' }))
    expect(client.sendAction('reveal', 'c1')).toBe(true)
    expect(socket.sent[2].revision).toBe(7)
  })
  it('늦거나 actionId 없는 오류와 다른 요청 ACK는 새 pending을 해제하지 않는다', async () => {
    const socket = await connected()
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    const oldId = socket.sent[1].actionId
    socket.receive(snapshot)
    socket.receive({ type: 'ack', actionId: oldId, revision: 6 })
    await waitUntil(() => expect(statuses.at(-1)?.message).toBe('서버에서 요청을 확인했습니다.'))
    expect(client.sendAction('reveal', 'c1')).toBe(true)
    const newId = socket.sent[2].actionId
    socket.receive({ type: 'ack', actionId: oldId, revision: 7 })
    socket.receive({ type: 'error', actionId: oldId, code: 'STALE_REVISION', message: '오래된 오류', revision: 7 })
    socket.receive({ type: 'error', code: 'BAD', message: 'ID 없는 오류', revision: 7 })
    socket.receive({ ...snapshot, revision: 7 })
    await waitUntil(() => expect(rooms.at(-1)?.revision).toBe(7))
    expect(statuses.at(-1)?.message).toContain('기다리고')
    expect(client.sendAction('next')).toBe(false)
    socket.receive({ type: 'error', actionId: newId, code: 'INVALID_PHASE', message: '거절', revision: 7 })
    await waitUntil(() => expect(statuses.at(-1)?.message).toBe('서버가 요청을 거절했습니다: 거절'))
    expect(client.sendAction('next')).toBe(true)
  })
  it('ACK가 snapshot보다 먼저 오면 해당 revision을 반영할 때까지 대기한다', async () => {
    const socket = await connected()
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    const actionId = socket.sent[1].actionId
    socket.receive({ type: 'ack', actionId, revision: 8 })
    socket.receive({ ...snapshot, revision: 7 })
    await waitUntil(() => expect(rooms.at(-1)?.revision).toBe(7))
    expect(client.sendAction('next')).toBe(false)
    expect(statuses.at(-1)?.message).toContain('기다리고')
    socket.receive({ ...snapshot, revision: 8 })
    await waitUntil(() => expect(statuses.at(-1)?.message).toBe('서버에서 요청을 확인했습니다.'))
    expect(rooms.at(-1)?.revision).toBe(8)
    expect(client.sendAction('next')).toBe(true)
  })
  it('선행 ACK의 revision에 도달한 welcome만으로는 snapshot 대기를 해제하지 않는다', async () => {
    const socket = await connected()
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    socket.receive({ type: 'ack', actionId: socket.sent[1].actionId, revision: 8 })
    socket.receive({ ...welcome, revision: 8 })
    await waitUntil(() => expect(rooms.at(-1)?.revision).toBe(8))
    expect(client.sendAction('next')).toBe(false)
    socket.receive({ ...snapshot, revision: 8 })
    await waitUntil(() => expect(statuses.at(-1)?.message).toBe('서버에서 요청을 확인했습니다.'))
    expect(client.sendAction('next')).toBe(true)
  })
  it.each([false, true])('관련 없는 snapshot 및 미반영 ACK(%s) 이후에도 시간 초과하면 재접속한다', async futureAck => {
    const socket = await connected()
    vi.useFakeTimers()
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    if (futureAck) socket.receive({ type: 'ack', actionId: socket.sent[1].actionId, revision: 8 })
    socket.receive({ ...snapshot, revision: 7 })
    await vi.advanceTimersByTimeAsync(11_999)
    expect(rooms.at(-1)?.revision).toBe(7)
    expect(client.sendAction('next')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(statuses.at(-1)?.status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    const resumed = FakeSocket.sockets[1]
    resumed.open()
    expect(resumed.sent).toEqual([{ type: 'hello', build: BUILD, mode: 'resume', room: 'ABCDEF', token: 'server-secret' }])
  })
  it('UI의 수정을 내부 revision에 반영하지 않고 다른 방과 역행 상태를 무시한다', async () => {
    const socket = await connected()
    rooms[0].revision = 999
    socket.receive({ ...snapshot, room: 'ZZZZZZ', revision: 100 })
    socket.receive({ ...snapshot, revision: 3 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rooms).toHaveLength(1)
    expect(client.sendAction('reveal', 'c0')).toBe(true)
    expect(socket.sent.at(-1)?.revision).toBe(5)
  })
  it('연결이 끊기면 저장한 자리로 resume하고 불확실한 이전 행동은 재전송하지 않는다', async () => {
    const socket = await connected()
    client.sendAction('reveal', 'c0')
    vi.useFakeTimers()
    socket.lose()
    expect(statuses.at(-1)?.status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    const resumed = FakeSocket.sockets[1]
    expect(resumed).toBeDefined()
    resumed.open()
    expect(resumed.sent).toEqual([{ type: 'hello', build: BUILD, mode: 'resume', room: 'ABCDEF', token: 'server-secret' }])
    resumed.receive({ ...welcome, revision: 6 })
    await Promise.resolve()
    await Promise.resolve()
    expect(rooms.at(-1)?.revision).toBe(6)
    expect(resumed.sent).toHaveLength(1)
  })
  it('4001로 대체되면 재시도하지 않고 저장된 자격을 지운다', async () => {
    const socket = await connected()
    vi.useFakeTimers()
    socket.lose(4001)
    await vi.advanceTimersByTimeAsync(65_000)
    expect(FakeSocket.sockets).toHaveLength(1)
    expect(statuses.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('재접속을 중지') })
    expect(storage.values.size).toBe(0)
  })
  it('60초가 지나면 자동 재접속을 멈춘다', async () => {
    const socket = await connected()
    vi.useFakeTimers()
    socket.lose()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(statuses.at(-1)).toMatchObject({ status: 'offline', message: expect.stringContaining('60초') })
    const count = FakeSocket.sockets.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.sockets).toHaveLength(count)
  })
  it('로비와 서버의 방장 승격 welcome을 반영한다', async () => {
    const pending = client.join('ABCDEF', '둘')
    const socket = await waitSocket(0)
    socket.open()
    socket.receive({ ...welcome, seat: 1, game: null, status: 'waiting', revision: 1 })
    await pending
    expect(rooms.at(-1)).toMatchObject({ seat: 1, status: 'waiting', game: null })
    socket.receive({ ...welcome, seat: 0, game: null, status: 'waiting', revision: 2 })
    await waitUntil(() => expect(rooms.at(-1)).toMatchObject({ seat: 0, revision: 2 }))
  })
  it('복제된 sessionStorage가 있는 다른 탭이 같은 자리를 빼앗지 못한다', async () => {
    await connected()
    const secondStorage = new MemoryStorage()
    secondStorage.values = new Map(storage.values)
    vi.stubGlobal('sessionStorage', secondStorage)
    const other = new OnlineClient({ onRoom: () => {}, onStatus: () => {} })
    const joining = other.join('ABCDEF', '둘')
    const socket = await waitSocket(1)
    socket.open()
    expect(socket.sent[0]).toEqual({ type: 'hello', build: BUILD, mode: 'join', room: 'ABCDEF', name: '둘' })
    other.disconnect()
    await joining
    expect(secondStorage.values.size).toBe(0)
  })
  it('연결 취소는 진행 중인 발견 요청을 중단하며 다시 시도할 수 있다', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const pending = client.create('하나')
    client.disconnect()
    await pending
    expect(FakeSocket.sockets).toHaveLength(0)
    expect(statuses.at(-1)?.status).toBe('offline')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ build: BUILD, signalingUrl: '', iceTransportPolicy: 'all' }))))
    await client.create('하나')
    expect(statuses.at(-1)?.status).toBe('error')
  })
})
