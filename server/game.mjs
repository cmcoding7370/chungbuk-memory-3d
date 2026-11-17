import { randomInt } from 'node:crypto';

// Identifiers and names deliberately match src/game/memoryRules.ts, not the asset order.
export const REGIONS = ['청주시', '충주시', '단양군', '제천시', '음성군', '괴산군', '진천군', '증평군', '보은군', '옥천군', '영동군'];

export function createGame(players, draw = randomInt) {
  if (players.length < 2 || players.length > 6) throw new RangeError('참가자는 2명 이상 6명 이하여야 합니다.');
  const identities = REGIONS.flatMap((_, regionId) => [
    { regionId, kind: 'place' }, { regionId, kind: 'product' },
  ]);
  // Shuffle identities, THEN assign slots. Neither c0..c21 nor array position describes an identity.
  for (let i = identities.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError('잘못된 난수입니다.');
    [identities[i], identities[j]] = [identities[j], identities[i]];
  }
  return {
    cards: identities.map((card, index) => ({ id: `c${index}`, ...card, revealed: false })),
    players: players.map(({ id, name }) => ({ id, name, score: 0, collected: [] })),
    turn: 0,
    phase: 'flip',
    selectedIds: [],
    claimed: [],
    lastMessage: '첫 번째 참가자가 카드 두 장을 차례로 공개하세요.',
  };
}

// Always construct a fresh allowlisted view; do not serialize the authoritative state directly.
export function publicGame(game) {
  if (!game) return null;
  return {
    cards: game.cards.map(card => card.revealed
      ? { id: card.id, regionId: card.regionId, kind: card.kind, revealed: true }
      : { id: card.id, regionId: -1, kind: 'place', revealed: false }),
    players: game.players.map(({ id, name, score, collected }) => ({ id, name, score, collected: [...collected] })),
    turn: game.turn,
    phase: game.phase,
    selectedIds: [...game.selectedIds],
    claimed: [...game.claimed],
    lastMessage: game.lastMessage,
  };
}

export function reveal(game, cardId) {
  if (game.phase !== 'flip' || game.selectedIds.length >= 2) return false;
  const card = game.cards.find(candidate => candidate.id === cardId);
  if (!card || card.revealed || game.claimed.includes(card.regionId)) return false;
  card.revealed = true;
  game.selectedIds.push(card.id);
  game.phase = game.selectedIds.length === 2 ? 'resolving' : 'flip';
  game.lastMessage = game.phase === 'resolving' ? '두 카드의 짝을 확인하고 있습니다. 잠시 기다려 주세요.' : '카드 한 장을 더 공개해 주세요.';
  return true;
}

// Winner derivation stays server-authoritative without adding fields to the GameState contract.
export function winnersMessage(game) {
  if (game.phase !== 'finished' || !game.players.length) return '';
  const top = Math.max(...game.players.map(player => player.score));
  const winners = game.players.filter(player => player.score === top).map(player => player.name);
  return `${winners.length > 1 ? '공동 우승' : '우승'}: ${winners.join(', ')}`;
}

export function resolve(game) {
  if (game.phase !== 'resolving' || game.selectedIds.length !== 2) return false;
  const [first, second] = game.selectedIds.map(id => game.cards.find(card => card.id === id));
  if (!first || !second || first === second || !first.revealed || !second.revealed || game.claimed.includes(first.regionId) || game.claimed.includes(second.regionId)) return false;
  const player = game.players[game.turn];
  if (!player) return false;
  if (first.regionId === second.regionId && first.kind !== second.kind) {
    player.score++;
    player.collected.push(first.regionId);
    game.claimed.push(first.regionId);
    game.phase = game.claimed.length === REGIONS.length ? 'finished' : 'turnEnd';
    game.lastMessage = game.phase === 'finished'
      ? `${player.name}님이 ${REGIONS[first.regionId]} 캐릭터를 획득했습니다. 모든 짝을 찾아 게임이 끝났습니다. ${winnersMessage(game)}`
      : `${player.name}님이 ${REGIONS[first.regionId]} 캐릭터를 획득했습니다. 다음 차례 버튼을 눌러 주세요.`;
  } else {
    first.revealed = false;
    second.revealed = false;
    game.phase = 'turnEnd';
    game.lastMessage = '짝이 맞지 않아 두 카드를 다시 뒤집었습니다. 다음 차례 버튼을 눌러 주세요.';
  }
  game.selectedIds = [];
  return true;
}

export function next(game, turn = (game.turn + 1) % game.players.length) {
  if (game.phase !== 'turnEnd' || !game.players[turn]) return false;
  game.turn = turn;
  game.phase = 'flip';
  game.selectedIds = [];
  game.lastMessage = `${game.players[turn].name}님의 차례입니다. 카드 두 장을 차례로 공개하세요.`;
  return true;
}
