#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createGame, publicGame, reveal, resolve, next, winnersMessage } from './game.mjs';

export const BUILD = 'chungbuk-memory-v1';
const MAX_ROOMS = 128;
const MAX_CLIENTS = 256;
const MAX_PAYLOAD = 4096;
const MAX_BUFFERED = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 30;
const MAX_ACTION_IDS = 1024;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ROOM_RE = /^[A-Z]{6}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CARD_RE = /^c(?:[0-9]|1[0-9]|2[01])$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const validActionId = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[^A-Za-z0-9_-]/.test(value);
const validName = value => typeof value === 'string' && value.trim() === value && [...value].length >= 1 && [...value].length <= 24 && !/[\u0000-\u001f\u007f-\u009f<>&]/u.test(value);
const connected = seat => Boolean(seat?.socket && seat.socket.readyState === WebSocket.OPEN);

function validateOrigins(values) {
  return new Set(values.map(origin => {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('Invalid ALLOWED_ORIGINS'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Invalid ALLOWED_ORIGINS');
    return origin;
  }));
}

// Options are injectable for fast isolated tests; production uses the exact defaults below.
export function createGameServer(options = {}) {
  const allowedOrigins = validateOrigins(options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
  const resolutionMs = options.resolutionMs ?? 1400;
  const graceMs = options.graceMs ?? 60_000;
  const roomIdleMs = options.roomIdleMs ?? 600_000;
  const housekeepingMs = options.housekeepingMs ?? 1000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const helloMs = options.helloMs ?? 10_000;
  const rooms = new Map();
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ ok: true, build: BUILD }));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Not found');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(message);
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED) { ws.terminate(); return; }
    ws.send(data, error => { if (error) ws.terminate(); });
  }
  function error(ws, code, message, room, actionId) {
    send(ws, { type: 'error', code, message, ...(room ? { revision: room.revision } : {}),
      ...(validActionId(actionId) ? { actionId } : {}) });
  }
  function roomStatus(room) {
    return !room.game ? 'waiting' : room.game.phase === 'finished' ? 'finished' : 'playing';
  }
  function view(room, type = 'snapshot') {
    return {
      type, build: BUILD, room: room.code, revision: room.revision, status: roomStatus(room),
      members: room.seats.filter(Boolean).map(seat => ({ id: seat.id, name: seat.name, connected: connected(seat) })),
      game: publicGame(room.game),
    };
  }
  function welcome(room, seat) {
    const { type: _type, ...state } = view(room);
    send(seat.socket, { type: 'welcome', build: BUILD, room: room.code, seat: seat.id, token: seat.token,
      revision: state.revision, status: state.status, members: state.members, game: state.game });
  }
  function broadcast(room) {
    const state = view(room);
    for (const seat of room.seats) if (connected(seat)) send(seat.socket, state);
  }
  function changed(room) {
    room.revision++;
    room.lastActivity = Date.now();
    broadcast(room);
  }
  function connectedCount(room) { return room.seats.filter(connected).length; }
  function currentSeat(room) {
    const player = room.game?.players[room.game.turn];
    return player ? room.seats[player.id] : null;
  }
  function nextConnectedIndex(room, from) {
    const game = room.game;
    for (let offset = 1; offset <= game.players.length; offset++) {
      const index = (from + offset) % game.players.length;
      if (connected(room.seats[game.players[index].id])) return index;
    }
    return -1;
  }
  // A disconnected turn cannot block the match. A resolving pair still completes for its owner.
  function skipDisconnectedTurn(room) {
    const game = room.game;
    if (!game || game.phase === 'finished' || game.phase === 'resolving' || connected(currentSeat(room))) return;
    if (game.phase === 'flip') {
      for (const id of game.selectedIds) {
        const card = game.cards.find(candidate => candidate.id === id);
        if (card && !game.claimed.includes(card.regionId)) card.revealed = false;
      }
      game.selectedIds = [];
      game.phase = 'turnEnd';
    }
    const target = nextConnectedIndex(room, game.turn);
    if (target >= 0) {
      next(game, target);
      game.lastMessage = `연결이 끊긴 참가자의 차례를 건너뛰었습니다. ${game.players[target].name}님의 차례입니다.`;
    } else {
      game.lastMessage = '참가자의 재접속을 기다리고 있습니다.';
    }
  }
  function cancelTimer(room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
  }
  function scheduleResolution(room) {
    cancelTimer(room);
    const expectedGame = room.game;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.game !== expectedGame || !resolve(room.game)) return;
      skipDisconnectedTurn(room);
      changed(room);
    }, resolutionMs);
    room.timer.unref();
  }
  function begin(room) {
    cancelTimer(room);
    const entries = room.seats.filter(Boolean).map(({ id, name }) => ({ id, name }));
    room.game = createGame(entries);
    // Start with a connected player even if a reserved seat is temporarily offline.
    const index = room.game.players.findIndex(player => connected(room.seats[player.id]));
    if (index >= 0) room.game.turn = index;
  }
  function newCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    throw new Error('Unable to allocate room code');
  }
  function makeRoom() {
    const room = { code: newCode(), seats: Array(6).fill(null), game: null, revision: 0, timer: null, lastActivity: Date.now() };
    rooms.set(room.code, room);
    return room;
  }
  function addSeat(room, ws, name) {
    const id = room.seats.findIndex(seat => !seat);
    if (id < 0) return null;
    const seat = { id, name, token: randomBytes(32).toString('base64url'), socket: ws, disconnectedAt: 0, actions: new Map() };
    room.seats[id] = seat;
    ws.room = room;
    ws.seat = seat;
    if (room.game) room.game.players.push({ id, name, score: 0, collected: [] });
    return seat;
  }
  function expireSeats(room, now = Date.now()) {
    let didChange = false;
    for (let id = 0; id < room.seats.length; id++) {
      const seat = room.seats[id];
      if (!seat || connected(seat) || !seat.disconnectedAt || now - seat.disconnectedAt < graceMs) continue;
      // Do not remove the owner while the 1.4-second pair timer is settling.
      if (room.game?.phase === 'resolving' && room.game.players[room.game.turn]?.id === id) continue;
      room.seats[id] = null;
      if (room.game) {
        const index = room.game.players.findIndex(player => player.id === id);
        if (index !== -1) {
          room.game.players.splice(index, 1);
          if (index < room.game.turn) room.game.turn--;
          else if (index === room.game.turn && room.game.players.length) room.game.turn %= room.game.players.length;
          if (!room.game.players.length) room.game.turn = 0;
          if (room.game.phase === 'finished' && room.game.players.length) room.game.lastMessage = `게임이 끝났습니다. ${winnersMessage(room.game)}`;
        }
      }
      didChange = true;
    }
    // Keep host-only restart available without giving it to a nonzero seat. A promotion changes the
    // promoted player's numeric seat and is announced with a fresh private welcome and snapshot.
    let promoted = null;
    if (!room.seats[0]) {
      const id = room.seats.findIndex((seat, index) => index > 0 && connected(seat));
      if (id > 0) {
        promoted = room.seats[id];
        room.seats[id] = null;
        room.seats[0] = promoted;
        promoted.id = 0;
        const player = room.game?.players.find(candidate => candidate.id === id);
        if (player) player.id = 0;
        didChange = true;
      }
    }
    if (didChange) {
      skipDisconnectedTurn(room);
      room.revision++;
      room.lastActivity = now;
      if (promoted) welcome(room, promoted);
      broadcast(room);
    }
  }
  function handleHello(ws, message) {
    if (!onlyKeys(message, ['type', 'build', 'mode', 'room', 'name', 'token']) || !['create', 'join', 'resume'].includes(message.mode)) {
      error(ws, 'INVALID_HELLO', '접속 요청 형식이 올바르지 않습니다.'); ws.close(1008); return;
    }
    if (message.mode !== 'resume' && (!validName(message.name) || message.token !== undefined)) {
      error(ws, 'INVALID_NAME', '이름은 1~24자이며 제어 문자와 <, >, &를 사용할 수 없습니다.'); ws.close(1008); return;
    }
    let room, seat;
    if (message.mode === 'create') {
      if (message.room !== undefined) { error(ws, 'INVALID_HELLO', '새 방을 만들 때 방 코드를 넣을 수 없습니다.'); ws.close(1008); return; }
      if (rooms.size >= MAX_ROOMS) { error(ws, 'SERVER_FULL', '서버가 가득 찼습니다. 잠시 후 다시 시도해 주세요.'); ws.close(1013); return; }
      room = makeRoom();
      seat = addSeat(room, ws, message.name);
    } else {
      if (typeof message.room !== 'string' || !ROOM_RE.test(message.room)) {
        error(ws, 'INVALID_ROOM', '방 코드는 대문자 6글자입니다.'); ws.close(1008); return;
      }
      room = rooms.get(message.room);
      if (!room) {
        error(ws, message.mode === 'resume' ? 'RESUME_FAILED' : 'ROOM_NOT_FOUND', '방이 없거나 만료되었습니다. 새 방을 만들거나 초대 코드를 확인해 주세요.'); ws.close(1008); return;
      }
      expireSeats(room);
      if (message.mode === 'resume') {
        if (message.name !== undefined || typeof message.token !== 'string' || !TOKEN_RE.test(message.token)) {
          error(ws, 'RESUME_FAILED', '재접속 정보가 올바르지 않습니다.'); ws.close(1008); return;
        }
        seat = room.seats.find(candidate => candidate?.token === message.token);
        if (!seat || (seat.disconnectedAt && Date.now() - seat.disconnectedAt >= graceMs)) {
          error(ws, 'RESUME_FAILED', '재접속 시간이 지났거나 자리 정보가 없습니다. 다시 참가해 주세요.'); ws.close(1008); return;
        }
        const old = seat.socket;
        // Install the new authority BEFORE telling the former socket it has been replaced.
        seat.socket = ws;
        seat.disconnectedAt = 0;
        ws.room = room;
        ws.seat = seat;
        if (old && old !== ws) old.close(4001, 'seat replaced');
      } else {
        seat = addSeat(room, ws, message.name);
        if (!seat) { error(ws, 'ROOM_FULL', '방이 가득 찼습니다. 최대 6명까지 참가할 수 있습니다.', room); ws.close(1008); return; }
      }
    }
    clearTimeout(ws.helloTimer);
    ws.helloTimer = null;
    if (!room.game && connectedCount(room) >= 2) begin(room);
    skipDisconnectedTurn(room);
    room.revision++;
    room.lastActivity = Date.now();
    welcome(room, seat);
    broadcast(room);
  }
  function handleAction(ws, msg) {
    const room = ws.room, seat = ws.seat;
    const actionId = validActionId(msg.actionId) ? msg.actionId : undefined;
    if (!room || !seat || room.seats[seat.id] !== seat || seat.socket !== ws) {
      error(ws, 'SEAT_REVOKED', '이 접속의 자리 권한이 사라졌습니다. 다시 접속해 주세요.', undefined, actionId); ws.close(1008); return;
    }
    if (!onlyKeys(msg, ['type', 'build', 'actionId', 'revision', 'action', 'cardId']) ||
        !actionId ||
        !Number.isSafeInteger(msg.revision) || msg.revision < 0 ||
        !['reveal', 'next', 'restart'].includes(msg.action) ||
        (msg.action === 'reveal' ? typeof msg.cardId !== 'string' || !CARD_RE.test(msg.cardId) : msg.cardId !== undefined)) {
      error(ws, 'INVALID_ACTION', '행동 요청 형식이 올바르지 않습니다.', room, actionId); return;
    }
    const fingerprint = JSON.stringify([msg.revision, msg.action, msg.cardId ?? null]);
    const previous = seat.actions.get(actionId);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        send(ws, view(room));
        error(ws, 'ACTION_ID_CONFLICT', '이미 사용한 행동 ID입니다. 새 ID를 사용해 주세요.', room, actionId);
      } else {
        broadcast(room);
        send(ws, { type: 'ack', actionId, revision: room.revision });
      }
      return;
    }
    if (msg.revision !== room.revision) {
      send(ws, view(room));
      error(ws, 'STALE_REVISION', '게임 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.', room, actionId);
      return;
    }
    if (seat.actions.size >= MAX_ACTION_IDS) { error(ws, 'ACTION_LIMIT', '행동 ID 한도에 도달했습니다. 새 방을 만들어 주세요.', room, actionId); return; }
    if (msg.action === 'restart') {
      if (seat.id !== 0) { error(ws, 'HOST_ONLY', '방장만 게임을 다시 시작할 수 있습니다.', room, actionId); return; }
      if (connectedCount(room) < 2) { error(ws, 'NEED_PLAYERS', '연결된 참가자가 2명 이상이어야 합니다.', room, actionId); return; }
      begin(room);
    } else {
      if (!room.game || room.game.phase === 'finished') { error(ws, 'INVALID_PHASE', '현재 게임을 진행할 수 없습니다.', room, actionId); return; }
      if (connectedCount(room) < 2) { error(ws, 'NEED_PLAYERS', '연결된 참가자가 2명 이상이어야 합니다.', room, actionId); return; }
      if (currentSeat(room) !== seat) { error(ws, 'NOT_YOUR_TURN', '현재 참가자만 행동할 수 있습니다.', room, actionId); return; }
      if (msg.action === 'reveal') {
        if (!reveal(room.game, msg.cardId)) { error(ws, 'INVALID_REVEAL', '지금은 이 카드를 공개할 수 없습니다.', room, actionId); return; }
        if (room.game.phase === 'resolving') scheduleResolution(room);
      } else {
        if (room.game.phase !== 'turnEnd') { error(ws, 'INVALID_PHASE', '두 카드의 판정이 끝난 후 다음 차례로 넘길 수 있습니다.', room, actionId); return; }
        const target = nextConnectedIndex(room, room.game.turn);
        if (target < 0 || !next(room.game, target)) { error(ws, 'NEED_PLAYERS', '다음 참가자를 찾을 수 없습니다.', room, actionId); return; }
      }
    }
    seat.actions.set(actionId, fingerprint);
    changed(room);
    send(ws, { type: 'ack', actionId, revision: room.revision });
  }
  http.on('upgrade', (req, socket, head) => {
    // Query strings are forbidden: credentials and room codes belong only in the first WS message.
    if (req.url !== '/ws' || !allowedOrigins.has(req.headers.origin) || wss.clients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.helloTimer = setTimeout(() => { error(ws, 'HELLO_TIMEOUT', '접속 시간이 초과되었습니다. 다시 접속해 주세요.'); ws.close(1008); }, helloMs);
    ws.helloTimer.unref();
    let windowStart = Date.now(), count = 0;
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; count = 0; }
      if (++count > MAX_MESSAGES_PER_SECOND) {
        // Only inspect a bounded text payload, and never echo untrusted IDs before authentication.
        let actionId;
        if (ws.room && ws.seat && !isBinary) {
          try { const msg = JSON.parse(data.toString()); if (isObject(msg) && msg.type === 'action') actionId = msg.actionId; } catch { /* no valid action ID */ }
        }
        error(ws, 'RATE_LIMIT', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', ws.room, actionId); ws.close(1008); return;
      }
      if (isBinary) { error(ws, 'INVALID_MESSAGE', '텍스트 JSON 메시지가 필요합니다.', ws.room); return; }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { error(ws, 'INVALID_MESSAGE', '메시지 형식이 올바르지 않습니다.', ws.room); return; }
      if (!isObject(msg) || typeof msg.type !== 'string') { error(ws, 'INVALID_MESSAGE', '메시지 형식이 올바르지 않습니다.', ws.room); return; }
      if (msg.build !== BUILD) { error(ws, 'BUILD_MISMATCH', '게임 버전이 다릅니다. 페이지를 새로 고침해 주세요.', ws.room, ws.room && ws.seat && msg.type === 'action' ? msg.actionId : undefined); ws.close(1008); return; }
      if (!ws.room) {
        if (msg.type !== 'hello') { error(ws, 'HELLO_REQUIRED', '먼저 방에 접속해 주세요.'); ws.close(1008); return; }
        handleHello(ws, msg);
      } else if (msg.type === 'action') handleAction(ws, msg);
      else error(ws, 'INVALID_MESSAGE', '알 수 없는 메시지입니다.', ws.room);
    });
    ws.on('close', () => {
      clearTimeout(ws.helloTimer);
      const room = ws.room, seat = ws.seat;
      if (!room || !seat || room.seats[seat.id] !== seat || seat.socket !== ws) return;
      seat.socket = null;
      seat.disconnectedAt = Date.now();
      skipDisconnectedTurn(room);
      changed(room);
    });
    ws.on('error', () => {}); // close handles cleanup; never log untrusted payloads or credentials
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  const housekeeping = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      expireSeats(room, now);
      if (!connectedCount(room) && (!room.seats.some(Boolean) || now - room.lastActivity >= roomIdleMs)) {
        cancelTimer(room);
        rooms.delete(code);
      }
    }
  }, housekeepingMs);
  housekeeping.unref();
  return {
    http,
    listen(port = 8787, host = '127.0.0.1') { return new Promise((resolveListen, reject) => { http.once('error', reject); http.listen(port, host, () => { http.off('error', reject); resolveListen(http.address()); }); }); },
    close() { return new Promise(resolveClose => {
      clearInterval(heartbeat); clearInterval(housekeeping);
      for (const room of rooms.values()) cancelTimer(room);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.close(() => resolveClose());
    }); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const app = createGameServer();
  const address = await app.listen(port, host);
  console.log(JSON.stringify({ build: BUILD, status: 'listening', host, port: address.port }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
