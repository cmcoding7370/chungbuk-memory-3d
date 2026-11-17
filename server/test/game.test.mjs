import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, publicGame, reveal, resolve, next } from '../game.mjs';

const players = [{ id: 0, name: '가' }, { id: 1, name: '나' }, { id: 2, name: '다' }];
// Keeping the initial ordering is only for these local unit tests, never the server's RNG.
const ordered = () => createGame(players, n => n - 1);

test('shuffle assigns opaque slot IDs after mixing and masks every hidden field', () => {
  const a = createGame(players, n => n - 1);
  const b = createGame(players, () => 0);
  assert.notDeepEqual(a.cards.map(c => [c.regionId, c.kind]), b.cards.map(c => [c.regionId, c.kind]));
  assert.deepEqual(a.cards.map(c => c.id), Array.from({ length: 22 }, (_, i) => `c${i}`));
  assert.deepEqual(publicGame(a), publicGame(b));
  assert.equal(new Set(a.cards.map(c => `${c.regionId}:${c.kind}`)).size, 22);
  for (const card of publicGame(a).cards) assert.deepEqual({ ...card, id: '' }, { id: '', regionId: -1, kind: 'place', revealed: false });
  assert.throws(() => createGame(players, () => -1));
  assert.throws(() => createGame(players.slice(0, 1)));
});

test('mismatch hides cards; match claims once; next is explicit', () => {
  const game = ordered();
  assert.equal(reveal(game, 'c0'), true);
  assert.equal(reveal(game, 'c0'), false);
  assert.equal(reveal(game, 'c2'), true);
  assert.equal(game.phase, 'resolving');
  assert.equal(next(game), false);
  assert.equal(resolve(game), true);
  assert.equal(game.phase, 'turnEnd');
  assert.equal(game.cards[0].revealed, false);
  assert.equal(game.cards[2].revealed, false);
  assert.equal(game.players[0].score, 0);
  assert.equal(next(game), true);
  assert.equal(game.turn, 1);
  reveal(game, 'c0'); reveal(game, 'c1'); resolve(game);
  assert.deepEqual(game.claimed, [0]);
  assert.deepEqual(game.players[1].collected, [0]);
  assert.equal(game.players[1].score, 1);
  assert.equal(game.cards[0].revealed, true);
  assert.equal(game.cards[1].revealed, true);
  next(game);
  assert.equal(reveal(game, 'c0'), false);
});

test('eleven characters finish and all equal top scorers are winners', () => {
  const game = ordered();
  // 4, 4, 3 produces the same joint-winner semantics as memoryRules.ts.
  for (let region = 0; region < 11; region++) {
    reveal(game, `c${2 * region}`); reveal(game, `c${2 * region + 1}`); resolve(game);
    if (region < 10) assert.equal(next(game), true);
  }
  assert.equal(game.phase, 'finished');
  assert.deepEqual(game.players.map(p => p.score), [4, 4, 3]);
  assert.equal(game.claimed.length, 11);
  const top = Math.max(...game.players.map(p => p.score));
  assert.deepEqual(game.players.filter(p => p.score === top).map(p => p.id), [0, 1]);
  assert.match(game.lastMessage, /공동 우승: 가, 나/);
  assert.equal(reveal(game, 'c1'), false);
  assert.equal(next(game), false);
});
