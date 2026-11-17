import { describe, expect, it, vi } from 'vitest'
import {
  REGIONS,
  claimPair,
  createGame,
  nextTurn,
  revealCard,
  winners,
  type GameState,
} from '../src/game/memoryRules'

const makeGame = (names = ['가', '나', '다']) => createGame(names, () => 0.5)

function freezeState(state: GameState): GameState {
  state.cards.forEach(Object.freeze)
  state.players.forEach(Object.freeze)
  Object.freeze(state.cards)
  Object.freeze(state.players)
  Object.freeze(state.claimed)
  return Object.freeze(state)
}

function expectMessageOnly(before: GameState, after: GameState, message?: RegExp): void {
  if (message) expect(after.lastMessage).toMatch(message)
  else expect(after.lastMessage).toBeTruthy()
  expect({ ...after, lastMessage: before.lastMessage }).toEqual(before)
}

function allCardsRevealed(): GameState {
  let state = makeGame()
  const ids = REGIONS.flatMap(({ id }) => [`p${id}`, `s${id}`])
  ids.forEach((id, index) => {
    state = revealCard(state, id)
    if (index % 2 === 1 && index < ids.length - 1) state = nextTurn(state)
  })
  return state
}

describe('지역 및 게임 준비', () => {
  it('11개 지역의 번호와 카드 원본 데이터를 지정된 순서로 제공한다', () => {
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
  })

  it('22장의 서로 다른 숨겨진 카드와 순서대로 번호가 부여된 참가자를 만든다', () => {
    const names = ['하나', '둘']
    const state = makeGame(names)
    names[0] = '변경'
    expect(state.players).toEqual([{ id: 0, name: '하나', score: 0 }, { id: 1, name: '둘', score: 0 }])
    expect(state).toMatchObject({ turn: 0, flipsThisTurn: 0, phase: 'flip', claimed: [] })
    expect(state.cards).toHaveLength(22)
    expect(new Set(state.cards.map((card) => card.id)).size).toBe(22)
    REGIONS.forEach(({ id }) => {
      expect(state.cards).toContainEqual({ id: `p${id}`, regionId: id, kind: 'place', revealed: false })
      expect(state.cards).toContainEqual({ id: `s${id}`, regionId: id, kind: 'product', revealed: false })
    })
  })

  it('2~6명만 허용하고 참가자 순서를 보존한다', () => {
    for (let count = 2; count <= 6; count += 1) {
      const names = Array.from({ length: count }, (_, i) => `참가자${i}`)
      expect(makeGame(names).players).toEqual(names.map((name, id) => ({ id, name, score: 0 })))
    }
    for (const count of [0, 1, 7, 10]) {
      expect(() => makeGame(Array.from({ length: count }, () => '참가자'))).toThrow(/2명 이상 6명 이하/)
    }
  })

  it('주입된 난수로 재현 가능하게 셔플하고 22장의 모든 카드가 보존된다', () => {
    const random = vi.fn(() => 0)
    const first = createGame(['가', '나'], random)
    const second = createGame(['가', '나'], () => 0)
    const different = createGame(['가', '나'], () => 0.999999)
    expect(random).toHaveBeenCalledTimes(21)
    expect(first.cards).toEqual(second.cards)
    expect(first.cards.map((card) => card.id)).not.toEqual(different.cards.map((card) => card.id))
    const expectedCards = REGIONS.flatMap(({ id }) => [
      { id: `p${id}`, regionId: id, kind: 'place', revealed: false },
      { id: `s${id}`, regionId: id, kind: 'product', revealed: false },
    ])
    for (const state of [first, second, different, makeGame()]) {
      expect(state.cards).toHaveLength(22)
      expect(new Set(state.cards.map((card) => card.id)).size).toBe(22)
      expect(state.cards).toEqual(expect.arrayContaining(expectedCards))
    }
  })

  it('범위를 벗어나거나 유한하지 않은 난수는 거부한다', () => {
    for (const value of [-0.1, 1, Number.NaN, Infinity, -Infinity]) {
      expect(() => createGame(['가', '나'], () => value)).toThrow(/난수/)
    }
  })
})

