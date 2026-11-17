import { MemoryBoard } from './game/MemoryBoard'
import { createGame, revealCard, resolvePair, nextTurn, type GameState } from './game/memoryRules'
import { MemoryUI, type OnlineView } from './ui/memoryUI'
import { OnlineClient, type OnlineRoom, type OnlineStatus } from './net'

const root = document.querySelector<HTMLElement>('#app')!
let state: GameState = createGame(['참가자 1', '참가자 2'])
let lastLocalNames = ['참가자 1', '참가자 2']
let resolutionTimer: number | null = null
let mode: 'local' | 'online' = 'local'
let onlineRoom: OnlineRoom | null = null
let connectionStatus: OnlineStatus = 'offline'
let connectionMessage = ''
let pendingAction = false
let ui: MemoryUI
let board: MemoryBoard

function clearResolution(): void {
  if (resolutionTimer !== null) window.clearTimeout(resolutionTimer)
  resolutionTimer = null
}

function draw(): void {
  board.setCards(state.cards, state.claimed, state.selectedIds)
  ui.render(state)
}

function canAct(): boolean {
  if (mode !== 'online' || connectionStatus !== 'connected' || pendingAction || !onlineRoom?.game) return false
  const room = onlineRoom
  return room.status === 'playing' && room.members.filter(member => member.connected).length >= 2 &&
    room.game!.players[room.game!.turn]?.id === room.seat
}

function updateOnlineView(): void {
  if (mode !== 'online') {
    ui.setOnline({ active: false, status: 'offline', message: '', room: '', seat: null, canAct: false, isHost: false, canRestart: false, members: [] })
    return
  }
  const room = onlineRoom
  const status: OnlineView['status'] = connectionStatus === 'connecting' ? 'connecting'
    : connectionStatus === 'reconnecting' ? 'reconnecting'
      : connectionStatus === 'error' || connectionStatus === 'offline' ? 'error'
        : room ? room.status : 'connecting'
  const connectedCount = room?.members.filter(member => member.connected).length ?? 0
  const tooFew = (status === 'playing' || status === 'finished') && connectedCount < 2
  const waitingForPlayers = '접속 중인 참가자가 두 명 미만입니다. 재접속 또는 새 참가자를 기다려 주세요.'
  const message = tooFew
    ? (connectionMessage.includes('거절') ? `${connectionMessage} ${waitingForPlayers}` : waitingForPlayers)
    : connectionMessage
  ui.setOnline({
    active: true,
    status,
    message,
    room: room?.room ?? '',
    seat: room?.seat ?? null,
    canAct: canAct(),
    isHost: room?.seat === 0,
    canRestart: connectionStatus === 'connected' && !pendingAction && room?.seat === 0 && !!room.game && connectedCount >= 2,
    members: room?.members ?? [],
  })
}

// The room code is a public invitation, never the private resume credential.
function rememberRoom(room: string | null): void {
  try {
    const url = new URL(window.location.href)
    if (room) url.searchParams.set('room', room)
    else url.searchParams.delete('room')
    window.history.replaceState(window.history.state, '', url)
  } catch { /* An embedded browser may prohibit history writes; the room code remains visible. */ }
}

const online = new OnlineClient({
  onRoom: room => {
    if (mode !== 'online') return
    onlineRoom = room
    connectionStatus = 'connected'
    rememberRoom(room.room)
    clearResolution()
    state = room.game ?? {
      cards: [], players: room.members.map(member => ({ id: member.id, name: member.name, score: 0, collected: [] })),
      turn: 0, phase: 'flip', selectedIds: [], claimed: [], lastMessage: '참가자를 기다리고 있습니다.',
    }
    updateOnlineView()
    ui.hideSetup()
    draw()
  },
  onStatus: (status, message) => {
    if (mode !== 'online') return
    connectionStatus = status
    connectionMessage = message
    if (status !== 'connected' || message.includes('거절') || message.includes('확인했습니다')) pendingAction = false
    if (status === 'connected' && message.includes('요청을 보냈습니다')) pendingAction = true
    updateOnlineView()
  },
})

