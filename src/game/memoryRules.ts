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
  /** 획득한 지역 캐릭터의 지역 ID. */
  collected: number[]
}

export type GameState = {
  cards: Card[]
  players: Player[]
  /** Zero-based index into players, not an independent player ID. */
  turn: number
  phase: 'flip' | 'resolving' | 'turnEnd' | 'finished'
  /** IDs revealed during the current turn, until the pair is resolved. */
  selectedIds: string[]
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
    players: names.map((name, id) => ({ id, name, score: 0, collected: [] })),
    turn: 0,
    phase: 'flip',
    selectedIds: [],
    claimed: [],
    lastMessage: '첫 번째 참가자가 카드 두 장을 차례로 공개하세요.',
  }
}

/** Reveal one hidden card immediately; resolving the pair is a separate action. */
export function revealCard(state: GameState, cardId: string): GameState {
  if (state.phase === 'finished') return { ...state, lastMessage: '이미 게임이 끝났습니다.' }
  if (state.phase === 'resolving') return { ...state, lastMessage: '두 카드의 짝을 확인하고 있습니다. 잠시 기다려 주세요.' }
  if (state.phase !== 'flip') return { ...state, lastMessage: '다음 차례 버튼을 눌러 주세요.' }
  if (state.selectedIds.length >= 2) return { ...state, lastMessage: '한 차례에 두 장만 공개할 수 있습니다.' }

  const card = state.cards.find((candidate) => candidate.id === cardId)
  if (!card) return { ...state, lastMessage: '존재하지 않는 카드입니다.' }
  if (card.revealed || state.selectedIds.includes(cardId)) return { ...state, lastMessage: '이미 공개된 카드입니다.' }
  if (state.claimed.includes(card.regionId)) return { ...state, lastMessage: '이미 획득한 지역의 카드입니다.' }

  const selectedIds = [...state.selectedIds, cardId]
  return {
    ...state,
    cards: state.cards.map((candidate) => candidate.id === cardId ? { ...candidate, revealed: true } : candidate),
    selectedIds,
    phase: selectedIds.length === 2 ? 'resolving' : 'flip',
    lastMessage: selectedIds.length === 2
      ? '두 카드의 짝을 확인하고 있습니다. 잠시 기다려 주세요.'
      : '카드 한 장을 더 공개해 주세요.',
  }
}

/** Resolve the two visible cards; call after players have had time to see them. */
export function resolvePair(state: GameState): GameState {
  if (state.phase === 'finished') return { ...state, lastMessage: '이미 게임이 끝났습니다.' }
  if (state.phase !== 'resolving' || state.selectedIds.length !== 2) {
    return { ...state, lastMessage: '카드 두 장을 공개한 후 짝을 확인할 수 있습니다.' }
  }

  const [firstId, secondId] = state.selectedIds
  const first = state.cards.find((card) => card.id === firstId)
  const second = state.cards.find((card) => card.id === secondId)
  if (firstId === secondId || !first || !second || !first.revealed || !second.revealed) {
    return { ...state, lastMessage: '서로 다른 공개된 카드 두 장을 선택해 주세요.' }
  }
  // A claimed character can never be awarded again or have its cards hidden.
  if (state.claimed.includes(first.regionId) || state.claimed.includes(second.regionId)) {
    return { ...state, lastMessage: '이미 획득한 지역의 카드는 다시 선택할 수 없습니다.' }
  }
  const player = state.players[state.turn]
  if (!player) return { ...state, lastMessage: '현재 참가자를 확인할 수 없습니다.' }

  const isPair = first.regionId === second.regionId &&
    ((first.kind === 'place' && second.kind === 'product') ||
     (first.kind === 'product' && second.kind === 'place'))

  if (!isPair) {
    return {
      ...state,
      cards: state.cards.map((card) => card.id === firstId || card.id === secondId
        ? { ...card, revealed: false }
        : card),
      phase: 'turnEnd',
      selectedIds: [],
      lastMessage: '짝이 맞지 않아 두 카드를 다시 뒤집었습니다. 다음 차례 버튼을 눌러 주세요.',
    }
  }

  const claimed = [...state.claimed, first.regionId]
  const finished = REGIONS.every(({ id }) => claimed.includes(id))
  const regionName = REGIONS.find((region) => region.id === first.regionId)?.region ?? '해당 지역'
  return {
    ...state,
    players: state.players.map((candidate, index) => index === state.turn
      ? { ...candidate, score: candidate.score + 1, collected: [...candidate.collected, first.regionId] }
      : candidate),
    claimed,
    selectedIds: [],
    phase: finished ? 'finished' : 'turnEnd',
    lastMessage: finished
      ? `${player.name}님이 ${regionName} 캐릭터를 획득했습니다. 모든 짝을 찾아 게임이 끝났습니다.`
      : `${player.name}님이 ${regionName} 캐릭터를 획득했습니다. 다음 차례 버튼을 눌러 주세요.`,
  }
}

/** Advance only after a resolved turn; games never advance automatically. */
export function nextTurn(state: GameState): GameState {
  if (state.phase === 'finished') return { ...state, lastMessage: '이미 게임이 끝났습니다.' }
  if (state.phase !== 'turnEnd') return { ...state, lastMessage: '카드 두 장의 짝을 확인한 후 다음 차례로 넘길 수 있습니다.' }
  if (state.players.length === 0) return { ...state, lastMessage: '참가자가 없습니다.' }

  const turn = (state.turn + 1) % state.players.length
  return {
    ...state,
    turn,
    phase: 'flip',
    selectedIds: [],
    lastMessage: `${state.players[turn].name}님의 차례입니다. 카드 두 장을 차례로 공개하세요.`,
  }
}

/** Before completion there are no winners; after completion all top scorers win. */
export function winners(state: GameState): Player[] {
  if (state.phase !== 'finished' || state.players.length === 0) return []
  const topScore = Math.max(...state.players.map((player) => player.score))
  return state.players.filter((player) => player.score === topScore)
}
