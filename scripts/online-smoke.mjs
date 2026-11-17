// Two independent browser contexts against a local authoritative server. Never used as a public deployment.
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const webPort = 5100 + Math.floor(Math.random() * 300)
const gamePort = 5500 + Math.floor(Math.random() * 300)
const origin = `http://127.0.0.1:${webPort}`
const latency = Math.max(0, Number(process.env.SMOKE_LATENCY_MS ?? 0) || 0)
const errors = []
const game = spawn('node', ['server.mjs'], {
  cwd: 'server', detached: true, stdio: 'ignore',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(gamePort), ALLOWED_ORIGINS: origin },
})
const web = spawn('pnpm', ['dev'], {
  detached: true, stdio: 'ignore',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(webPort), GAME_MULTIPLAYER_SIGNALING_URL: `ws://127.0.0.1:${gamePort}/ws` },
})
let browser
const timeout = setTimeout(() => { console.error('online smoke: timed out'); stop(game); stop(web); process.exit(1) }, 120_000)
function stop(processHandle) {
  if (!processHandle.pid) return
  try { process.kill(-processHandle.pid, 'SIGTERM') } catch { processHandle.kill('SIGTERM') }
}
function ensure(value, message) { if (!value) throw new Error(message) }
async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`server did not start: ${url}`)
}
async function gameState(page) { return page.evaluate(() => window.__memory.getState()) }
async function waitForCard(page, id, revealed) {
  await page.waitForFunction(({ id, revealed }) => window.__memory.getState().cards.some(card => card.id === id && card.revealed === revealed), { id, revealed }, { timeout: 15000 })
}
async function clickCard(page, id) {
  const point = await page.evaluate(cardId => window.__memory.cardScreenPoint(cardId), id)
  ensure(point, `3D card ${id} not found`)
  await page.mouse.click(point.x, point.y)
}
async function openPage(path = '/') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`) })
  if (latency) {
    await page.routeWebSocket('**/ws', socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => setTimeout(() => server.send(message), latency / 2))
      server.onMessage(message => setTimeout(() => socket.send(message), latency / 2))
    })
  }
  await page.goto(`${origin}${path}`)
  await page.waitForSelector('[data-modal="setup"]:not([hidden])', { timeout: 30000 })
  await page.waitForFunction(() => Boolean(window.__memory))
  return { context, page }
}

try {
  await Promise.all([waitFor(`${origin}/`), waitFor(`http://127.0.0.1:${gamePort}/health`)])
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-webgl'] })
    .catch(() => chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--ignore-gpu-blocklist', '--enable-webgl'] }))
  const one = await openPage()
  await one.page.locator('[data-action="mode-online"]').click()
  await one.page.locator('[data-field="online-name"]').fill('가람')
  await one.page.locator('[data-action="online-create"]').click()
  await one.page.waitForSelector('[data-modal="setup"]', { state: 'hidden', timeout: 20000 })
  const code = (await one.page.locator('[data-online-context="panel"] [data-online-field="room"]').innerText()).trim()
  ensure(/^[A-Z]{6}$/.test(code), `invalid room code: ${code}`)
  ensure((await gameState(one.page)).cards.length === 0, 'waiting room displayed a fake board')

  const two = await openPage(`/?room=${code}`)
  await two.page.locator('[data-field="online-name"]').fill('누리')
  await two.page.locator('[data-action="online-join"]').click()
  await two.page.waitForSelector('[data-modal="setup"]', { state: 'hidden', timeout: 20000 })
  for (const page of [one.page, two.page]) {
    await page.waitForFunction(() => window.__memory.getState().cards.length === 22 && window.__memory.getState().players.length === 2, null, { timeout: 15000 })
  }
  let first = await gameState(one.page)
  let second = await gameState(two.page)
  ensure(JSON.stringify(first.cards) === JSON.stringify(second.cards), 'players did not receive the same board')
  ensure(first.cards.every(card => !card.revealed && card.regionId === -1), 'a hidden identity leaked to a browser')
  const [id1, id2] = first.cards.map(card => card.id)
  await one.page.waitForTimeout(700)
  await clickCard(one.page, id1)
  await Promise.all([waitForCard(one.page, id1, true), waitForCard(two.page, id1, true)])
  first = await gameState(one.page)
  second = await gameState(two.page)
  ensure(first.cards.find(card => card.id === id1).regionId === second.cards.find(card => card.id === id1).regionId, 'revealed identities differ')
  await one.page.waitForTimeout(550)
  await clickCard(one.page, id2)
  await Promise.all([waitForCard(one.page, id2, true), waitForCard(two.page, id2, true)])
  const revealed = await gameState(one.page)
  const a = revealed.cards.find(card => card.id === id1)
  const b = revealed.cards.find(card => card.id === id2)
  const match = a.regionId === b.regionId && a.kind !== b.kind
  for (const page of [one.page, two.page]) {
    await page.waitForFunction(() => window.__memory.getState().phase === 'turnEnd', null, { timeout: 10000 })
  }
  first = await gameState(one.page)
  second = await gameState(two.page)
  ensure(JSON.stringify(first) === JSON.stringify(second), 'players disagree on the resolved turn')
  ensure(first.cards.find(card => card.id === id1).revealed === match, 'the match or mismatch was not resolved correctly')
  ensure(first.players[0].score === (match ? 1 : 0), 'server awarded the wrong score')
  ensure(await two.page.locator('[data-action="next"]').isDisabled(), 'the other player can advance this turn')
  await one.page.locator('[data-action="next"]').click()
  await two.page.waitForFunction(() => window.__memory.getState().turn === 1 && window.__memory.getState().phase === 'flip', null, { timeout: 10000 })
  const afterTurn = await gameState(two.page)
  const nextId = afterTurn.cards.find(card => !card.revealed).id
  await one.page.waitForTimeout(550)
  await clickCard(one.page, nextId)
  await one.page.waitForTimeout(400)
  ensure(!(await gameState(one.page)).selectedIds.includes(nextId), 'a player acted outside their turn')
  await clickCard(two.page, nextId)
  await Promise.all([waitForCard(one.page, nextId, true), waitForCard(two.page, nextId, true)])
  const savedUrl = new URL(one.page.url())
  ensure(savedUrl.searchParams.get('room') === code && !savedUrl.searchParams.has('token'), 'room recovery URL is missing or exposes a token')
  await one.page.reload()
  await one.page.waitForSelector('[data-modal="setup"]:not([hidden])', { timeout: 30000 })
  ensure(await one.page.locator('[data-field="room-input"]').inputValue() === code, 'refresh lost the public room code')
  await one.page.locator('[data-field="online-name"]').fill('가람')
  await one.page.locator('[data-action="online-join"]').click()
  await one.page.waitForSelector('[data-modal="setup"]', { state: 'hidden', timeout: 20000 })
  await waitForCard(one.page, nextId, true)
  ensure((await one.page.locator('[data-online-context="panel"] [data-online-field="members"]').innerText()).includes('가람 (나)'), 'the player did not resume their own seat')
  await one.context.close()
  await two.context.close()
  ensure(errors.length === 0, `browser errors:\n${errors.join('\n')}`)
  console.log(`online smoke: OK — two browsers, room invite, hidden identities, 3D clicks, scores, turn ownership, refresh/resume (${latency}ms simulated RTT)`)
} catch (error) {
  console.error(`online smoke: FAIL — ${error?.message ?? String(error)}`)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  await browser?.close().catch(() => {})
  stop(game)
  stop(web)
}
