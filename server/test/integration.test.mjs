import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { BUILD, createGameServer } from '../server.mjs';

const ORIGIN = 'http://client.example';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.state = null;
    this.seat = null;
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      if (msg.type === 'welcome') { this.seat = msg.seat; this.token = msg.token; this.room = msg.room; }
      if (msg.type === 'welcome' || msg.type === 'snapshot') this.state = msg;
    });
    ws.on('error', () => {});
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  mark() { return this.messages.length; }
  async wait(predicate, from = 0, timeout = 4000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = this.messages.slice(from).find(predicate);
      if (found) return found;
      await sleep(5);
    }
    throw new Error(`Timed out waiting for message; last=${JSON.stringify(this.messages.slice(-3))}`);
  }
  waitState(predicate, timeout = 4000) { return this.wait(m => ['snapshot', 'welcome'].includes(m.type) && predicate(m), 0, timeout); }
  close() { this.ws.terminate(); }
}

async function open(url, hello, origin = ORIGIN) {
  const ws = new WebSocket(url, { origin });
  const client = new Client(ws);
  await once(ws, 'open');
  if (hello) client.send({ type: 'hello', build: BUILD, ...hello });
  return client;
}
async function setup(options = {}) {
  const app = createGameServer({ allowedOrigins: [ORIGIN], resolutionMs: 50, graceMs: 250, housekeepingMs: 20, heartbeatMs: 500, ...options });
  const address = await app.listen(0);
  return { app, url: `ws://127.0.0.1:${address.port}/ws`, http: `http://127.0.0.1:${address.port}`, clients: [] };
}
async function player(ctx, mode, data) {
  const c = await open(ctx.url, { mode, ...data });
  ctx.clients.push(c);
  await c.wait(m => m.type === 'welcome');
  return c;
}
async function cleanup(ctx) {
  for (const client of ctx.clients) client.close();
  await ctx.app.close();
}
async function action(client, actionName, extra = {}) {
  const state = client.state;
  const mark = client.mark();
  client.send({ type: 'action', build: BUILD, actionId: `a${++sequence}`, revision: state.revision, action: actionName, ...extra });
  return client.wait(m => m.type === 'snapshot' && m.revision > state.revision, mark);
}
async function sync(clients, revision) { await Promise.all(clients.map(c => c.waitState(s => s.revision >= revision))); }
function turnOwner(clients, state) { return clients.find(c => c.seat === state.game.players[state.game.turn].id); }

