import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/core/db.js'
import { FeedbackStore } from '../src/core/feedback.js'
import { reviewPitfall, reviewQueue } from '../src/core/review.js'
import { PitfallStore } from '../src/core/store.js'

let store: PitfallStore
let feedback: FeedbackStore
const DAY = 86_400_000

beforeEach(() => {
  store = new PitfallStore(openDatabase(':memory:'))
  feedback = new FeedbackStore(store.db)
})

const irrelevant = (id: string) => feedback.report({ kind: 'false_positive', title: `Irrelevant match: ${id}`, pitfallId: id })
const open = (id: string, n: number) => {
  for (let i = 0; i < n; i++) store.get(id, { trackHit: true })
}
const ids = (now?: number) => reviewQueue(store, { now }).items.map((r) => r.pitfall.id)

describe('review queue', () => {
  it('is empty for a young, unused knowledge base', () => {
    store.create({ title: 'a', solution: 'x' })
    open(store.create({ title: 'b', solution: 'x' }).id, 2)
    expect(ids()).toEqual([])
  })

  it('lists entries reported irrelevant twice, and keep clears them until a new report', () => {
    const p = store.create({ title: 'a', solution: 'x' })
    irrelevant(p.id)
    expect(ids()).toEqual([])
    irrelevant(p.id)
    expect(reviewQueue(store).items[0]?.reasons).toEqual(['reported irrelevant 2x'])

    reviewPitfall(store, p.id, 'keep', 'signature tightened')
    expect(ids()).toEqual([])
    expect(feedback.list().items).toEqual([])
    expect(feedback.list({ status: ['done'] }).items[0]?.resolution).toBe('Entry reviewed (keep): signature tightened')

    irrelevant(p.id)
    irrelevant(p.id)
    expect(ids()).toEqual([p.id])
  })

  it('ignores false positives already resolved as matcher bugs', () => {
    const p = store.create({ title: 'a', solution: 'x' })
    irrelevant(p.id)
    const fb = irrelevant(p.id).feedback
    feedback.resolve(fb.id, 'done', 'matcher fixed')
    expect(ids()).toEqual([])
  })

  it('lists entries opened often but never helpful, counting only opens since the last review', () => {
    const p = store.create({ title: 'a', solution: 'x' })
    open(p.id, 5)
    expect(reviewQueue(store).items[0]?.reasons).toEqual(['opened 5x, never marked helpful'])
    reviewPitfall(store, p.id, 'keep')
    open(p.id, 4)
    expect(ids()).toEqual([])
    open(p.id, 1)
    expect(ids()).toEqual([p.id])
    store.feedback(p.id, 'helpful')
    expect(ids()).toEqual([])
  })

  it('lists entries never opened for 90 days after recording or the last review', () => {
    const p = store.create({ title: 'a', solution: 'x' })
    const used = store.create({ title: 'b', solution: 'x' })
    open(used.id, 1)
    expect(ids(Date.now() + 89 * DAY)).toEqual([])
    const later = Date.now() + 91 * DAY
    expect(reviewQueue(store, { now: later }).items.map((r) => r.reasons)).toEqual([['never opened in 91 days']])
    // Pretend it was recorded long ago; a review restarts the 90 days.
    store.db.prepare('UPDATE pitfalls SET created_at = ?').run(new Date(Date.now() - 200 * DAY).toISOString())
    expect(ids()).toEqual([p.id])
    reviewPitfall(store, p.id, 'keep')
    expect(ids(Date.now() + 89 * DAY)).toEqual([])
    expect(ids(later)).toEqual([p.id])
  })

  it('outdated / archived take the entry out of circulation and keep the note', () => {
    const a = store.create({ title: 'a', solution: 'x' })
    open(a.id, 5)
    const r = reviewPitfall(store, a.id, 'archived', 'project-specific')!
    expect(r.status).toBe('archived')
    expect(r.solution).toMatch(/reviewed, archived\*\*: project-specific$/)
    expect(ids()).toEqual([])
  })

  it('puts wrong matches first', () => {
    const silent = store.create({ title: 'silent', solution: 'x' })
    const noisy = store.create({ title: 'noisy', solution: 'x' })
    irrelevant(noisy.id)
    irrelevant(noisy.id)
    expect(ids(Date.now() + 100 * DAY)).toEqual([noisy.id, silent.id])
  })
})

describe('review migration', () => {
  it('upgrades a database created before the review columns', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pf-')), 'old.db')
    store = new PitfallStore(openDatabase(path))
    const p = store.create({ title: 'a', solution: 'x' })
    store.db.exec('ALTER TABLE pitfalls DROP COLUMN reviewed_at; ALTER TABLE pitfalls DROP COLUMN reviewed_hits; DROP TABLE usage_log; PRAGMA user_version = 2')
    store.db.close()
    const raw = new DatabaseSync(path)
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    raw.close()
    const upgraded = new PitfallStore(openDatabase(path))
    expect(upgraded.get(p.id)).toMatchObject({ reviewedAt: null, reviewedHits: 0 })
  })
})

describe('session start at pitfall-hub', () => {
  it('lists the review queue, and survives a backend without it', async () => {
    const { handleHook, localBackend } = await import('../src/hooks/claude.js')
    const p = store.create({ title: 'noisy entry', solution: 'x' })
    irrelevant(p.id)
    irrelevant(p.id)
    const hub = join(mkdtempSync(join(tmpdir(), 'x-')), 'pitfall-hub')
    mkdirSync(hub)
    writeFileSync(join(hub, 'package.json'), '{}')
    const ctx = async (backend: ReturnType<typeof localBackend>) =>
      ((await handleHook('session-start', { cwd: hub }, backend)) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
        .additionalContext

    expect(await ctx(localBackend(store))).toContain(`1 entry to review`)
    expect(await ctx(localBackend(store))).toContain(`${p.id} noisy entry ← reported irrelevant 2x`)

    const old = { ...localBackend(store), reviewQueue: async () => Promise.reject(new Error('Unknown rpc method')) }
    const out = await ctx(old)
    expect(out).not.toContain('unreachable')
    expect(out).toContain('open report(s)')
  })
})