describe('공개와 차례', () => {
  it('공개 전이나 첫 장 공개 후에는 다음 차례로 넘어갈 수 없다', () => {
    const initial = freezeState(makeGame())
    expectMessageOnly(initial, claimPair(initial, 0, 'p0', 's0'), /공개된 카드만/)
    expectMessageOnly(initial, nextTurn(initial))
    const first = freezeState(revealCard(initial, 'p0'))
    expect(first).toMatchObject({ turn: 0, phase: 'flip', flipsThisTurn: 1 })
    expectMessageOnly(first, nextTurn(first))
  })

  it('한 차례에 두 장을 연속 공개하고 셋째는 거부하며 이전 상태는 변경하지 않는다', () => {
    const initial = freezeState(makeGame())
    const first = freezeState(revealCard(initial, 'p0'))
    expect(initial.cards.every((card) => !card.revealed)).toBe(true)
    expect(first.cards.find((card) => card.id === 'p0')?.revealed).toBe(true)
    expect(first.cards.filter((card) => card.revealed)).toHaveLength(1)
    expect(first).toMatchObject({ turn: 0, phase: 'flip', flipsThisTurn: 1 })

    const second = freezeState(revealCard(first, 's0'))
    expect(first.cards.find((card) => card.id === 's0')?.revealed).toBe(false)
    expect(second.cards.filter((card) => card.revealed).map((card) => card.id).sort()).toEqual(['p0', 's0'])
    expect(second).toMatchObject({ turn: 0, phase: 'claim', flipsThisTurn: 2 })
    expectMessageOnly(second, revealCard(second, 'p1'))
    expect(second.cards.find((card) => card.id === 'p1')?.revealed).toBe(false)
  })

  it('존재하지 않거나 이미 공개된 카드는 거부하고 공개 횟수를 소비하지 않는다', () => {
    const initial = freezeState(makeGame())
    expectMessageOnly(initial, revealCard(initial, '없는 카드'), /존재하지 않는 카드/)
    const first = freezeState(revealCard(initial, 'p0'))
    expectMessageOnly(first, revealCard(first, 'p0'), /이미 공개된 카드/)
    expectMessageOnly(first, revealCard(first, '없는 카드'), /존재하지 않는 카드/)
    expect(first.flipsThisTurn).toBe(1)
    const second = freezeState(revealCard(first, 's0'))
    const next = freezeState(nextTurn(second))
    expect(next).toMatchObject({ turn: 1, phase: 'flip', flipsThisTurn: 0 })
    expectMessageOnly(next, revealCard(next, 'p0'), /이미 공개된 카드/)
    expect(next.cards.find((card) => card.id === 'p0')?.revealed).toBe(true)
    expect(revealCard(next, 'p1')).toMatchObject({ turn: 1, phase: 'flip', flipsThisTurn: 1 })
  })

  it('2~6명에서 두 장 공개 후 참가자 순서대로 순환하고 공개 상태를 유지한다', () => {
    for (let count = 2; count <= 6; count += 1) {
      let state = makeGame(Array.from({ length: count }, (_, i) => `참가자${i}`))
      for (let i = 0; i < count + 1; i += 1) {
        state = revealCard(state, `p${i}`)
        state = revealCard(state, `s${i}`)
        const before = freezeState(state)
        expect(before).toMatchObject({ turn: i % count, phase: 'claim', flipsThisTurn: 2 })
        state = nextTurn(before)
        expect(state).toMatchObject({ turn: (i + 1) % count, phase: 'flip', flipsThisTurn: 0 })
        expect(state.cards).toEqual(before.cards)
        expect(state.cards.filter((card) => card.revealed)).toHaveLength((i + 1) * 2)
        expect(before.turn).toBe(i % count)
      }
    }
  })

  it('마지막 남은 카드가 그 차례의 첫 장이어도 획득 단계로 전환한다', () => {
    // 정상 게임의 22장은 짝수이므로 마지막 한 장만 남은 상태를 직접 구성한다.
    const game = makeGame()
    const before = freezeState({
      ...game,
      cards: game.cards.map((card) => ({ ...card, revealed: card.id !== 'p10' })),
      players: game.players.map((player) => player.id === 0 ? { ...player, score: 1 } : player),
      claimed: [0],
      turn: 1,
      phase: 'flip',
      flipsThisTurn: 0,
    })
    const last = freezeState(revealCard(before, 'p10'))
    expect(before.cards.find((card) => card.id === 'p10')?.revealed).toBe(false)
    expect(last.cards.every((card) => card.revealed)).toBe(true)
    expect(last).toMatchObject({ turn: 1, phase: 'claim', flipsThisTurn: 1, claimed: [0] })
    expect(last.players[0].score).toBe(1)
    const after = nextTurn(last)
    expect(after).toMatchObject({ turn: 2, phase: 'claim', flipsThisTurn: 0, claimed: [0] })
    expect(after.cards).toEqual(last.cards)
    expect(claimPair(after, 0, 'p10', 's10').players[0].score).toBe(2)
  })

  it('모든 카드를 공개한 후 다음 차례로 넘겨도 획득 단계와 공개 상태가 유지된다', () => {
    const before = freezeState(allCardsRevealed())
    expect(before.cards.every((card) => card.revealed)).toBe(true)
    expect(before).toMatchObject({ phase: 'claim', flipsThisTurn: 2 })
    const after = freezeState(nextTurn(before))
    expect(after).toMatchObject({
      turn: (before.turn + 1) % before.players.length,
      phase: 'claim',
      flipsThisTurn: 0,
    })
    expect(after.cards).toEqual(before.cards)
    expect(nextTurn(after)).toMatchObject({
      turn: (after.turn + 1) % after.players.length,
      phase: 'claim',
      flipsThisTurn: 0,
    })
    expect(claimPair(after, 0, 'p0', 's0').players[0].score).toBe(1)
  })
})