// Full black-box match: identities are learned only by publicly revealing cards, never by peeking.
test('two clients, hidden identities, mismatches, matches, all 11 scores, and isolation', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '민수' });
  assert.match(a.room, /^[A-Z]{6}$/);
  assert.equal(a.state.status, 'waiting'); assert.equal(a.state.game, null);
  const b = await player(ctx, 'join', { room: a.room, name: '영희' });
  const other = await player(ctx, 'create', { name: '다른방' });
  assert.notEqual(other.room, a.room);
  await a.waitState(s => s.status === 'playing');
  let state = a.state;
  assert.equal(state.game.cards.length, 22);
  assert.deepEqual(Object.keys(state.game).sort(), ['cards', 'claimed', 'lastMessage', 'phase', 'players', 'selectedIds', 'turn'].sort());
  for (const card of state.game.cards) assert.deepEqual(card, { id: card.id, regionId: -1, kind: 'place', revealed: false });
  const known = new Map();
  const pairTurn = async (id1, id2) => {
    await sync([a, b], state.revision);
    const owner = turnOwner([a, b], state);
    state = await action(owner, 'reveal', { cardId: id1 });
    assert.equal(state.game.phase, 'flip');
    state = await action(owner, 'reveal', { cardId: id2 });
    assert.equal(state.game.phase, 'resolving');
    for (const id of [id1, id2]) {
      const card = state.game.cards.find(c => c.id === id);
      assert.equal(card.revealed, true);
      known.set(id, { regionId: card.regionId, kind: card.kind });
    }
    state = await owner.waitState(s => s.revision > state.revision && ['turnEnd', 'finished'].includes(s.game.phase));
    if (state.game.phase === 'turnEnd') {
      await sync([a, b], state.revision);
      state = await action(turnOwner([a, b], state), 'next');
    }
  };
  for (let i = 0; i < 22; i += 2) await pairTurn(`c${i}`, `c${i + 1}`);
  for (let region = 0; region < 11; region++) {
    if (state.game.phase === 'finished') break;
    if (state.game.claimed.includes(region)) continue;
    const ids = [...known.entries()].filter(([, card]) => card.regionId === region).map(([id]) => id);
    assert.equal(ids.length, 2);
    await pairTurn(ids[0], ids[1]);
  }
  assert.equal(state.status, 'finished');
  assert.equal(state.game.claimed.length, 11);
  assert.equal(state.game.players.reduce((sum, p) => sum + p.score, 0), 11);
  assert.equal(state.game.players.reduce((sum, p) => sum + p.collected.length, 0), 11);
  assert.ok(state.game.cards.every(card => card.revealed));
  assert.ok(other.messages.every(m => m.room === undefined || m.room === other.room));
  for (const c of [a, b, other]) for (const msg of c.messages) {
    if (msg.type === 'snapshot') {
      assert.equal(Object.hasOwn(msg, 'token'), false);
      assert.equal(JSON.stringify(msg).includes(a.token), false);
      assert.equal(JSON.stringify(msg).includes(b.token), false);
      for (const card of msg.game?.cards ?? []) if (!card.revealed) assert.deepEqual(card, { id: card.id, regionId: -1, kind: 'place', revealed: false });
    }
  }
  assert.notEqual(a.token, b.token);
  // A room with only one connected finalist must not be stuck forever: a new player may join
  // the finished board and the host can then start the next game.
  const late = await player(ctx, 'join', { room: a.room, name: '새 참가자' });
  assert.equal(late.state.status, 'finished');
  assert.equal(late.state.game.players.length, 3);
  assert.equal(late.state.game.players.find(p => p.name === '새 참가자').score, 0);
  await a.waitState(s => s.revision >= late.state.revision);
  state = await action(a, 'restart');
  assert.equal(state.status, 'playing');
  assert.equal(state.game.claimed.length, 0);
  assert.equal(state.game.players.length, 3);
});

test('real default delay holds a mismatch visibly for 1.4 seconds', async t => {
  const ctx = await setup({ resolutionMs: 1400, graceMs: 60_000 }); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '첫째' });
  const b = await player(ctx, 'join', { room: a.room, name: '둘째' });
  await a.waitState(s => s.status === 'playing');
  let state = a.state;
  let mismatchSeen = false;
  // If a random pair happens to match, try the next pair; ordinary tests finish after one turn.
  for (let i = 0; i < 22; i += 2) {
    await sync([a, b], state.revision);
    const owner = turnOwner([a, b], state);
    const ids = [`c${i}`, `c${i + 1}`];
    state = await action(owner, 'reveal', { cardId: ids[0] });
    const start = performance.now();
    state = await action(owner, 'reveal', { cardId: ids[1] });
    const shown = state.game.cards.filter(c => ids.includes(c.id));
    assert.ok(shown.every(c => c.revealed));
    const match = shown[0].regionId === shown[1].regionId && shown[0].kind !== shown[1].kind;
    state = await owner.waitState(s => s.revision > state.revision && ['turnEnd', 'finished'].includes(s.game.phase), 3000);
    assert.ok(performance.now() - start >= 1350);
    assert.ok(ids.every(id => state.game.cards.find(c => c.id === id).revealed === match));
    if (!match) { mismatchSeen = true; break; }
    if (state.game.phase === 'finished') break;
    state = await action(owner, 'next');
  }
  assert.equal(mismatchSeen, true);
});

