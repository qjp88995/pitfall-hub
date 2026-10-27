import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { PitfallStore } from '../core/store.js'
import { STATUSES, type PitfallInput, type PitfallPatch, type PitfallStatus } from '../core/types.js'

const WEB_DIST = resolve(fileURLToPath(import.meta.url), '../../web')

export function createApp(store: PitfallStore) {
  const app = new Hono()

  app.onError((err, c) => c.json({ error: err.message }, 400))

  app.get('/api/pitfalls', (c) => {
    const q = c.req.query()
    const status = q.status === 'all' ? [] : q.status ? (q.status.split(',') as PitfallStatus[]).filter((s) => STATUSES.includes(s)) : ['active' as const]
    return c.json(
      store.search({
        q: q.q,
        tags: q.tags ? q.tags.split(',') : undefined,
        status,
        project: q.project,
        limit: q.limit ? Number(q.limit) : 50,
        offset: q.offset ? Number(q.offset) : 0,
      }),
    )
  })
  app.get('/api/pitfalls/:id', (c) => {
    const p = store.get(c.req.param('id'))
    return p ? c.json(p) : c.json({ error: 'not found' }, 404)
  })
  app.post('/api/pitfalls', async (c) => c.json(store.create({ sourceAgent: 'web', ...(await c.req.json<PitfallInput>()) }), 201))
  app.patch('/api/pitfalls/:id', async (c) => {
    const p = store.update(c.req.param('id'), await c.req.json<PitfallPatch>())
    return p ? c.json(p) : c.json({ error: 'not found' }, 404)
  })
  app.delete('/api/pitfalls/:id', (c) => (store.remove(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'not found' }, 404)))
  app.get('/api/tags', (c) => c.json(store.tags()))
  app.get('/api/stats', (c) => c.json(store.stats()))
  app.get('/api/export', (c) => c.json(store.exportAll()))

  if (existsSync(WEB_DIST)) {
    const root = relative(process.cwd(), WEB_DIST) || '.'
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }
  return app
}

export function runWebServer(store: PitfallStore, port: number) {
  if (!existsSync(WEB_DIST)) console.error(`UI not built (${WEB_DIST} missing); run "pnpm build". API only.`)
  serve({ fetch: createApp(store).fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`pitfall-hub UI → http://localhost:${info.port}`)
  })
}
