import type { Card, GameState, Player } from '../game/memoryRules'

export const BUILD = 'chungbuk-memory-v1'
export const MAX_MESSAGE_BYTES = 48 * 1024
export type RoomStatus = 'waiting' | 'playing' | 'finished'
export type Member = { id: number; name: string; connected: boolean }
export type RoomState = { room: string; revision: number; status: RoomStatus; members: Member[]; game: GameState | null }
export type Welcome = RoomState & { type: 'welcome'; build: typeof BUILD; seat: number; token: string }
export type Snapshot = RoomState & { type: 'snapshot'; build: typeof BUILD }
export type Ack = { type: 'ack'; actionId: string; revision: number }
export type ServerError = { type: 'error'; code: string; message: string; revision?: number; actionId?: string }
export type ServerMessage = Welcome | Snapshot | Ack | ServerError

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

/** Room codes are invitations, not credentials. Preserve case and reject rather than silently rewrite. */
export const validRoom = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{6}$/.test(value)
export const validName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && [...value].length >= 1 && [...value].length <= 24 && !/[\u0000-\u001f\u007f-\u009f<>&]/u.test(value)
export const validToken = (value: unknown): value is string => text(value, 512)
export const validCardId = (value: unknown): value is string =>
  typeof value === 'string' && /^c(?:[0-9]|1[0-9]|2[01])$/.test(value)
export const validActionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[^A-Za-z0-9_-]/.test(value)

function parseMember(value: unknown): Member | null {
  if (!record(value) || !uint(value.id) || value.id > 5 || !validName(value.name) || typeof value.connected !== 'boolean') return null
  return { id: value.id, name: value.name, connected: value.connected }
}

function parsePlayer(value: unknown): Player | null {
  if (!record(value) || !uint(value.id) || value.id > 5 || !validName(value.name) || !uint(value.score) || value.score > 11 || !Array.isArray(value.collected)) return null
  if (value.collected.length > 11 || !value.collected.every(id => uint(id) && id <= 10) || new Set(value.collected).size !== value.collected.length) return null
  return { id: value.id, name: value.name, score: value.score, collected: [...value.collected] as number[] }
}

function parseCard(value: unknown): Card | null {
  if (!record(value) || !validCardId(value.id) || typeof value.revealed !== 'boolean') return null
  if (value.revealed) {
    if (!uint(value.regionId) || value.regionId > 10 || (value.kind !== 'place' && value.kind !== 'product')) return null
  } else if (value.regionId !== -1 || value.kind !== 'place') {
    // A hidden card must not expose its real identity, even if the UI would not draw it.
    return null
  }
  return { id: value.id, regionId: value.regionId as number, kind: value.kind as Card['kind'], revealed: value.revealed }
}

function parseGame(value: unknown): GameState | null | undefined {
  if (value === null) return null
  if (!record(value) || !Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 22 || !Array.isArray(value.players) || value.players.length < 1 || value.players.length > 6) return undefined
  const cards = value.cards.map(parseCard)
  const players = value.players.map(parsePlayer)
  if (cards.some(card => card === null) || players.some(player => player === null)) return undefined
  const safeCards = cards as Card[]
  const safePlayers = players as Player[]
  if (new Set(safeCards.map(card => card.id)).size !== safeCards.length || new Set(safePlayers.map(player => player.id)).size !== safePlayers.length) return undefined
  if (!uint(value.turn) || value.turn >= safePlayers.length || !['flip', 'resolving', 'turnEnd', 'finished'].includes(value.phase as string)) return undefined
  if (!Array.isArray(value.selectedIds) || value.selectedIds.length > 2 || !value.selectedIds.every(id => validCardId(id) && safeCards.some(card => card.id === id && card.revealed)) || new Set(value.selectedIds).size !== value.selectedIds.length) return undefined
  if (!Array.isArray(value.claimed) || value.claimed.length > 11 || !value.claimed.every(id => uint(id) && id <= 10) || new Set(value.claimed).size !== value.claimed.length) return undefined
  if (typeof value.lastMessage !== 'string' || value.lastMessage.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.lastMessage)) return undefined
  return { cards: safeCards, players: safePlayers, turn: value.turn, phase: value.phase as GameState['phase'], selectedIds: [...value.selectedIds] as string[], claimed: [...value.claimed] as number[], lastMessage: value.lastMessage }
}

/** Parse and copy only specified fields; malformed, oversized or leaking messages are discarded. */
export function decodeServerMessage(rawText: string): ServerMessage | null {
  if (new TextEncoder().encode(rawText).byteLength > MAX_MESSAGE_BYTES) return null
  let raw: unknown
  try { raw = JSON.parse(rawText) } catch { return null }
  if (!record(raw)) return null
  if (raw.type === 'ack') {
    if (Object.keys(raw).some(key => !['type', 'actionId', 'revision'].includes(key)) || !validActionId(raw.actionId) || !uint(raw.revision)) return null
    return { type: 'ack', actionId: raw.actionId, revision: raw.revision }
  }
  if (raw.type === 'error') {
    if (!text(raw.code, 100) || !text(raw.message, 1000) || (raw.revision !== undefined && !uint(raw.revision)) || (raw.actionId !== undefined && !validActionId(raw.actionId))) return null
    return { type: 'error', code: raw.code, message: raw.message,
      ...(raw.revision === undefined ? {} : { revision: raw.revision as number }),
      ...(raw.actionId === undefined ? {} : { actionId: raw.actionId as string }) }
  }
  if ((raw.type !== 'welcome' && raw.type !== 'snapshot') || raw.build !== BUILD || !validRoom(raw.room) || !uint(raw.revision) || !['waiting', 'playing', 'finished'].includes(raw.status as string) || !Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > 6) return null
  const members = raw.members.map(parseMember)
  if (members.some(member => member === null)) return null
  const safeMembers = members as Member[]
  if (new Set(safeMembers.map(member => member.id)).size !== safeMembers.length) return null
  const game = parseGame(raw.game)
  if (game === undefined) return null
  const common = { build: BUILD as typeof BUILD, room: raw.room, revision: raw.revision, status: raw.status as RoomStatus, members: safeMembers, game }
  if (raw.type === 'snapshot') return { type: 'snapshot', ...common }
  if (!uint(raw.seat) || raw.seat > 5 || !validToken(raw.token) || !safeMembers.some(member => member.id === raw.seat)) return null
  return { type: 'welcome', ...common, seat: raw.seat, token: raw.token }
}