test('validation, stale revision, idempotency, host-only restart, and timer cancellation', async t => {
  const ctx = await setup({ resolutionMs: 200, graceMs: 2000 }); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '방장' });
  const b = await player(ctx, 'join', { room: a.room, name: '참가자' });
  await a.waitState(s => s.status === 'playing'); await sync([a, b], a.state.revision);
  let mark = b.mark();
  b.send({ type: 'action', build: BUILD, actionId: 'forged', revision: b.state.revision, action: 'reveal', cardId: 'c0', seat: 0 });
  assert.equal((await b.wait(m => m.type === 'error' && m.code === 'INVALID_ACTION', mark)).actionId, 'forged');
  mark = b.mark();
  b.send({ type: 'action', build: BUILD, actionId: 'otherturn', revision: b.state.revision, action: 'reveal', cardId: 'c0' });
  assert.equal((await b.wait(m => m.type === 'error' && m.code === 'NOT_YOUR_TURN', mark)).actionId, 'otherturn');
  mark = b.mark();
  b.send({ type: 'action', build: BUILD, actionId: 'not-host', revision: b.state.revision, action: 'restart' });
  assert.equal((await b.wait(m => m.type === 'error' && m.code === 'HOST_ONLY', mark)).actionId, 'not-host');
  const rev = a.state.revision;
  const msg = { type: 'action', build: BUILD, actionId: 'unique-1', revision: rev, action: 'reveal', cardId: 'c0' };
  const otherMark = b.mark();
  mark = a.mark(); a.send(msg);
  let state = await a.wait(m => m.type === 'snapshot' && m.revision > rev, mark);
  const acceptedRev = state.revision;
  const ack = await a.wait(m => m.type === 'ack' && m.actionId === msg.actionId, mark);
  assert.deepEqual(ack, { type: 'ack', actionId: msg.actionId, revision: acceptedRev });
  assert.ok(a.messages.indexOf(state) < a.messages.indexOf(ack));
  await b.wait(m => m.type === 'snapshot' && m.revision === acceptedRev, otherMark);
  assert.equal(b.messages.slice(otherMark).some(m => m.type === 'ack'), false);
  mark = a.mark(); a.send(msg);
  const dup = await a.wait(m => m.type === 'snapshot', mark);
  assert.equal(dup.revision, acceptedRev); assert.deepEqual(dup.game.selectedIds, ['c0']);
  const dupAck = await a.wait(m => m.type === 'ack', mark);
  assert.deepEqual(dupAck, { type: 'ack', actionId: msg.actionId, revision: acceptedRev });
  assert.ok(a.messages.indexOf(dup) < a.messages.indexOf(dupAck));
  mark = a.mark(); a.send({ ...msg, cardId: 'c1' });
  assert.equal((await a.wait(m => m.type === 'error' && m.code === 'ACTION_ID_CONFLICT', mark)).actionId, msg.actionId);
  assert.equal(a.messages.slice(mark).some(m => m.type === 'ack'), false);
  mark = a.mark(); a.send({ ...msg, actionId: 'stale', cardId: 'c1' });
  const staleError = await a.wait(m => m.type === 'error' && m.code === 'STALE_REVISION', mark);
  assert.equal(staleError.actionId, 'stale');
  const latest = await a.wait(m => m.type === 'snapshot', mark);
  assert.equal(latest.revision, acceptedRev);
  assert.ok(a.messages.indexOf(latest) < a.messages.indexOf(staleError));
  state = await action(a, 'reveal', { cardId: 'c1' });
  assert.equal(state.game.phase, 'resolving');
  state = await action(a, 'restart');
  assert.equal(state.game.phase, 'flip');
  const resetRev = state.revision;
  await sleep(300);
  assert.equal(a.state.revision, resetRev);
  assert.deepEqual(a.state.game.claimed, []);
});

