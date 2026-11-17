import { manusGameTuning } from './scripts/manus-tuning/vite.mjs'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Deployed pages use managed storage. For local tests, resolve the same
// immutable model and character-image URLs to restored project files.
function localManagedModels() {
  const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = (req.url ?? '').split('?')[0]
    if (!url.startsWith('/manus-storage/game/sha256/') || !/\.(glb|webp)$/.test(url)) return next()
    try {
      const lock = JSON.parse(readFileSync(resolve('assets.lock.json'), 'utf8')) as { assets: Record<string, { path: string }> }
      const found = Object.entries(lock.assets).find(([key, value]) => (key.startsWith('assets/models/') || key.startsWith('assets/mascots/')) && value.path === url)
      const file = found && resolve(found[0])
      if (!file || !existsSync(file)) return next()
      res.setHeader('Content-Type', url.endsWith('.glb') ? 'model/gltf-binary' : 'image/webp')
      createReadStream(file).pipe(res)
    } catch { next() }
  }
  return {
    name: 'local-managed-models',
    configureServer(server: { middlewares: { use: (fn: typeof serve) => void } }) { server.middlewares.use(serve) },
    configurePreviewServer(server: { middlewares: { use: (fn: typeof serve) => void } }) { server.middlewares.use(serve) },
  }
}

// Relative base keeps production output portable; the Session owns preview HOST/PORT.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', ['HOST', 'PORT'])
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  return {
    base: './',
    plugins: [manusGameTuning(), localManagedModels()],
    server: {
      host: env.HOST ?? '127.0.0.1', port, strictPort: true,
      allowedHosts: ['.manuspre.computer', '.manus.computer', '.manus-asia.computer', '.manuscomputer.ai', '.manusvm.computer', 'localhost', '127.0.0.1'],
    },
    build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4600, sourcemap: false },
    test: { environment: 'node', include: ['tests/**/*.test.{ts,mjs}'] },
  }
})
