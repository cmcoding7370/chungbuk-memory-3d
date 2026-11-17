import { describe, expect, it } from 'vitest'
import { bootstrapUrl, validEndpoint } from '../src/net/connection'
import { BUILD, decodeServerMessage } from '../src/net/protocol'
import { makeInviteUrl } from '../src/net/session'

const game = {
  cards: [
    { id: 'c0', regionId: -1, kind: 'place', revealed: false },
    { id: 'c1', regionId: 2, kind: 'product', revealed: true },
  ],
  players: [{ id: 0, name: '하나', score: 0, collected: [] }, { id: 1, name: '둘', score: 0, collected: [] }],
  turn: 0, phase: 'flip', selectedIds: ['c1'], claimed: [], lastMessage: '진행 중',
}
const snapshot = { type: 'snapshot', build: BUILD, room: 'ABCDEF', revision: 4, status: 'playing', members: [{ id: 0, name: '하나', connected: true }], game }
const decode = (value: unknown) => decodeServerMessage(JSON.stringify(value))

describe('온라인 연결 보안', () => {
  it('document base에 상대적으로 부트스트랩을 찾는다', () => {
    expect(bootstrapUrl('https://example.com/preview/game/')).toBe('https://example.com/preview/game/multiplayer/bootstrap.json')
    expect(bootstrapUrl('https://example.com/preview/index.html?room=SECRET')).toBe('https://example.com/preview/multiplayer/bootstrap.json')
  })
  it('운영 환경은 명시적인 wss 및 정확한 /ws만 허용한다', () => {
    expect(validEndpoint('wss://example.com:443/ws', false)).toBe(true)
    for (const value of ['ws://127.0.0.1:8787/ws', 'https://example.com/ws', 'wss://example.com/ws?token=x', 'wss://example.com/ws#x', 'wss://x:y@example.com/ws', 'wss://example.com/ws/', 'wss://example.com/other', 'wss://example.com/../ws', 'wss://example.com\\evil/ws']) {
      expect(validEndpoint(value, false), value).toBe(false)
    }
  })
  it('개발 환경에서도 loopback ws만 허용한다', () => {
    expect(validEndpoint('ws://localhost:8787/ws', true)).toBe(true)
    expect(validEndpoint('ws://127.0.0.1:8787/ws', true)).toBe(true)
    expect(validEndpoint('ws://[::1]:8787/ws', true)).toBe(true)
    expect(validEndpoint('ws://192.168.1.2:8787/ws', true)).toBe(false)
    expect(validEndpoint('ws://127.0.0.1.evil.com/ws', true)).toBe(false)
    expect(validEndpoint('ws://2130706433/ws', true)).toBe(false)
  })
  it('초대 URL은 기존 쿼리와 해시를 지우고 방만 남긴다', () => {
    const invite = makeInviteUrl('ABCDEF', 'https://example.com/game/?token=secret&server=evil#fragment')
    expect(invite).toBe('https://example.com/game/?room=ABCDEF')
    expect(makeInviteUrl('ABCDEF', 'https://user:pass@example.com/game/')).toBe('https://example.com/game/?room=ABCDEF')
    expect(makeInviteUrl('ABC?token=secret', 'https://example.com/')).toBe('')
  })
})

describe('서버 메시지 검증', () => {
  it('스냅샷의 지정된 필드만 전달하고 숨긴 카드의 정보 유출을 거부한다', () => {
    const result = decode({ ...snapshot, extraSecret: 'must not pass' })
    expect(result).toEqual(snapshot)
    expect(decode({ ...snapshot, game: { ...game, cards: [{ id: 'c0', regionId: 4, kind: 'place', revealed: false }] } })).toBeNull()
    expect(decode({ ...snapshot, game: { ...game, cards: [{ id: 'c0', regionId: -1, kind: 'product', revealed: false }] } })).toBeNull()
    expect(decode({ ...snapshot, game: { ...game, cards: [{ id: 'p0', regionId: -1, kind: 'place', revealed: false }] } })).toBeNull()
  })
  it('잘못된 빌드, 방, revision, 크기와 내부 구조를 거부한다', () => {
    expect(decode({ ...snapshot, build: 'other' })).toBeNull()
    expect(decode({ ...snapshot, room: '../evil' })).toBeNull()
    expect(decode({ ...snapshot, revision: -1 })).toBeNull()
    expect(decode({ ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(decode({ ...snapshot, game: { ...game, turn: 3 } })).toBeNull()
    expect(decode({ ...snapshot, game: { ...game, selectedIds: ['c0'] } })).toBeNull()
    expect(decode({ ...snapshot, members: [{ id: 0, name: '하나', connected: true }, { id: 0, name: '둘', connected: true }] })).toBeNull()
    expect(decodeServerMessage('{bad json')).toBeNull()
    expect(decodeServerMessage('x'.repeat(50_000))).toBeNull()
  })
  it('자리 만료 후 한 명만 남은 서버 게임을 허용한다', () => {
    expect(decode({ ...snapshot, game: { ...game, players: [game.players[0]] } })).not.toBeNull()
  })
  it('welcome, 오류의 필수 필드를 검사한다', () => {
    expect(decode({ ...snapshot, type: 'welcome', seat: 0, token: 'secret' })?.type).toBe('welcome')
    expect(decode({ ...snapshot, type: 'welcome', seat: 1, token: 'secret' })).toBeNull()
    expect(decode({ type: 'error', code: 'BAD', message: '잘못된 요청입니다.', revision: 5 })).toEqual({ type: 'error', code: 'BAD', message: '잘못된 요청입니다.', revision: 5 })
    expect(decode({ type: 'error', code: 'BAD', message: '', revision: 5 })).toBeNull()
  })
  it('ACK 및 오류 actionId는 서버와 같은 문자·길이와 안전한 revision을 요구한다', () => {
    const ack = { type: 'ack', actionId: 'A_z-09', revision: 6 }
    const error = { type: 'error', code: 'STALE_REVISION', message: '바뀌었습니다.', revision: 6, actionId: 'A_z-09' }
    expect(decode(ack)).toEqual(ack)
    expect(decode(error)).toEqual(error)
    expect(decode({ ...ack, actionId: 'a'.repeat(80) })).not.toBeNull()
    for (const actionId of ['', 'a'.repeat(81), 'bad\n', '한글', 'a/b', null, 1, {}]) {
      expect(decode({ ...ack, actionId })).toBeNull()
      expect(decode({ ...error, actionId })).toBeNull()
    }
    expect(decode({ type: 'ack', revision: 1 })).toBeNull()
    expect(decode({ ...ack, revision: -1 })).toBeNull()
    expect(decode({ ...ack, revision: 1.5 })).toBeNull()
    expect(decode({ ...ack, revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(decode({ ...ack, revision: '6' })).toBeNull()
    expect(decode({ ...ack, extra: true })).toBeNull()
    expect(decode({ ...error, revision: null })).toBeNull()
  })
})
