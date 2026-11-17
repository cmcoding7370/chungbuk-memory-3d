// Interaction smoke test against the source development server. Run `pnpm build` separately.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const server = spawn('pnpm', ['dev'], { stdio: 'ignore', detached: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) } })
function stopServer() {
  if (!server.pid) return
  try { process.kill(-server.pid, 'SIGTERM') } catch { server.kill('SIGTERM') }
}
let browser
const timeout = setTimeout(() => { console.error('smoke: timed out'); stopServer(); process.exit(1) }, 120_000)

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('dev server did not start')
}
async function startPage(viewport, errors) {
  const context = await browser.newContext({ viewport, locale: 'ko-KR' })
  const page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`) })
  await page.goto(url)
  await page.waitForSelector('[data-modal="setup"]:not([hidden])', { timeout: 30_000 })
  await page.locator('[data-form="setup"] button[type="submit"]').click()
  await page.waitForSelector('[data-modal="setup"]', { state: 'hidden' })
  await page.waitForSelector('[data-field="board"] canvas')
  await page.waitForFunction(() => Boolean(window.__memory))
  await page.waitForTimeout(900)
  return { context, page }
}
async function state(page) { return page.evaluate(() => window.__memory.getState()) }
async function click3DCard(page, id) {
  const point = await page.evaluate(cardId => window.__memory.cardScreenPoint(cardId), id)
  if (!point) throw new Error(`3D card ${id} not found`)
  await page.mouse.click(point.x, point.y)
  const current = await state(page)
  if (!current.selectedIds.includes(id)) throw new Error(`3D card ${id} could not be clicked`)
}
async function waitForResolution(page) {
  await page.waitForFunction(() => window.__memory.getState().phase === 'turnEnd', null, { timeout: 8000 })
  await page.waitForTimeout(600)
}
function ensure(condition, message) { if (!condition) throw new Error(message) }

try {
  await waitForServer()
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-webgl'] })
    .catch(() => chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--ignore-gpu-blocklist', '--enable-webgl'] }))
  const errors = []
  const desktop = await startPage({ width: 1440, height: 900 }, errors)
  const page = desktop.page
  await page.screenshot({ path: `${out}/01-board.png`, fullPage: true })
  await page.locator('[data-action="zoom-in"]').click()
  await page.locator('[data-action="zoom-reset"]').click()
  await page.waitForTimeout(300)

  // A mismatched pair remains visible while resolving, then both 3D cards close again.
  await click3DCard(page, 'p0')
  ensure(await page.locator('[data-field="preview-cards"] img').count() === 1, 'the first revealed card was not enlarged')
  ensure(await page.locator('[data-action="next"]').isDisabled(), 'turn can advance after only one card')
  // Capture the actual resolving frame even if a busy browser is slow to answer the next test command.
  await page.evaluate(() => {
    window.__resolutionCapture = null
    const preview = document.querySelector('[data-field="preview-cards"]')
    const observer = new MutationObserver(() => {
      const game = window.__memory.getState()
      if (game.phase !== 'resolving') return
      window.__resolutionCapture = { game: structuredClone(game), previewCount: preview.querySelectorAll('img').length }
      observer.disconnect()
    })
    observer.observe(preview, { childList: true, subtree: true })
  })
  await click3DCard(page, 's1')
  const resolving = await page.evaluate(() => window.__resolutionCapture)
  ensure(resolving, 'the resolving frame was not captured')
  let current = resolving.game
  ensure(current.phase === 'resolving' && current.cards.find(c => c.id === 'p0').revealed && current.cards.find(c => c.id === 's1').revealed, 'two cards were not shown while resolving')
  ensure(resolving.previewCount === 2, `both revealed cards were not enlarged: ${resolving.previewCount}`)
  await waitForResolution(page)
  current = await state(page)
  ensure(!current.cards.find(c => c.id === 'p0').revealed && !current.cards.find(c => c.id === 's1').revealed, 'mismatched cards did not flip back')
  ensure(await page.locator('[data-field="preview-cards"] img').count() === 0, 'closed cards remained visible in the enlarged view')
  ensure(current.players.every(p => p.score === 0), 'a mismatch incorrectly awarded a character')
  await page.locator('[data-action="next"]').click()
  await page.waitForTimeout(650)

  // A matching pair remains open and the current player gets the exact character.
  await click3DCard(page, 'p0')
  await click3DCard(page, 's0')
  await waitForResolution(page)
  current = await state(page)
  ensure(current.claimed.includes(0) && current.players[1].score === 1 && current.players[1].collected.includes(0), 'matching pair did not award the correct player and character')
  ensure(current.cards.find(c => c.id === 'p0').revealed && current.cards.find(c => c.id === 's0').revealed, 'matching cards did not remain open')
  ensure(await page.locator('[data-field="preview-cards"] img').count() === 2, 'matched cards disappeared from the enlarged view')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-field="preview-cards"] img')].every(img => img.complete && img.naturalWidth >= 680), null, { timeout: 8000 })
  ensure(await page.locator('[data-action="next"]').evaluate(button => { const r = button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight }), 'next turn button is outside the desktop viewport')
  await page.waitForSelector('[data-field="players"] img', { timeout: 5000 })
  await page.screenshot({ path: `${out}/02-play.png`, fullPage: true })

  // Restarting during the delay must cancel the old result.
  await page.locator('[data-action="next"]').click()
  ensure(await page.locator('[data-field="preview-cards"] img').count() === 0, 'enlarged cards persisted into the next turn')
  await page.waitForTimeout(300)
  await click3DCard(page, 'p1')
  await click3DCard(page, 's1')
  await page.locator('[data-action="restart"]').first().click()
  await page.waitForTimeout(1700)
  current = await state(page)
  ensure(current.phase === 'flip' && current.players.every(p => p.score === 0) && current.claimed.length === 0, 'old resolution changed the restarted game')
  await desktop.context.close()

  const mobile = await startPage({ width: 390, height: 844 }, errors)
  await mobile.page.locator('[data-action="zoom-in"]').click()
  await mobile.page.locator('[data-action="zoom-reset"]').click()
  await mobile.page.screenshot({ path: `${out}/03-mobile.png`, fullPage: true })
  await mobile.context.close()
  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`)
  console.log('smoke: OK — real 3D clicks, mismatch flip-back, matching character, restart timer, mobile controls')
} catch (error) {
  console.error(`smoke: FAIL — ${error?.message ?? String(error)}`)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  await browser?.close().catch(() => {})
  stopServer()
}
