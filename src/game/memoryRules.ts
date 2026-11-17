export type Region = {
  id: number
  region: string
  place: string
  product: string
}

export type Card = {
  id: string
  regionId: number
  kind: 'place' | 'product'
  revealed: boolean
}

export type Player = {
  id: number
  name: string
  score: number
}

export type GameState = {
  cards: Card[]
  players: Player[]
  /** Zero-based index into players, not an independent player ID. */
  turn: number
  phase: 'flip' | 'claim' | 'finished'
  /** Number of cards revealed by the active player this turn, at most two. */
  flipsThisTurn: number
  /** IDs of regions whose pairs have already been claimed. */
  claimed: number[]
  lastMessage: string
}

export const REGIONS: Region[] = [
  { id: 0, region: '청주시', place: '상당산성', product: '청원생명쌀' },
  { id: 1, region: '충주시', place: '중앙탑', product: '사과' },
  { id: 2, region: '단양군', place: '도담삼봉', product: '육쪽마늘' },
  { id: 3, region: '제천시', place: '의림지', product: '약초' },
  { id: 4, region: '음성군', place: '감곡매괴성당', product: '청결고추' },
  { id: 5, region: '괴산군', place: '산막이옛길', product: '대학찰옥수수' },
  { id: 6, region: '진천군', place: '농다리', product: '장미' },
  { id: 7, region: '증평군', place: '좌구산천문대', product: '인삼' },
  { id: 8, region: '보은군', place: '법주사', product: '대추' },
  { id: 9, region: '옥천군', place: '부소담악', product: '복숭아' },
  { id: 10, region: '영동군', place: '영국사', product: '포도' },
]

/** Create a game for 2–6 players. The random source must return values in [0, 1). */
export function createGame(names: string[], random: () => number = Math.random): GameState {
  if (names.length < 2 || names.length > 6) {
    throw new RangeError('참가자는 2명 이상 6명 이하여야 합니다.')
  }

  const cards: Card[] = REGIONS.flatMap(({ id }) => [
    { id: `p${id}`, regionId: id, kind: 'place' as const, revealed: false },
    { id: `s${id}`, regionId: id, kind: 'product' as const, revealed: false },
  ])

  // Fisher–Yates: shuffle only the new local array; an injected source makes it reproducible.
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('난수는 0 이상 1 미만이어야 합니다.')
    }
    const j = Math.floor(value * (i + 1))
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }

  return {
    cards,
    players: names.map((name, id) => ({ id, name, score: 0 })),
    turn: 0,
    phase: 'flip',
    flipsThisTurn: 0,
    claimed: [],
    lastMessage: '첫 번째 참가자가 카드 두 장을 차례로 공개하세요.',
  }
}

/** Reveal up to two hidden cards each turn, keeping every revealed card face-up. */
export function revealCard(state: GameState, cardId: string): GameState {
  if (state.phase === 'finished') return { ...state, lastMessage: '이미 게임이 끝났습니다.' }
  if (state.phase !== 'flip') return { ...state, lastMessage: '이번 차례에 카드 두 장을 공개했습니다. 다음 차례로 넘겨 주세요.' }

  const card = state.cards.find((candidate) => candidate.id === cardId)
  if (!card) return { ...state, lastMessage: '존재하지 않는 카드입니다.' }
  if (card.revealed) return { ...state, lastMessage: '이미 공개된 카드입니다.' }

  const cards = state.cards.map((candidate) => candidate.id === cardId ? { ...candidate, revealed: true } : candidate)
  const flipsThisTurn = state.flipsThisTurn + 1
  const done = flipsThisTurn >= 2 || cards.every(candidate => candidate.revealed)
  return {
    ...state,
    cards,
    flipsThisTurn,
    phase: done ? 'claim' : 'flip',
    lastMessage: done
      ? '카드가 공개되었습니다. 짝을 찾거나 다음 차례로 넘기세요.'
      : '카드가 공개되었습니다. 카드 한 장을 더 공개해 주세요.',
  }
}

/** Either card order is accepted; the selected scorer need not be the current player. */
export function claimPair(state: GameState, playerId: number, cardId1: string, cardId2: string): GameState {
  if (state.phase === 'finished') return { ...state, lastMessage: '이미 게임이 끝났습니다.' }

  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return { ...state, lastMessage: '존재하지 않는 참가자입니다.' }
  if (cardId1 === cardId2) return { ...state, lastMessage: '서로 다른 카드 두 장을 선택하세요.' }

  const first = state.cards.find((candidate) => candidate.id === cardId1)
  const second = state.cards.find((candidate) => candidate.id === cardId2)
  if (!first || !second) return { ...state, lastMessage: '존재하지 않는 카드가 있습니다.' }
  if (!first.revealed || !second.revealed) return { ...state, lastMessage: '공개된 카드만 짝으로 선택할 수 있습니다.' }
  if (first.kind === second.kind) return { ...state, lastMessage: '관광지 카드와 특산물 카드를 한 장씩 선택하세요.' }
  if (first.regionId !== second.regionId) return { ...state, lastMessage: '지역이 일치하지 않습니다.' }
  if (state.claimed.includes(first.regionId)) return { ...state, lastMessage: '이미 획득한 지역입니다.' }

  const claimed = [...state.claimed, first.regionId]
  const finished = claimed.length === REGIONS.length
  const regionName = REGIONS.find((region) => region.id === first.regionId)?.region ?? '해당 지역'
  return {
    ...state,
    players: state.players.map((candidate) => candidate.id === playerId
      ? { ...candidate, score: candidate.score + 1 }
      : candidate),
    claimed,
    phase: finished ? 'finished' : state.phase,
    lastMessage: finished
      ? `${player.name}님이 ${regionName} 짝을 획득했습니다. 모든 짝을 찾아 게임이 끝났습니다.`
      : `${player.name}님이 ${regionName} 짝을 획득했습니다.`,
  }
}

/** Advance in player order. Once no cards are hidden, stay in the claim phase. */
export function nextTurn(state: GameState): GameState {
  if (state.phase === 'finished') return { ...state, lastMessage: '이미 게임이 끝났습니다.' }
  if (state.phase !== 'claim') return { ...state, lastMessage: '카드 두 장을 공개한 후에 다음 차례로 넘길 수 있습니다.' }

  const turn = (state.turn + 1) % state.players.length
  const hasHiddenCards = state.cards.some((card) => !card.revealed)
  return {
    ...state,
    turn,
    flipsThisTurn: 0,
    phase: hasHiddenCards ? 'flip' : 'claim',
    lastMessage: hasHiddenCards
      ? `${state.players[turn].name}님의 차례입니다. 카드 두 장을 차례로 공개하세요.`
      : `${state.players[turn].name}님의 차례입니다. 남은 공개된 짝을 획득하세요.`,
  }
}

/** Before completion there are no winners; after completion all top scorers win. */
export function winners(state: GameState): Player[] {
  if (state.phase !== 'finished' || state.players.length === 0) return []
  const topScore = Math.max(...state.players.map((player) => player.score))
  return state.players.filter((player) => player.score === topScore)
}
