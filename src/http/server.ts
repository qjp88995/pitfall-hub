import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono, type Context, type Next } from 'hono'
import { matchErrorOutput } from '../core/match.js'
import type { PitfallStore } from '../core/store.js'
import { STATUSES, type PitfallInput, type PitfallPatch, type PitfallStatus } from '../core/types.js'
import { createMcpServer } from '../mcp/server.js'

const WEB_DIST = resolve(fileURLToPath(import.meta.url), '../../web')

export interface AppOptions {
  /** Accepted bearer tokens. Empty = no auth (local use only). */
  tokens?: string[]
}

export function createApp(store: PitfallStore, opts: AppOptions = {}) {
  const app = new Hono()
  const tokens = (opts.tokens ?? []).map((t) => Buffer.from(t))

  app.onError((err, c) => c.json({ error: err.message }, 400))

  app.get('/healthz', (c) => c.json({ ok: true, auth: tokens.length > 0 }))

  // Everything that touches data needs a token; the static UI shell does not.
  if (tokens.length) {
    const guard = async (c: Context, next: Next) => {
      const given = Buffer.from(c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '')
      if (!tokens.some((t) => t.length === given.length && timingSafeEqual(t, given))) {
        return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
      }
      await next()
    }
    app.use('/api/*', guard)
    app.use('/mcp', guard)
  }

  // MCP over Streamable HTTP, stateless: a fresh server per request, all state lives in SQLite.
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await createMcpServer(store).connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  // Used by host-side Claude Code hooks when the database lives in a container.
  app.post('/api/match', async (c) => {
    const { output } = await c.req.json<{ output: string }>()
    return c.json(matchErrorOutput(store, output ?? ''))
  })
  app.post('/api/relevant', async (c) => {
    const { tags, limit } = await c.req.json<{ tags: string[]; limit?: number }>()
    return c.json(store.relevantForTags(tags ?? [], limit))
  })

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
  app.post('/api/import', async (c) => c.json(store.importMany(await c.req.json())))

  if (existsSync(WEB_DIST)) {
    const root = relative(process.cwd(), WEB_DIST) || '.'
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }
  return app
}

export function runWebServer(store: PitfallStore, port: number, hostname: string) {
  const tokens = (process.env.PITFALL_HUB_TOKEN ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(hostname)
  if (!tokens.length && !loopback && process.env.PITFALL_HUB_ALLOW_NO_AUTH !== '1') {
    throw new Error(`Refusing to listen on ${hostname} without auth: set PITFALL_HUB_TOKEN (or PITFALL_HUB_ALLOW_NO_AUTH=1 on a private network).`)
  }
  if (tokens.some((t) => t.length < 24)) throw new Error('PITFALL_HUB_TOKEN entries must be at least 24 characters (openssl rand -base64 32).')
  if (!existsSync(WEB_DIST)) console.error(`UI not built (${WEB_DIST} missing); run "pnpm build". API only.`)
  serve({ fetch: createApp(store, { tokens }).fetch, port, hostname }, (info) => {
    console.log(`pitfall-hub UI → http://localhost:${info.port} (auth ${tokens.length ? 'on' : 'off'})`)
  })
}
