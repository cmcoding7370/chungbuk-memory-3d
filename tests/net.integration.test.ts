import { webcrypto } from 'node:crypto'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnlineClient, type OnlineRoom, type OnlineStatus } from '../src/net/onlineClient'
import { BUILD } from '../src/net/protocol'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

afterEach(() => vi.unstubAllGlobals())

const serverAvailable = existsSync(new URL('../server/server.mjs', import.meta.url)) && existsSync(new URL('../server/node_modules/ws/wrapper.mjs', import.meta.url))

describe('실제 서버와 온라인 클라이언트 통합', () => {
  it.skipIf(!serverAvailable)('두 명이 입장하고 숨은 카드 및 공개 결과를 동기화하며 끊긴 자리를 복구한다', async () => {
    const serverUrl = new URL('../server/server.mjs', import.meta.url).href
    const socketUrl = new URL('../server/node_modules/ws/wrapper.mjs', import.meta.url).href
    const { createGameServer } = await import(/* @vite-ignore */ serverUrl)
    const { default: RealSocket } = await import(/* @vite-ignore */ socketUrl)
    const sockets: { terminate: () => void }[] = []
    class TestSocket extends RealSocket {
      constructor(url: string) { super(url, { origin: 'http://localhost:3000' }); sockets.push(this as unknown as { terminate: () => void }) }
    }
    const service = createGameServer({ allowedOrigins: ['http://localhost:3000'] })
    const address = await service.listen(0)
    vi.stubGlobal('WebSocket', TestSocket)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', { baseURI: 'http://localhost:3000/game/' })
    vi.stubGlobal('location', { href: 'http://localhost:3000/game/' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ build: BUILD, signalingUrl: `ws://127.0.0.1:${address.port}/ws`, iceTransportPolicy: 'all' }))))
    const firstStorage = new MemoryStorage()
    const secondStorage = new MemoryStorage()
    const firstRooms: OnlineRoom[] = [], secondRooms: OnlineRoom[] = []
    const firstStatuses: OnlineStatus[] = []
    const first = new OnlineClient({ onRoom: room => firstRooms.push(room), onStatus: status => firstStatuses.push(status) })
    const second = new OnlineClient({ onRoom: room => secondRooms.push(room), onStatus: () => {} })
    try {
      vi.stubGlobal('sessionStorage', firstStorage)
      await first.create('하나')
      expect(firstRooms.at(-1)).toMatchObject({ seat: 0, status: 'waiting', game: null })
      const room = firstRooms.at(-1)!.room
      vi.stubGlobal('sessionStorage', secondStorage)
      await second.join(room, '둘')
      await vi.waitFor(() => expect(firstRooms.at(-1)?.status).toBe('playing'))
      expect(secondRooms.at(-1)?.game?.cards).toHaveLength(22)
      expect(secondRooms.at(-1)?.game?.cards.every(card => card.regionId === -1 && card.kind === 'place' && !card.revealed)).toBe(true)
      const cardId = firstRooms.at(-1)!.game!.cards[0].id
      expect(first.sendAction('reveal', cardId)).toBe(true)
      await vi.waitFor(() => expect(secondRooms.at(-1)?.game?.cards.find(card => card.id === cardId)?.revealed).toBe(true))
      expect(secondRooms.at(-1)?.revision).toBe(firstRooms.at(-1)?.revision)
      vi.stubGlobal('sessionStorage', firstStorage)
      sockets[0].terminate()
      await vi.waitFor(() => expect(firstStatuses).toContain('reconnecting'))
      await vi.waitFor(() => expect(firstStatuses.at(-1)).toBe('connected'), { timeout: 3000 })
      expect(firstRooms.at(-1)).toMatchObject({ room, seat: 0 })
      expect(firstRooms.at(-1)?.members.find(member => member.id === 0)?.connected).toBe(true)
      expect(sockets.length).toBeGreaterThanOrEqual(3)
    } finally {
      first.disconnect()
      second.disconnect()
      await service.close()
    }
  }, 10_000)

  it.skipIf(!serverAvailable)('동시 입장의 snapshot은 보류 중인 오래된 reveal을 승인하지 않는다', async () => {
    const serverUrl = new URL('../server/server.mjs', import.meta.url).href
    const socketUrl = new URL('../server/node_modules/ws/wrapper.mjs', import.meta.url).href
    const { createGameServer } = await import(/* @vite-ignore */ serverUrl)
    const { default: RealSocket } = await import(/* @vite-ignore */ socketUrl)
    const sockets: { send: (raw: string) => void; terminate: () => void }[] = []
    const held: string[] = []
    let holdActions = false
    class TestSocket extends RealSocket {
      constructor(url: string) { super(url, { origin: 'http://localhost:3000' }); sockets.push(this as unknown as { send: (raw: string) => void; terminate: () => void }) }
      send(raw: string) {
        if (sockets[0] === (this as unknown) && holdActions && JSON.parse(raw).type === 'action') { held.push(raw); return }
        super.send(raw)
      }
    }
    const service = createGameServer({ allowedOrigins: ['http://localhost:3000'] })
    const address = await service.listen(0)
    const endpoint = `ws://127.0.0.1:${address.port}/ws`
    vi.stubGlobal('WebSocket', TestSocket)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', { baseURI: 'http://localhost:3000/game/' })
    vi.stubGlobal('location', { href: 'http://localhost:3000/game/' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ build: BUILD, signalingUrl: endpoint, iceTransportPolicy: 'all' }))))
    const firstStorage = new MemoryStorage(), secondStorage = new MemoryStorage()
    const firstRooms: OnlineRoom[] = [], messages: string[] = []
    const first = new OnlineClient({ onRoom: room => firstRooms.push(room), onStatus: (_status, message) => messages.push(message) })
    const second = new OnlineClient({ onRoom: () => {}, onStatus: () => {} })
    let newcomer: { terminate: () => void } | undefined
    try {
      vi.stubGlobal('sessionStorage', firstStorage)
      await first.create('하나')
      const room = firstRooms.at(-1)!.room
      vi.stubGlobal('sessionStorage', secondStorage)
      await second.join(room, '둘')
      await vi.waitFor(() => expect(firstRooms.at(-1)?.status).toBe('playing'))
      const oldRevision = firstRooms.at(-1)!.revision
      holdActions = true
      expect(first.sendAction('reveal', 'c0')).toBe(true)
      expect(held).toHaveLength(1)
      const joining = new RealSocket(endpoint, { origin: 'http://localhost:3000' })
      newcomer = joining
      await new Promise<void>(resolve => joining.once('open', resolve))
      joining.send(JSON.stringify({ type: 'hello', build: BUILD, mode: 'join', room, name: '셋' }))
      await vi.waitFor(() => expect(firstRooms.at(-1)?.members).toHaveLength(3))
      const joinedRevision = firstRooms.at(-1)!.revision
      expect(joinedRevision).toBeGreaterThan(oldRevision)
      expect(first.sendAction('reveal', 'c1')).toBe(false)
      holdActions = false
      sockets[0].send(held[0])
      await vi.waitFor(() => expect(messages.at(-1)).toContain('서버가 요청을 거절했습니다:'))
      expect(firstRooms.at(-1)?.revision).toBe(joinedRevision)
      expect(firstRooms.at(-1)?.game?.cards[0].revealed).toBe(false)
      expect(first.sendAction('reveal', 'c1')).toBe(true)
      await vi.waitFor(() => expect(messages.at(-1)).toBe('서버에서 요청을 확인했습니다.'))
      expect(firstRooms.at(-1)?.game?.cards[1].revealed).toBe(true)
    } finally {
      first.disconnect()
      second.disconnect()
      newcomer?.terminate()
      await service.close()
    }
  }, 10_000)
})