test('a concurrent join causes an old reveal to be rejected with its ID and a fresh snapshot', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '방장' });
  const b = await player(ctx, 'join', { room: a.room, name: '둘' });
  await a.waitState(s => s.status === 'playing'); await sync([a, b], a.state.revision);
  const oldRevision = a.state.revision;
  const mark = a.mark();
  const third = await player(ctx, 'join', { room: a.room, name: '셋' });
  a.send({ type: 'action', build: BUILD, actionId: 'racing-reveal', revision: oldRevision, action: 'reveal', cardId: 'c0' });
  const rejection = await a.wait(m => m.type === 'error' && m.code === 'STALE_REVISION', mark);
  assert.equal(rejection.actionId, 'racing-reveal');
  assert.equal(rejection.revision, third.state.revision);
  const updates = a.messages.slice(mark);
  assert.ok(updates.findIndex(m => m.type === 'snapshot' && m.revision === rejection.revision) < updates.indexOf(rejection));
  assert.equal(updates.some(m => m.type === 'ack' && m.actionId === 'racing-reveal'), false);
  assert.deepEqual(a.state.game.selectedIds, []);
  const state = await action(a, 'reveal', { cardId: 'c0' });
  assert.deepEqual(state.game.selectedIds, ['c0']);
});

test('idempotent replay after another join broadcasts the latest snapshot and ACKs only the sender', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '방장' });
  const b = await player(ctx, 'join', { room: a.room, name: '둘' });
  await a.waitState(s => s.status === 'playing'); await sync([a, b], a.state.revision);
  const request = { type: 'action', build: BUILD, actionId: 'replay-after-join', revision: a.state.revision, action: 'reveal', cardId: 'c0' };
  let mark = a.mark(); a.send(request);
  const firstAck = await a.wait(m => m.type === 'ack' && m.actionId === request.actionId, mark);
  const third = await player(ctx, 'join', { room: a.room, name: '셋' });
  await a.wait(m => m.type === 'snapshot' && m.revision === third.state.revision);
  await b.wait(m => m.type === 'snapshot' && m.revision === third.state.revision);
  await third.wait(m => m.type === 'snapshot' && m.revision === third.state.revision);
  assert.ok(third.state.revision > firstAck.revision);
  const bMark = b.mark(), thirdMark = third.mark();
  mark = a.mark(); a.send(request);
  const ack = await a.wait(m => m.type === 'ack' && m.actionId === request.actionId, mark);
  const replayed = a.messages.slice(mark);
  assert.deepEqual(replayed.map(m => m.type), ['snapshot', 'ack']);
  assert.equal(ack.revision, third.state.revision);
  assert.equal(replayed[0].revision, ack.revision);
  assert.deepEqual(replayed[0].game.selectedIds, ['c0']);
  await b.wait(m => m.type === 'snapshot' && m.revision === ack.revision, bMark);
  await third.wait(m => m.type === 'snapshot' && m.revision === ack.revision, thirdMark);
  assert.equal(b.messages.slice(bMark).some(m => m.type === 'ack'), false);
  assert.equal(third.messages.slice(thirdMark).some(m => m.type === 'ack'), false);
});