function start(names: string[]): void {
  mode = 'local'
  online.disconnect()
  onlineRoom = null
  pendingAction = false
  rememberRoom(null)
  lastLocalNames = [...names]
  clearResolution()
  state = createGame(names)
  updateOnlineView()
  draw()
}

function beginOnline(kind: 'create' | 'join', name: string, room = ''): void {
  clearResolution()
  mode = 'online'
  onlineRoom = null
  pendingAction = false
  connectionStatus = 'connecting'
  connectionMessage = '온라인 서버에 연결하고 있습니다.'
  updateOnlineView()
  const attempt = kind === 'create' ? online.create(name) : online.join(room, name)
  void attempt.catch(error => {
    if (mode !== 'online') return
    connectionStatus = 'error'
    connectionMessage = error instanceof Error ? error.message : '서버에 연결할 수 없습니다.'
    pendingAction = false
    updateOnlineView()
  })
}

function clickCard(id: string): void {
  if (state.phase !== 'flip') return
  const card = state.cards.find(item => item.id === id)
  if (!card || card.revealed) return
  if (mode === 'online') {
    if (canAct()) online.sendAction('reveal', id)
    return
  }
  state = revealCard(state, id)
  draw()
  if (state.phase === 'resolving') {
    // In local play only: the online server independently owns the resolution timer and result.
    resolutionTimer = window.setTimeout(() => {
      resolutionTimer = null
      if (mode !== 'local' || state.phase !== 'resolving') return
      state = resolvePair(state)
      draw()
    }, 1400)
  }
}

function copyInvite(): void {
  const url = online.inviteUrl()
  if (!url) throw new Error('초대 링크를 만들 수 없습니다.')
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(url).catch(() => {
      connectionMessage = `초대 링크를 복사하지 못했습니다. 이 주소를 직접 공유해 주세요: ${url}`
      updateOnlineView()
    })
    return
  }
  const input = document.createElement('textarea')
  input.value = url
  input.setAttribute('readonly', '')
  input.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('초대 링크를 복사할 수 없습니다.')
}

try {
  ui = new MemoryUI(root, {
    onStart: start,
    onNextTurn: () => {
      if (mode === 'online') { if (canAct()) online.sendAction('next'); return }
      state = nextTurn(state)
      draw()
    },
    onRestart: () => {
      if (mode === 'online') {
        if (connectionStatus === 'connected' && !pendingAction && onlineRoom?.seat === 0 && onlineRoom.members.filter(member => member.connected).length >= 2) online.sendAction('restart')
        return
      }
      start(state.players.map(player => player.name))
    },
    onZoom: action => { if (action === 'reset') board.resetView(); else board.zoom(action === 'in' ? 0.72 : 1.38) },
    onOnlineCreate: name => beginOnline('create', name),
    onOnlineJoin: (room, name) => beginOnline('join', name, room),
    onOnlineLeave: () => start(lastLocalNames),
    onCopyInvite: copyInvite,
  })
  board = new MemoryBoard(ui.boardElement, clickCard)
  draw()
  document.querySelector('#boot')?.remove()
  if (import.meta.env.DEV) {
    void Promise.all([import('../scripts/manus-tuning/adapter.js'), import('./game/tuning')])
      .then(([adapter, tuning]) => adapter.registerGameTuning(tuning.tuning))
    ;(window as unknown as { __memory: unknown }).__memory = {
      getState: () => state, start, clickCard, cardScreenPoint: (id: string) => board.cardScreenPoint(id),
    }
  }
} catch (error) {
  console.error(error)
  const boot = document.querySelector<HTMLElement>('#boot')
  if (boot) {
    boot.innerHTML = '<strong>게임을 불러오지 못했어요</strong><small>새로고침 후 다시 시도해 주세요.</small><button onclick="location.reload()">다시 시도</button>'
  }
}
