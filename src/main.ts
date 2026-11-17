import { MemoryBoard } from './game/MemoryBoard'
import { createGame, revealCard, resolvePair, nextTurn, type GameState } from './game/memoryRules'
import { MemoryUI } from './ui/memoryUI'

const root = document.querySelector<HTMLElement>('#app')!
let state: GameState = createGame(['참가자 1', '참가자 2'])
let resolutionTimer: number | null = null
let ui: MemoryUI
let board: MemoryBoard

function draw(): void {
  board.setCards(state.cards, state.claimed, state.selectedIds)
  ui.render(state)
}

function clearResolution(): void {
  if (resolutionTimer !== null) window.clearTimeout(resolutionTimer)
  resolutionTimer = null
}

function start(names: string[]): void {
  clearResolution()
  state = createGame(names)
  draw()
}

function clickCard(id: string): void {
  if (state.phase !== 'flip') return
  const card = state.cards.find(item => item.id === id)
  if (!card || card.revealed) return
  state = revealCard(state, id)
  draw()
  if (state.phase === 'resolving') {
    // Let everyone see both 3D cards before the game awards a match or flips a mismatch back.
    resolutionTimer = window.setTimeout(() => {
      resolutionTimer = null
      if (state.phase !== 'resolving') return
      state = resolvePair(state)
      draw()
    }, 1400)
  }
}

try {
  ui = new MemoryUI(root, {
    onStart: start,
    onNextTurn: () => { state = nextTurn(state); draw() },
    onRestart: () => { start(state.players.map(player => player.name)) },
    onZoom: action => { if (action === 'reset') board.resetView(); else board.zoom(action === 'in' ? 0.72 : 1.38) },
  })
  board = new MemoryBoard(ui.boardElement, clickCard)
  draw()
  document.querySelector('#boot')?.remove()
  if (import.meta.env.DEV) {
    void Promise.all([import('../scripts/manus-tuning/adapter.js'), import('./game/tuning')])
      .then(([adapter, tuning]) => adapter.registerGameTuning(tuning.tuning))
    ;(window as unknown as { __memory: unknown }).__memory = { getState: () => state, start, clickCard, cardScreenPoint: (id: string) => board.cardScreenPoint(id) }
  }
} catch (error) {
  console.error(error)
  const boot = document.querySelector<HTMLElement>('#boot')
  if (boot) {
    boot.innerHTML = '<strong>게임을 불러오지 못했어요</strong><small>새로고침 후 다시 시도해 주세요.</small><button onclick="location.reload()">다시 시도</button>'
  }
}