test('invalid action IDs are never reflected; other authenticated rejections retain safe IDs', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '방장' });
  const b = await player(ctx, 'join', { room: a.room, name: '둘' });
  await a.waitState(s => s.status === 'playing'); await sync([a, b], a.state.revision);
  for (const actionId of ['', 'bad\n', '한글', 'a'.repeat(81), null, 1, {}]) {
    const mark = a.mark();
    a.send({ type: 'action', build: BUILD, actionId, revision: a.state.revision, action: 'reveal', cardId: 'c0' });
    const result = await a.wait(m => m.type === 'error' && m.code === 'INVALID_ACTION', mark);
    assert.equal(Object.hasOwn(result, 'actionId'), false);
  }
  let mark = a.mark();
  a.send({ type: 'action', build: BUILD, actionId: 'phase-ok', revision: a.state.revision, action: 'next' });
  assert.equal((await a.wait(m => m.type === 'error' && m.code === 'INVALID_PHASE', mark)).actionId, 'phase-ok');
  mark = a.mark();
  a.send({ type: 'action', build: 'wrong', actionId: 'wrong-build', revision: a.state.revision, action: 'reveal', cardId: 'c0' });
  assert.equal((await a.wait(m => m.type === 'error' && m.code === 'BUILD_MISMATCH', mark)).actionId, 'wrong-build');
  const unauthenticated = await open(ctx.url); ctx.clients.push(unauthenticated);
  unauthenticated.send({ type: 'action', build: BUILD, actionId: 'before-hello', revision: 0, action: 'next' });
  const error = await unauthenticated.wait(m => m.type === 'error' && m.code === 'HELLO_REQUIRED');
  assert.equal(Object.hasOwn(error, 'actionId'), false);
});

test('seat replacement revokes old socket, disconnect skips turn, grace expiry promotes host and frees a seat', async t => {
  const ctx = await setup({ graceMs: 300, resolutionMs: 100 }); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '방장' });
  const b = await player(ctx, 'join', { room: a.room, name: '참가자' });
  await a.waitState(s => s.status === 'playing');
  const resumed = await player(ctx, 'resume', { room: a.room, token: a.token });
  assert.equal(resumed.seat, 0);
  await sleep(30);
  assert.notEqual(a.ws.readyState, WebSocket.OPEN);
  await sync([resumed, b], resumed.state.revision);
  let state = await action(resumed, 'reveal', { cardId: 'c0' });
  assert.equal(state.game.cards[0].revealed, true);
  resumed.close();
  state = await b.waitState(s => s.revision > state.revision && s.game.turn === 1);
  assert.equal(state.game.cards[0].revealed, false);
  assert.equal(state.game.selectedIds.length, 0);
  let mark = b.mark();
  b.send({ type: 'action', build: BUILD, actionId: 'one-left', revision: state.revision, action: 'reveal', cardId: 'c0' });
  await b.wait(m => m.type === 'error' && m.code === 'NEED_PLAYERS', mark);
  const promotion = await b.wait(m => m.type === 'welcome' && m.seat === 0, mark, 2000);
  assert.equal(promotion.game.players.find(p => p.name === '참가자').id, 0);
  const rejected = await open(ctx.url, { mode: 'resume', room: a.room, token: a.token }); ctx.clients.push(rejected);
  await rejected.wait(m => m.type === 'error' && m.code === 'RESUME_FAILED');
  const newcomer = await player(ctx, 'join', { room: a.room, name: '새 참가자' });
  assert.equal(newcomer.seat, 1);
  assert.equal(newcomer.state.game.players.length, 2);
  await b.waitState(s => s.revision >= newcomer.state.revision);
  state = await action(b, 'reveal', { cardId: 'c0' });
  assert.deepEqual(state.game.selectedIds, ['c0']);
});

test('late joins are players up to six and room codes never authenticate seats', async t => {
  const ctx = await setup({ graceMs: 2000 }); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '0' });
  const players = [a];
  for (let i = 1; i < 6; i++) players.push(await player(ctx, 'join', { room: a.room, name: `${i}` }));
  assert.deepEqual(players.map(p => p.seat), [0, 1, 2, 3, 4, 5]);
  assert.equal(players[5].state.game.players.length, 6);
  const full = await open(ctx.url, { mode: 'join', room: a.room, name: '일곱' }); ctx.clients.push(full);
  await full.wait(m => m.type === 'error' && m.code === 'ROOM_FULL');
  const fake = await open(ctx.url, { mode: 'resume', room: a.room, token: 'A'.repeat(43) }); ctx.clients.push(fake);
  await fake.wait(m => m.type === 'error' && m.code === 'RESUME_FAILED');
});

