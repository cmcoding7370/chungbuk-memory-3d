import { describe, expect, it, vi } from 'vitest'
import {
  REGIONS,
  createGame,
  nextTurn,
  resolvePair,
  revealCard,
  winners,
  type GameState,
} from '../src/game/memoryRules'

const makeGame = (names = ['가', '나', '다']) => createGame(names, () => 0.5)

function freezeState(state: GameState): GameState {
  state.cards.forEach(Object.freeze)
  state.players.forEach((player) => {
    Object.freeze(player.collected)
    Object.freeze(player)
  })
  Object.freeze(state.cards)
  Object.freeze(state.players)
  Object.freeze(state.selectedIds)
  Object.freeze(state.claimed)
  return Object.freeze(state)
}

function expectMessageOnly(before: GameState, after: GameState, message?: RegExp): void {
  expect(after.lastMessage).toBeTruthy()
  if (message) expect(after.lastMessage).toMatch(message)
  expect({ ...after, lastMessage: before.lastMessage }).toEqual(before)
}

function isRevealed(state: GameState, cardId: string): boolean | undefined {
  return state.cards.find((card) => card.id === cardId)?.revealed
}

function selectPair(state: GameState, first: string, second: string): GameState {
  return revealCard(revealCard(state, first), second)
}

function playMatch(state: GameState, regionId: number): GameState {
  return resolvePair(selectPair(state, `p${regionId}`, `s${regionId}`))
}

function completeGame(names: string[]): GameState {
  let state = makeGame(names)
  for (const { id } of REGIONS) {
    if (id > 0) state = nextTurn(state)
    state = playMatch(state, id)
  }
  return state
}

describe('지역 및 게임 준비', () => {
  it('기존 11개 지역의 데이터와 관광지·특산물 카드 형태를 유지한다', () => {
    expect(REGIONS).toEqual([
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
    ])
    const state = makeGame()
    expect(state.cards).toHaveLength(22)
    expect(new Set(state.cards.map((card) => card.id)).size).toBe(22)
    REGIONS.forEach(({ id }) => {
      expect(state.cards).toContainEqual({ id: `p${id}`, regionId: id, kind: 'place', revealed: false })
      expect(state.cards).toContainEqual({ id: `s${id}`, regionId: id, kind: 'product', revealed: false })
    })
  })

  it('2~6명만 허용하고 참가자 순서와 빈 캐릭터 소유 목록을 만든다', () => {
    for (let count = 2; count <= 6; count += 1) {
      const names = Array.from({ length: count }, (_, i) => `참가자${i}`)
      const state = makeGame(names)
      expect(state.players).toEqual(names.map((name, id) => ({ id, name, score: 0, collected: [] })))
      expect(new Set(state.players.map((player) => player.collected)).size).toBe(count)
      expect(state).toMatchObject({ turn: 0, phase: 'flip', selectedIds: [], claimed: [] })
      expect(Object.keys(state).sort()).toEqual(['cards', 'players', 'turn', 'phase', 'selectedIds', 'claimed', 'lastMessage'].sort())
      names[0] = '변경'
      expect(state.players[0].name).toBe('참가자0')
    }
    for (const count of [0, 1, 7, 10]) {
      expect(() => makeGame(Array.from({ length: count }, () => '참가자'))).toThrow(/2명 이상 6명 이하/)
    }
  })

  it('Fisher–Yates 셔플은 주입된 난수를 21번 사용하며 모든 카드를 보존한다', () => {
    const random = vi.fn(() => 0)
    const first = createGame(['가', '나'], random)
    const second = createGame(['가', '나'], () => 0)
    const unchanged = createGame(['가', '나'], () => 0.999999)
    const originalIds = REGIONS.flatMap(({ id }) => [`p${id}`, `s${id}`])
    expect(random).toHaveBeenCalledTimes(21)
    expect(first.cards).toEqual(second.cards)
    expect(first.cards.map((card) => card.id)).toEqual([...originalIds.slice(1), originalIds[0]])
    expect(unchanged.cards.map((card) => card.id)).toEqual(originalIds)
    expect(new Set(first.cards.map((card) => card.id))).toEqual(new Set(originalIds))
  })

  it('범위를 벗어나거나 유한하지 않은 난수는 거부한다', () => {
    for (const value of [-0.1, 1, Number.NaN, Infinity, -Infinity]) {
      expect(() => createGame(['가', '나'], () => value)).toThrow(/난수/)
    }
  })
})

