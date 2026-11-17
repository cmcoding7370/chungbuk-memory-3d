import { MemoryBoard } from './game/MemoryBoard'
import { createGame, revealCard, claimPair, nextTurn, winners, type GameState } from './game/memoryRules'
import { MemoryUI } from './ui/memoryUI'

const root = document.querySelector<HTMLElement>('#app')!
let state: GameState = createGame(['참가자 1', '참가자 2'])
let claimingPlayer: number | null = null
let selectedIds: string[] = []
let resultShown = false
let ui: MemoryUI
let board: MemoryBoard

function draw(): void {
  board.setCards(state.cards, state.claimed, selectedIds)
  ui.render(state, claimingPlayer, selectedIds)
  if (state.phase === 'finished' && !resultShown) {
    resultShown = true
    ui.showResult(winners(state).map(player => player.name))
  }
}

function start(names: string[]): void {
  state = createGame(names)
  claimingPlayer = null
  selectedIds = []
  resultShown = false
  draw()
}

function clickCard(id: string): void {
  const card = state.cards.find(item => item.id === id)
  if (!card || state.phase === 'finished') return
  if (claimingPlayer !== null) {
    if (!card.revealed || state.claimed.includes(card.regionId) || selectedIds.includes(id)) return
    selectedIds.push(id)
    if (selectedIds.length === 2) {
      state = claimPair(state, claimingPlayer, selectedIds[0], selectedIds[1])
      selectedIds = []
      claimingPlayer = null
    }
  } else if (state.phase === 'flip' && !card.revealed) {
    state = revealCard(state, id)
  }
  draw()
}

try {
  ui = new MemoryUI(root, {
    onStart: start,
    onClaimPlayer: id => {
      if (claimingPlayer !== null || state.phase === 'finished') return
      claimingPlayer = id; selectedIds = []; draw()
    },
    onNextTurn: () => { claimingPlayer = null; selectedIds = []; state = nextTurn(state); draw() },
    onRestart: () => { start(state.players.map(player => player.name)) },
    onCancelClaim: () => { claimingPlayer = null; selectedIds = []; draw() },
    onZoom: action => { if (action === 'reset') board.resetView(); else board.zoom(action === 'in' ? 0.72 : 1.38) },
  })
  board = new MemoryBoard(ui.boardElement, clickCard)
  draw()
  document.querySelector('#boot')?.remove()
  if (import.meta.env.DEV) {
    void Promise.all([import('../scripts/manus-tuning/adapter.js'), import('./game/tuning')])
      .then(([adapter, tuning]) => adapter.registerGameTuning(tuning.tuning))
    ;(window as unknown as { __memory: unknown }).__memory = { getState: () => state, start, clickCard }
  }
} catch (error) {
  console.error(error)
  const boot = document.querySelector<HTMLElement>('#boot')
  if (boot) {
    boot.innerHTML = '<strong>게임을 불러오지 못했어요</strong><small>새로고침 후 다시 시도해 주세요.</small><button onclick="location.reload()">다시 시도</button>'
  }
}