test('Origin, endpoint, build, JSON, size and health defenses', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  assert.equal((await fetch(`${ctx.http}/health`)).status, 200);
  assert.equal((await fetch(`${ctx.http}/ws`)).status, 404);
  for (const [url, origin] of [[ctx.url, 'https://evil.example'], [ctx.url, undefined], [`${ctx.url}?token=secret`, ORIGIN]]) {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on('error', () => {});
    const [, response] = await once(ws, 'unexpected-response');
    assert.equal(response.statusCode, 403);
    ws.terminate();
  }
  const wrong = await open(ctx.url); ctx.clients.push(wrong);
  wrong.send({ type: 'hello', build: 'wrong', mode: 'create', name: 'x' });
  await wrong.wait(m => m.type === 'error' && m.code === 'BUILD_MISMATCH');
  const malformed = await open(ctx.url); ctx.clients.push(malformed);
  malformed.ws.send('{');
  await malformed.wait(m => m.type === 'error' && m.code === 'INVALID_MESSAGE');
  malformed.ws.send('x'.repeat(5000));
  await once(malformed.ws, 'close');
});

test('a disconnected player retains the resolving award and the turn skips afterward', async t => {
  const ctx = await setup({ graceMs: 2000, resolutionMs: 130 }); t.after(() => cleanup(ctx));
  const a = await player(ctx, 'create', { name: '첫째' });
  const b = await player(ctx, 'join', { room: a.room, name: '둘째' });
  await a.waitState(s => s.status === 'playing');
  let state = await action(a, 'reveal', { cardId: 'c0' });
  state = await action(a, 'reveal', { cardId: 'c1' });
  const cards = state.game.cards.filter(c => ['c0', 'c1'].includes(c.id));
  const match = cards[0].regionId === cards[1].regionId && cards[0].kind !== cards[1].kind;
  a.close();
  state = await b.waitState(s => s.revision > state.revision && s.game.phase === 'flip' && s.game.players[s.game.turn].id === b.seat);
  assert.equal(state.game.players.find(p => p.name === '첫째').score, match ? 1 : 0);
  assert.equal(state.game.cards[0].revealed, match);
  assert.equal(state.game.cards[1].revealed, match);
  const resumed = await player(ctx, 'resume', { room: a.room, token: a.token });
  assert.equal(resumed.seat, 0);
  assert.equal(resumed.state.game.players[resumed.state.game.turn].id, b.seat);
});

test('cross-room resume token is rejected and message rate is bounded', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  const first = await player(ctx, 'create', { name: '첫 방' });
  const second = await player(ctx, 'create', { name: '둘째 방' });
  const impostor = await open(ctx.url, { mode: 'resume', room: second.room, token: first.token }); ctx.clients.push(impostor);
  await impostor.wait(m => m.type === 'error' && m.code === 'RESUME_FAILED');
  const spammer = await player(ctx, 'create', { name: '제한 확인' });
  const mark = spammer.mark();
  for (let i = 0; i < 31; i++) spammer.send({ type: 'unknown', build: BUILD });
  await spammer.wait(m => m.type === 'error' && m.code === 'RATE_LIMIT', mark);
});

test('an authenticated action rejected by the rate limit retains its safe ID', async t => {
  const ctx = await setup(); t.after(() => cleanup(ctx));
  const c = await player(ctx, 'create', { name: '제한 확인' });
  const mark = c.mark();
  // The hello was message 1. The next 29 reach the limit, and the action exceeds it.
  for (let i = 0; i < 29; i++) c.send({ type: 'unknown', build: BUILD });
  c.send({ type: 'action', build: BUILD, actionId: 'rate-limited', revision: c.state.revision, action: 'next' });
  const result = await c.wait(m => m.type === 'error' && m.code === 'RATE_LIMIT', mark);
  assert.equal(result.actionId, 'rate-limited');
});
