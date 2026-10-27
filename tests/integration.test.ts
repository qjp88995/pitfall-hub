import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/core/db.js'
import { distinctiveTokens, matchErrorOutput } from '../src/core/match.js'
import { PitfallStore } from '../src/core/store.js'
import { install, uninstall } from '../src/install/claude.js'
import { createMcpServer } from '../src/mcp/server.js'

let store: PitfallStore

beforeEach(() => {
  store = new PitfallStore(openDatabase(':memory:'))
})

describe('matchErrorOutput', () => {
  it('matches by terms without a signature, and ignores generic failures', () => {
    const p = store.create({
      title: 'Prisma client not generated after pnpm install',
      symptom: '@prisma/client did not initialize yet. Please run "prisma generate"',
      solution: 'Add "postinstall": "prisma generate"',
      tags: ['prisma'],
    })
    const out = 'Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.'
    expect(matchErrorOutput(store, out).map((m) => m.pitfall.id)).toEqual([p.id])
    expect(matchErrorOutput(store, 'Error: Command failed with exit code 1\nnpm ERR! code ELIFECYCLE')).toEqual([])
  })

  it('prefers rare tokens', () => {
    expect(distinctiveTokens('Error: ENOENT: no such file\nError: ENOENT foobar')[0]).toBe('foobar')
  })
})

describe('MCP server', () => {
  async function connect() {
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(store).connect(a)
    const client = new Client({ name: 'test-agent', version: '1' })
    await client.connect(b)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
      return r.content[0]!.text
    }
    return call
  }

  it('records, refuses duplicates, appends notes and searches', async () => {
    const call = await connect()
    const rec = await call('record_pitfall', {
      title: 'Next.js build fails: useSearchParams needs Suspense',
      solution: 'Wrap the component in <Suspense>',
      error_signature: 'useSearchParams() should be wrapped in a suspense boundary at page "/app/search/page"',
      tags: ['next'],
    })
    const id = /Recorded (\S+):/.exec(rec)![1]!
    expect(store.get(id)?.sourceAgent).toBe('test-agent')

    const dup = await call('record_pitfall', {
      title: 'another wording',
      solution: 'x',
      error_signature: 'useSearchParams() should be wrapped in a suspense boundary at page "/app/other/page"',
    })
    expect(dup).toContain('Not recorded')
    expect(dup).toContain(id)

    await call('update_pitfall', { id, append_note: 'Also applies to usePathname in Next 15', tags: ['next', 'react'] })
    expect(store.get(id)?.solution).toContain('usePathname')
    expect(store.get(id)?.tags).toEqual(['next', 'react'])

    expect(await call('search_pitfalls', { query: 'suspense boundary' })).toContain(id)
    expect(await call('get_pitfall', { id })).toContain('## Solution')
    expect(store.get(id)?.hitCount).toBe(1)

    await call('pitfall_feedback', { id, kind: 'outdated', note: 'fixed in next 16' })
    expect(await call('search_pitfalls', { query: 'suspense boundary' })).toContain('No pitfalls')
  })
})

describe('install', () => {
  it('merges hooks idempotently and preserves foreign settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pitfall-claude-'))
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PostToolUseFailure: [foreign] } }))

    install({ claudeDir: dir, skipMcp: true })
    install({ claudeDir: dir, skipMcp: true })
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(settings.model).toBe('x')
    expect(settings.hooks.PostToolUseFailure).toHaveLength(2)
    expect(settings.hooks.PostToolUseFailure[0]).toEqual(foreign)
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'Stop'])
    expect(readFileSync(join(dir, 'skills/pitfall-hub/SKILL.md'), 'utf8')).toContain('name: pitfall-hub')

    uninstall({ claudeDir: dir, skipMcp: true })
    const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(after.hooks).toEqual({ PostToolUseFailure: [foreign] })
  })
})

describe('HTTP auth', () => {
  const token = 'x'.repeat(32)

  it('guards /api and /mcp but not health or the UI shell', async () => {
    const { createApp } = await import('../src/http/server.js')
    const app = createApp(store, { tokens: [token] })
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/api/stats')).status).toBe(401)
    expect((await app.request('/api/stats', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await app.request('/api/stats', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await app.request('/mcp', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await app.request('/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(405)
  })

  it('serves MCP over HTTP with a valid token', async () => {
    const { createApp } = await import('../src/http/server.js')
    const app = createApp(store, { tokens: [token] })
    store.create({ title: 'docker buildx cache mount ignored', solution: 'enable BuildKit' })
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_pitfalls', arguments: { query: 'buildx' } } }),
    })
    const body = (await res.json()) as { result: { content: { text: string }[] } }
    expect(body.result.content[0]!.text).toContain('docker buildx cache mount ignored')
  })
})

describe('signature precision', () => {
  it('ignores signatures that become generic after normalization', async () => {
    const { isDistinctiveSignature } = await import('../src/core/match.js')
    expect(isDistinctiveSignature('exit code 144')).toBe(false)
    expect(isDistinctiveSignature('Could not load the "sharp" module using the linux-x64 runtime')).toBe(true)
    store.create({ title: 'pkill self-kill', solution: 'x', errorSignature: 'exit code 144' })
    expect(matchErrorOutput(store, 'Exit code 1\nls: cannot access foo')).toEqual([])
  })
})

describe('term matching precision', () => {
  it('does not match on a couple of common words', () => {
    store.create({
      title: 'Sibling container unreachable from sandboxed workspace',
      symptom: 'curl http://pitfall-hub:4477 → Empty reply from server',
      solution: 'use docker exec',
    })
    const tls = `curl: (60) SSL certificate problem: self-signed certificate
curl failed to verify the legitimacy of the server and therefore could not establish a secure connection to it.`
    expect(matchErrorOutput(store, tls)).toEqual([])
    const short = 'curl: (60) SSL certificate problem: self-signed certificate\ncurl failed to verify the legitimacy of the server'
    expect(matchErrorOutput(store, short)).toEqual([])
  })
})
