// End-to-end smoke test for the 3D memory game. Run after `pnpm build`.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
const timeout = setTimeout(() => { console.error('smoke: timed out'); server.kill(); process.exit(1) }, 120_000)

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('preview server did not start')
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
  await page.waitForTimeout(1200)
  return { context, page }
}

// Search for a real rendered card by sending pointer events across the board.
// A message change identifies a successful 3D hit.
async function revealOneCard(page) {
  const canvas = page.locator('[data-field="board"] canvas')
  const rect = await canvas.boundingBox()
  if (!rect) throw new Error('board canvas is not visible')
  const before = await page.locator('[data-field="message"]').textContent()
  for (let fy = 0.12; fy <= 0.88; fy += 0.085) {
    for (let fx = 0.08; fx <= 0.92; fx += 0.06) {
      const x = rect.x + rect.width * fx
      const y = rect.y + rect.height * fy
      await page.mouse.click(x, y)
      const message = await page.locator('[data-field="message"]').textContent()
      if (message !== before && message?.includes('공개되었습니다')) return { x, y }
    }
  }
  throw new Error('no clickable 3D card found in the board canvas')
}

try {
  await waitForServer()
  browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-webgl'] })
    .catch(() => chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--ignore-gpu-blocklist', '--enable-webgl'] }))
  const errors = []
  const desktop = await startPage({ width: 1440, height: 900 }, errors)
  await desktop.page.screenshot({ path: `${out}/01-board.png`, fullPage: true })
  await desktop.page.locator('[data-action="zoom-in"]').click()
  await desktop.page.locator('[data-action="zoom-reset"]').click()
  await desktop.page.waitForTimeout(300)
  const first = await revealOneCard(desktop.page)
  if (!(await desktop.page.locator('[data-action="next"]').isDisabled())) throw new Error('next turn was enabled before the second card')
  const second = await revealOneCard(desktop.page)
  if (await desktop.page.locator('[data-action="next"]').isDisabled()) throw new Error('next turn was not enabled after two cards')
  await desktop.page.waitForTimeout(700)
  await desktop.page.locator('[data-action="next"]').click()
  if (!(await desktop.page.locator('[data-field="turn-name"]').textContent())?.includes('플레이어 2')) throw new Error('turn did not advance')
  if (await desktop.page.locator('[data-player="0"]').isDisabled()) throw new Error('players cannot claim revealed pairs before the next reveal')
  await desktop.page.locator('[data-player="0"]').click()
  if (!(await desktop.page.locator('[data-player="1"]').isDisabled())) throw new Error('other players can replace an active claimant')
  await desktop.page.mouse.click(first.x, first.y)
  await desktop.page.mouse.click(second.x, second.y)
  const result = await desktop.page.locator('[data-field="message"]').textContent()
  if (!/(짝을 획득|지역이 일치하지|관광지 카드와 특산물 카드)/.test(result ?? '')) throw new Error(`pair selection did not resolve: ${result}`)
  await desktop.page.screenshot({ path: `${out}/02-play.png`, fullPage: true })
  await desktop.context.close()
  const mobile = await startPage({ width: 390, height: 844 }, errors)
  await mobile.page.screenshot({ path: `${out}/03-mobile.png`, fullPage: true })
  await mobile.context.close()
  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`)
  console.log(`smoke: OK — 3D card clicks, turn progression, pair attempt and mobile view; screenshots in ${out}/`)
} catch (error) {
  console.error(`smoke: FAIL — ${error?.message ?? String(error)}`)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
}
