import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'

let server
let browser
let origin

beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-memory-ui-test', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({
    ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
    args: ['--no-sandbox'],
  })
}, 30000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function openUI(query = '', mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 360, height: 740 } : { width: 1280, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  await page.route('**/memory-ui-fixture*', route => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test-root"></div></body></html>',
  }))
  await page.goto(`${origin}/memory-ui-fixture${query}`)
  await page.evaluate(async moduleUrl => {
    // Evaluate this import in Chromium, not in Vitest's server-side module loader.
    const { MemoryUI } = await new Function('url', 'return import(url)')(moduleUrl)
    window.events = []
    window.ui = new MemoryUI(document.querySelector('#test-root'), {
      onStart: names => window.events.push(['start', names]),
      onNextTurn: () => window.events.push(['next']),
      onRestart: () => window.events.push(['restart']),
      onZoom: action => window.events.push(['zoom', action]),
      onOnlineCreate: name => window.events.push(['create', name]),
      onOnlineJoin: (room, name) => window.events.push(['join', room, name]),
      onOnlineLeave: () => window.events.push(['leave']),
      onCopyInvite: () => window.events.push(['copy']),
    })
  }, '/src/ui/memoryUI.ts')
  return { context, page }
}

const members = [
  { id: 0, name: '가람', connected: true },
  { id: 1, name: '누리', connected: true },
]
const host = {
  active: true, status: 'finished', message: '', room: 'ABCDEF', seat: 0,
  canAct: false, isHost: true, canRestart: true, members,
}
const finished = {
  players: [
    { id: 0, name: '가람', score: 6, collected: [] },
    { id: 1, name: '누리', score: 5, collected: [] },
  ],
  turn: 0, phase: 'finished', cards: [], selectedIds: [], claimed: Array.from({ length: 11 }, (_, i) => i), lastMessage: '',
}

async function render(page, state = finished, view = host) {
  await page.evaluate(({ state, view }) => {
    window.ui.setOnline(view)
    window.ui.hideSetup()
    window.ui.render(state)
  }, { state, view })
}

async function setView(page, view) {
  await page.evaluate(view => window.ui.setOnline(view), view)
}

const result = page => page.locator('[data-modal="result"]')
const winner = page => page.locator('[data-field="winners"]')
const help = page => page.locator('[data-field="restart-help"]')
const controls = page => page.locator('[data-action="restart"]')

async function visible(locator) { return locator.isVisible() }
async function text(locator) { return locator.textContent() }