describe('짝 획득', () => {
  it('누구나 첫 공개 전, 첫 공개 후, 둘째 공개 후에 공개된 짝을 획득하며 차례와 공개 횟수는 유지된다', () => {
    let state = makeGame()
    state = revealCard(state, 'p0')
    state = revealCard(state, 's0')
    state = nextTurn(state)
    state = revealCard(state, 'p1')
    state = revealCard(state, 's1')
    state = freezeState(nextTurn(state))
    expect(state).toMatchObject({ turn: 2, phase: 'flip', flipsThisTurn: 0 })

    const beforeFirst = freezeState(claimPair(state, 0, 's0', 'p0'))
    expect(beforeFirst).toMatchObject({ turn: 2, phase: 'flip', flipsThisTurn: 0, claimed: [0] })
    expect(beforeFirst.players.map((player) => player.score)).toEqual([1, 0, 0])
    expect(beforeFirst.cards).toEqual(state.cards)
    expect(state.claimed).toEqual([])
    expect(state.players.every((player) => player.score === 0)).toBe(true)

    const first = freezeState(revealCard(beforeFirst, 'p2'))
    const afterFirst = freezeState(claimPair(first, 1, 'p1', 's1'))
    expect(afterFirst).toMatchObject({ turn: 2, phase: 'flip', flipsThisTurn: 1, claimed: [0, 1] })
    expect(afterFirst.players.map((player) => player.score)).toEqual([1, 1, 0])
    expect(afterFirst.cards).toEqual(first.cards)
    expect(first.claimed).toEqual([0])

    const second = freezeState(revealCard(afterFirst, 's2'))
    const afterSecond = freezeState(claimPair(second, 0, 'p2', 's2'))
    expect(afterSecond).toMatchObject({ turn: 2, phase: 'claim', flipsThisTurn: 2, claimed: [0, 1, 2] })
    expect(afterSecond.players.map((player) => player.score)).toEqual([2, 1, 0])
    expect(afterSecond.cards).toEqual(second.cards)
    expect(afterSecond.lastMessage).toMatch(/단양군/)
    const next = freezeState(nextTurn(afterSecond))
    expect(next).toMatchObject({ turn: 0, phase: 'flip', flipsThisTurn: 0, claimed: [0, 1, 2] })
    expect(next.cards).toEqual(afterSecond.cards)
    expect(next.players).toEqual(afterSecond.players)
    const later = revealCard(next, 'p3')
    expect(later.claimed).toEqual([0, 1, 2])
    expect(later.cards.filter((card) => ['p0', 's0', 'p1', 's1', 'p2', 's2'].includes(card.id)).every((card) => card.revealed)).toBe(true)
  })

  it('잘못된 플레이어, 같은 카드, 없는 카드, 숨겨진 카드를 거부한다', () => {
    const state = freezeState(revealCard(makeGame(), 'p0'))
    expectMessageOnly(state, claimPair(state, 99, 'p0', 's0'), /존재하지 않는 참가자/)
    expectMessageOnly(state, claimPair(state, 0, 'p0', 'p0'), /서로 다른 카드/)
    expectMessageOnly(state, claimPair(state, 0, 'p0', '없음'), /존재하지 않는 카드/)
    expectMessageOnly(state, claimPair(state, 0, 'p0', 's0'), /공개된 카드만/)
  })

  it('카드 종류나 지역이 맞지 않으면 메시지 이외의 상태를 변경하지 않는다', () => {
    let state = makeGame()
    state = revealCard(state, 'p0')
    state = revealCard(state, 's1')
    state = nextTurn(state)
    state = freezeState(revealCard(state, 'p1'))
    expect(state).toMatchObject({ turn: 1, phase: 'flip', flipsThisTurn: 1 })
    expectMessageOnly(state, claimPair(state, 0, 'p0', 'p1'), /관광지 카드와 특산물 카드/)
    expectMessageOnly(state, claimPair(state, 0, 'p0', 's1'), /지역이 일치하지/)
    expect(state.players.every((player) => player.score === 0)).toBe(true)
    expect(state.cards.filter((card) => card.revealed)).toHaveLength(3)
  })

  it('이미 획득한 지역은 다시 득점할 수 없다', () => {
    let state = makeGame()
    state = revealCard(state, 'p0')
    state = revealCard(state, 's0')
    state = freezeState(claimPair(state, 1, 'p0', 's0'))
    expectMessageOnly(state, claimPair(state, 2, 's0', 'p0'), /이미 획득/)
    expect(state.players.map((player) => player.score)).toEqual([0, 1, 0])
  })

  it('같은 차례에 여러 사람이 연속으로 여러 쌍을 획득할 수 있다', () => {
    let state = freezeState(allCardsRevealed())
    const turn = state.turn
    const flipsThisTurn = state.flipsThisTurn
    state = claimPair(state, 2, 'p0', 's0')
    state = claimPair(state, 0, 's1', 'p1')
    state = claimPair(state, 2, 'p2', 's2')
    expect(state).toMatchObject({ phase: 'claim', turn, flipsThisTurn })
    expect(state.players.map((player) => player.score)).toEqual([1, 0, 2])
    expect(state.claimed).toEqual([0, 1, 2])
    expect(state.cards.every((card) => card.revealed)).toBe(true)
    expect(winners(state)).toEqual([])
  })
})