describe('카드 공개와 지연 판정', () => {
  it('첫 장과 둘째 장을 각각 즉시 앞면으로 보이되 판정 전에는 득점하지 않는다', () => {
    const initial = freezeState(makeGame())
    const first = freezeState(revealCard(initial, 'p0'))
    expect(initial.cards.every((card) => !card.revealed)).toBe(true)
    expect(isRevealed(first, 'p0')).toBe(true)
    expect(first).toMatchObject({ turn: 0, phase: 'flip', selectedIds: ['p0'], claimed: [] })
    expect(first.players.map((player) => player.score)).toEqual([0, 0, 0])

    const second = freezeState(revealCard(first, 's0'))
    expect(isRevealed(first, 's0')).toBe(false)
    expect(isRevealed(second, 'p0')).toBe(true)
    expect(isRevealed(second, 's0')).toBe(true)
    expect(second).toMatchObject({ turn: 0, phase: 'resolving', selectedIds: ['p0', 's0'], claimed: [] })
    expect(second.players.map((player) => [player.score, player.collected])).toEqual([[0, []], [0, []], [0, []]])
    expectMessageOnly(second, revealCard(second, 'p1'), /기다려/)
    expectMessageOnly(second, nextTurn(second))
    expect(winners(second)).toEqual([])
  })

  it('틀린 카드는 외부에서 판정할 때까지 앞면이고 판정 후에만 다시 뒷면이 된다', () => {
    vi.useFakeTimers()
    try {
      let state = freezeState(selectPair(makeGame(), 'p0', 's1'))
      setTimeout(() => { state = freezeState(resolvePair(state)) }, 1200)
      vi.advanceTimersByTime(1199)
      expect(state.phase).toBe('resolving')
      expect(state.selectedIds).toEqual(['p0', 's1'])
      expect(isRevealed(state, 'p0')).toBe(true)
      expect(isRevealed(state, 's1')).toBe(true)
      vi.advanceTimersByTime(1)
      expect(state).toMatchObject({ turn: 0, phase: 'turnEnd', selectedIds: [], claimed: [] })
      expect(isRevealed(state, 'p0')).toBe(false)
      expect(isRevealed(state, 's1')).toBe(false)
      expect(state.players.map((player) => [player.score, player.collected])).toEqual([[0, []], [0, []], [0, []]])
      expect(state.lastMessage).toMatch(/맞지 않아/)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['p0', 'p1'], ['s0', 's1'], ['p0', 's1'], ['s0', 'p1'],
  ])('잘못된 짝 %s, %s을 닫고 획득한 다른 카드는 앞면으로 유지한다', (first, second) => {
    const claimed = freezeState(playMatch(makeGame(), 2))
    const ready = freezeState(nextTurn(claimed))
    const showing = freezeState(selectPair(ready, first, second))
    const after = freezeState(resolvePair(showing))
    expect(after).toMatchObject({ turn: 1, phase: 'turnEnd', selectedIds: [], claimed: [2] })
    expect(isRevealed(showing, first)).toBe(true)
    expect(isRevealed(showing, second)).toBe(true)
    expect(isRevealed(after, first)).toBe(false)
    expect(isRevealed(after, second)).toBe(false)
    expect(isRevealed(after, 'p2')).toBe(true)
    expect(isRevealed(after, 's2')).toBe(true)
    expect(after.players).toEqual(claimed.players)
  })

  it('존재하지 않는 카드와 첫 장을 다시 클릭해도 선택 횟수를 소비하지 않는다', () => {
    const initial = freezeState(makeGame())
    expectMessageOnly(initial, revealCard(initial, '없는 카드'), /존재하지 않는 카드/)
    const first = freezeState(revealCard(initial, 'p0'))
    expectMessageOnly(first, revealCard(first, 'p0'), /이미 공개된 카드/)
    expectMessageOnly(first, revealCard(first, '없는 카드'), /존재하지 않는 카드/)
    expect(first.selectedIds).toEqual(['p0'])
    expect(selectPair(initial, 'p0', 's0').phase).toBe('resolving')
  })
})

describe('자동 캐릭터 획득과 차례 전환', () => {
  it.each([['p0', 's0'], ['s0', 'p0']])('순서와 관계없이 %s, %s 짝을 현재 참가자에게 자동 지급한다', (first, second) => {
    const ready = freezeState(selectPair(makeGame(), first, second))
    const result = freezeState(resolvePair(ready))
    expect(result).toMatchObject({ turn: 0, phase: 'turnEnd', selectedIds: [], claimed: [0] })
    expect(result.players).toEqual([
      { id: 0, name: '가', score: 1, collected: [0] },
      { id: 1, name: '나', score: 0, collected: [] },
      { id: 2, name: '다', score: 0, collected: [] },
    ])
    expect(result.lastMessage).toMatch(/가님.*청주시.*캐릭터.*획득/)
    expect(isRevealed(result, first)).toBe(true)
    expect(isRevealed(result, second)).toBe(true)
    expect(ready.players[0]).toMatchObject({ score: 0, collected: [] })
    expect(ready.selectedIds).toEqual([first, second])
    expect(ready.claimed).toEqual([])
  })

  it('현재 turn은 플레이어 ID가 아닌 배열 인덱스이며 다른 참가자는 득점하지 않는다', () => {
    const game = makeGame()
    const ready = freezeState({
      ...game,
      players: game.players.map((player, index) => ({ ...player, id: [91, 42, 91][index] })),
      turn: 1,
    })
    const result = freezeState(playMatch(ready, 3))
    expect(result.players.map((player) => player.score)).toEqual([0, 1, 0])
    expect(result.players.map((player) => player.collected)).toEqual([[], [3], []])
    expect(result.lastMessage).toMatch(/나님.*제천시/)
    expect(ready.players[1].collected).toEqual([])
  })

  it('이미 획득한 카드는 선택하거나 중복 획득할 수 없다', () => {
    const acquired = freezeState(playMatch(makeGame(), 0))
    expectMessageOnly(acquired, resolvePair(acquired))
    expectMessageOnly(acquired, revealCard(acquired, 'p1'))
    const next = freezeState(nextTurn(acquired))
    expectMessageOnly(next, revealCard(next, 'p0'), /이미 공개된 카드/)
    expectMessageOnly(next, revealCard(next, 's0'), /이미 공개된 카드/)
    expect(next.players.map((player) => [player.score, player.collected])).toEqual([[1, [0]], [0, []], [0, []]])
    const forged = freezeState({ ...next, phase: 'resolving', selectedIds: ['p0', 's0'] })
    expectMessageOnly(forged, resolvePair(forged), /이미 획득/)
    expect(isRevealed(forged, 'p0')).toBe(true)
    expect(isRevealed(forged, 's0')).toBe(true)
  })

  it('공개 전, 첫 공개 후, 판정 중에는 넘길 수 없고 판정 후 버튼으로만 순환한다', () => {
    for (let count = 2; count <= 6; count += 1) {
      let state = freezeState(makeGame(Array.from({ length: count }, (_, i) => `참가자${i}`)))
      for (let i = 0; i < count + 1; i += 1) {
        expectMessageOnly(state, nextTurn(state))
        const first = freezeState(revealCard(state, `p${i}`))
        expectMessageOnly(first, nextTurn(first))
        const second = freezeState(revealCard(first, `s${i}`))
        expectMessageOnly(second, nextTurn(second))
        const resolved = freezeState(resolvePair(second))
        expect(resolved).toMatchObject({ turn: i % count, phase: 'turnEnd', selectedIds: [] })
        expect(resolved.players[i % count].collected).toContain(i)
        state = freezeState(nextTurn(resolved))
        expect(state).toMatchObject({ turn: (i + 1) % count, phase: 'flip', selectedIds: [] })
        expect(state.cards).toEqual(resolved.cards)
        expect(state.players).toEqual(resolved.players)
        expect(state.lastMessage).toContain(`참가자${(i + 1) % count}`)
        expect(resolved.turn).toBe(i % count)
      }
    }
  })

  it('실패한 카드도 다음 참가자가 다시 열어 짝을 맞힐 수 있다', () => {
    const failed = freezeState(resolvePair(selectPair(makeGame(), 'p0', 's1')))
    const next = freezeState(nextTurn(failed))
    const match = freezeState(playMatch(next, 0))
    expect(match.players.map((player) => [player.score, player.collected])).toEqual([[0, []], [1, [0]], [0, []]])
    expect(match.claimed).toEqual([0])
    expect(match.turn).toBe(1)
    expect(isRevealed(match, 'p0')).toBe(true)
    expect(isRevealed(match, 's0')).toBe(true)
    expect(isRevealed(match, 's1')).toBe(false)
  })

  it('판정 단계가 아니거나 유효한 두 카드가 아니면 상태나 점수를 바꾸지 않는다', () => {
    const initial = freezeState(makeGame())
    const first = freezeState(revealCard(initial, 'p0'))
    expectMessageOnly(initial, resolvePair(initial))
    expectMessageOnly(first, resolvePair(first))
    const both = freezeState(revealCard(first, 's0'))
    const badSelections = [[], ['p0'], ['p0', 's0', 'p1'], ['p0', 'p0'], ['p0', 'missing'], ['p0', 'p1']]
    for (const selectedIds of badSelections) {
      const bad = freezeState({ ...both, selectedIds })
      expectMessageOnly(bad, resolvePair(bad))
    }
  })
})

describe('종료, 우승 및 다시 시작', () => {
  it('11번째 짝의 판정에서만 종료하고 최고 점수 참가자가 모두 공동 우승한다', () => {
    let state = makeGame()
    for (let id = 0; id < 10; id += 1) {
      if (id > 0) state = nextTurn(state)
      state = freezeState(playMatch(state, id))
      expect(state.phase).toBe('turnEnd')
      expect(winners(state)).toEqual([])
    }
    const before = freezeState(selectPair(nextTurn(state), 'p10', 's10'))
    expect(before.phase).toBe('resolving')
    expect(before.claimed).toHaveLength(10)
    expect(winners(before)).toEqual([])
    const finished = freezeState(resolvePair(before))
    expect(finished).toMatchObject({ phase: 'finished', selectedIds: [], turn: 1 })
    expect(finished.claimed).toEqual(REGIONS.map((region) => region.id))
    expect(finished.players.map((player) => player.score)).toEqual([4, 4, 3])
    expect(finished.players.map((player) => player.collected)).toEqual([[0, 3, 6, 9], [1, 4, 7, 10], [2, 5, 8]])
    expect(winners(finished)).toEqual([finished.players[0], finished.players[1]])
    expect(finished.cards.every((card) => card.revealed)).toBe(true)
    expect(before.claimed).toHaveLength(10)
    expect(before.players[1].collected).toEqual([1, 4, 7])
    expect(finished.lastMessage).toMatch(/모든 짝.*게임이 끝/)
    expectMessageOnly(finished, revealCard(finished, 'p0'), /게임이 끝/)
    expectMessageOnly(finished, resolvePair(finished), /게임이 끝/)
    expectMessageOnly(finished, nextTurn(finished), /게임이 끝/)
  })

  it('최고 점수가 유일하면 한 명만 우승한다', () => {
    const state = freezeState(completeGame(['가', '나']))
    expect(state.players.map((player) => player.score)).toEqual([6, 5])
    expect(state.players.map((player) => player.collected)).toEqual([[0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9]])
    expect(winners(state)).toEqual([state.players[0]])
  })

  it('완료한 게임이나 공개 중인 게임과 독립적으로 새 게임을 시작한다', () => {
    const finished = freezeState(completeGame(['가', '나']))
    const inProgress = freezeState(selectPair(makeGame(['가', '나']), 'p0', 's1'))
    for (const previous of [finished, inProgress]) {
      const fresh = freezeState(createGame(previous.players.map((player) => player.name), () => 0))
      expect(fresh).toMatchObject({ turn: 0, phase: 'flip', selectedIds: [], claimed: [] })
      expect(fresh.cards.every((card) => !card.revealed)).toBe(true)
      expect(fresh.players.map((player) => [player.score, player.collected])).toEqual([[0, []], [0, []]])
      expect(winners(fresh)).toEqual([])
      expect(playMatch(fresh, 0).players[0]).toMatchObject({ score: 1, collected: [0] })
      expect(previous.phase).not.toBe('flip')
    }
    expect(finished.players.map((player) => player.score)).toEqual([6, 5])
    expect(inProgress.selectedIds).toEqual(['p0', 's1'])
  })
})
