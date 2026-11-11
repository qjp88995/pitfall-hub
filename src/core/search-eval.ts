import { SEARCH_MIN_COVERAGE } from './relevance.js'
import type { PitfallStore } from './store.js'
import type { EvalResult, EvalRun } from './types.js'

export type { EvalResult, EvalRun }

/**
 * A query set: what an agent would type when it hits the problem, and the entry that answers it,
 * or null for a problem the base does not cover (which should come back empty). It refers to the
 * entries of one database, so it is kept next to that database, not in this repository.
 */
export interface EvalCase {
  query: string
  expect: string | null
}


export function evaluateSearch(store: PitfallStore, cases: EvalCase[], minCoverage = SEARCH_MIN_COVERAGE): EvalResult {
  const pos = cases.filter((c): c is EvalCase & { expect: string } => !!c.expect)
  const neg = cases.filter((c) => !c.expect)
  let r1 = 0
  let r5 = 0
  let mrr = 0
  const misses: EvalResult['misses'] = []
  for (const c of pos) {
    const got = store.search({ q: c.query, limit: 10, minCoverage }).items.map((p) => p.id)
    const rank = got.indexOf(c.expect) + 1
    if (rank === 1) r1++
    if (rank && rank <= 5) r5++
    if (rank) mrr += 1 / rank
    if (!rank || rank > 5) misses.push({ query: c.query, expect: c.expect, got: got.slice(0, 3) })
  }
  const noise: EvalResult['noise'] = []
  for (const c of neg) {
    const got = store.search({ q: c.query, limit: 5, minCoverage }).items.map((p) => p.id)
    if (got.length) noise.push({ query: c.query, got })
  }
  const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : 0)
  return {
    answerable: pos.length,
    recallAt1: ratio(r1, pos.length),
    recallAt5: ratio(r5, pos.length),
    mrr: ratio(mrr, pos.length),
    unanswerable: neg.length,
    noisy: noise.length,
    misses,
    noise,
  }
}


export function saveEvalRun(store: PitfallStore, r: EvalResult): void {
  store.db.prepare('INSERT INTO eval_runs (at, result) VALUES (?, ?)').run(new Date().toISOString(), JSON.stringify(r))
}

/** Newest first. */
export function evalRuns(store: PitfallStore, limit = 10): EvalRun[] {
  const rows = store.db.prepare('SELECT at, result FROM eval_runs ORDER BY seq DESC LIMIT ?').all(limit) as unknown as { at: string; result: string }[]
  return rows.map((r) => ({ ...(JSON.parse(r.result) as EvalResult), at: r.at }))
}