describe('종료와 우승', () => {
  it('모든 짝을 얻어야 종료하며 최다 점수인 모든 참가자가 공동 우승한다', () => {
    let state = allCardsRevealed()
    for (let id = 0; id < 10; id += 1) {
      state = claimPair(state, id % 3, `p${id}`, `s${id}`)
      expect(state.phase).toBe('claim')
      expect(winners(state)).toEqual([])
    }
    const before = freezeState(state)
    state = freezeState(claimPair(before, 10 % 3, 'p10', 's10'))
    expect(state.phase).toBe('finished')
    expect(state.turn).toBe(before.turn)
    expect(state.flipsThisTurn).toBe(before.flipsThisTurn)
    expect(state.claimed).toEqual(REGIONS.map((region) => region.id))
    expect(state.players.map((player) => player.score)).toEqual([4, 4, 3])
    expect(winners(state)).toEqual([state.players[0], state.players[1]])
    expect(state.cards.every((card) => card.revealed)).toBe(true)
    expect(before.claimed).toHaveLength(10)

    expectMessageOnly(state, revealCard(state, 'p0'), /게임이 끝/)
    expectMessageOnly(state, claimPair(state, 0, 'p0', 's0'), /게임이 끝/)
    expectMessageOnly(state, nextTurn(state), /게임이 끝/)
    expect(winners(state)).toEqual([state.players[0], state.players[1]])
  })

  it('최고 점수가 유일하면 한 명만 우승한다', () => {
    let state = allCardsRevealed()
    for (let id = 0; id < REGIONS.length; id += 1) {
      state = claimPair(state, id < 6 ? 0 : 1, `p${id}`, `s${id}`)
    }
    expect(state.players.map((player) => player.score)).toEqual([6, 5, 0])
    expect(winners(state)).toEqual([state.players[0]])
  })
})