describe('memory UI online results', () => {
  it('refreshes every finished winner snapshot without reopening a dismissed result', async () => {
    const { context, page } = await openUI()
    try {
      await render(page)
      expect(await visible(result(page))).toBe(true)
      expect(await text(winner(page))).toBe('가람')
      const tied = { ...finished, players: finished.players.map(player => ({ ...player, score: 5 })) }
      await page.evaluate(() => document.querySelector('[data-action="rules"]').click())
      await render(page, tied)
      expect(await visible(page.locator('[data-modal="rules"]'))).toBe(true)
      expect(await text(winner(page))).toBe('가람 · 누리')
      expect(await text(page.locator('[data-field="winner-label"]'))).toContain('공동 우승')
      await page.locator('[data-modal="rules"] [data-action="close-modal"]').first().click()
      expect(await visible(result(page))).toBe(true)
      await page.keyboard.press('Escape')
      expect(await visible(result(page))).toBe(false)
      const corrected = { ...finished, players: [{ ...finished.players[1], name: '새 이름', score: 7 }] }
      await render(page, corrected)
      expect(await visible(result(page))).toBe(false)
      expect(await text(winner(page))).toBe('새 이름')
      await render(page, { ...finished, phase: 'flip', claimed: [] }, { ...host, status: 'playing' })
      await render(page, finished)
      expect(await visible(result(page))).toBe(true)
    } finally { await context.close() }
  })

  it('separates host identity from restart eligibility and reports the actual reason', async () => {
    const { context, page } = await openUI()
    try {
      await render(page)
      expect(await controls(page).count()).toBe(2)
      expect(await controls(page).evaluateAll(buttons => buttons.every(button => !button.disabled))).toBe(true)
      const oneConnected = [{ ...members[0] }, { ...members[1], connected: false }]
      await setView(page, { ...host, canRestart: false, members: oneConnected })
      expect(await controls(page).evaluateAll(buttons => buttons.every(button => button.disabled))).toBe(true)
      expect(await text(help(page))).toContain('두 명 이상')
      expect(await text(help(page))).not.toContain('방장만')
      expect(await page.locator('[data-field="online-permission"]').textContent()).toContain('두 명 이상')
      await setView(page, { ...host, status: 'waiting', canRestart: false, members: [members[0]] })
      expect(await text(help(page))).toContain('두 명 이상')
      expect(await text(help(page))).not.toContain('방장만')
      await setView(page, { ...host, canRestart: false, seat: 1, isHost: false })
      expect(await text(help(page))).toContain('방장만')
      await setView(page, { ...host, canRestart: false, message: '요청을 보냈습니다. 서버 확인을 기다리고 있습니다.' })
      expect(await text(help(page))).toContain('기다리고')
      expect(await text(help(page))).not.toContain('방장만')
      await setView(page, { ...host, status: 'reconnecting', canRestart: false, message: '재접속 중입니다.' })
      expect(await text(help(page))).toContain('기다려')
      expect(await text(help(page))).not.toContain('방장만')
      expect(await text(page.locator('[data-field="result-online-message"]'))).toContain('재접속 중')
    } finally { await context.close() }
  })

  it('keeps the result open through restart, pending and rejection until a non-finished snapshot', async () => {
    const { context, page } = await openUI()
    try {
      await render(page)
      await result(page).locator('[data-action="restart"]').click()
      expect(await page.evaluate(() => window.events)).toEqual([['restart']])
      expect(await visible(result(page))).toBe(true)
      await setView(page, { ...host, canRestart: false, message: '요청을 보냈습니다. 서버 확인을 기다리고 있습니다.' })
      expect(await result(page).locator('[data-action="restart"]').isDisabled()).toBe(true)
      expect(await result(page).locator('[data-action="close-modal"]').first().evaluate(element => document.activeElement === element)).toBe(true)
      expect(await visible(result(page))).toBe(true)
      await setView(page, { ...host, message: '서버가 요청을 거절했습니다: 게임 상태가 바뀌었습니다.' })
      expect(await text(page.locator('[data-field="result-online-message"]'))).toContain('서버가 요청을 거절')
      expect(await result(page).locator('[data-action="restart"]').isDisabled()).toBe(false)
      await render(page, finished, { ...host, message: '서버가 요청을 거절했습니다.' })
      expect(await visible(result(page))).toBe(true)
      await render(page, { ...finished, phase: 'flip', claimed: [] }, { ...host, status: 'playing' })
      expect(await visible(result(page))).toBe(false)
    } finally { await context.close() }
  })

  it('retains local restart behavior', async () => {
    const { context, page } = await openUI()
    try {
      await page.evaluate(state => { window.ui.hideSetup(); window.ui.render(state) }, finished)
      await result(page).locator('[data-action="restart"]').click()
      expect(await page.evaluate(() => window.events)).toEqual([['restart']])
      expect(await visible(page.locator('[data-modal="setup"]'))).toBe(true)
      expect(await visible(result(page))).toBe(false)
    } finally { await context.close() }
  })
})

describe('memory UI room code entry', () => {
  it('validates uppercase letters only while accepting lowercase typing with the keyboard', async () => {
    const { context, page } = await openUI('', true)
    try {
      await page.locator('[data-action="mode-online"]').click()
      expect(await page.locator('[data-field="room-input"]').getAttribute('placeholder')).toBe('ABCDEF')
      expect(await text(page.locator('#memory-room-help'))).toContain('영문 대문자 6자리')
      await page.locator('[data-field="online-name"]').fill('여행자')
      const input = page.locator('[data-field="room-input"]')
      await input.pressSequentially('abc123')
      await input.press('Enter')
      expect(await text(page.locator('[data-field="online-form-error"]'))).toContain('영문 대문자 6자리')
      expect(await page.evaluate(() => window.events)).toEqual([])
      await input.fill('')
      await input.pressSequentially('abcdef')
      await input.press('Enter')
      expect(await page.evaluate(() => window.events)).toEqual([['join', 'ABCDEF', '여행자']])
      expect(await input.isDisabled()).toBe(true)
      await setView(page, { ...host, status: 'reconnecting', canRestart: false })
      expect(await input.inputValue()).toBe('ABCDEF')
    } finally { await context.close() }
  })

  it('prefills an invite without truncating a long invalid room into a different room', async () => {
    const first = await openUI('?room=abcdef')
    try {
      expect(await first.page.locator('[data-field="room-input"]').inputValue()).toBe('ABCDEF')
      expect(await first.page.locator('[data-action="mode-online"]').getAttribute('aria-pressed')).toBe('true')
    } finally { await first.context.close() }
    const second = await openUI('?room=ABCDEFG')
    try {
      const input = second.page.locator('[data-field="room-input"]')
      expect(await input.inputValue()).toBe('ABCDEFG')
      await second.page.locator('[data-field="online-name"]').fill('여행자')
      await second.page.locator('[data-action="online-join"]').click()
      expect(await text(second.page.locator('[data-field="online-form-error"]'))).toContain('영문 대문자 6자리')
      expect(await second.page.evaluate(() => window.events)).toEqual([])
    } finally { await second.context.close() }
  })
})
