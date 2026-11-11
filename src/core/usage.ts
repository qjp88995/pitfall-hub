import type { DatabaseSync } from 'node:sqlite'
import { matchErrorOutput, type ErrorMatch } from './match.js'
import type { PitfallStore } from './store.js'

/**
 * Retrieval events: searches (with what they returned), entries opened, failure matches pushed by
 * the hook, and feedback verdicts. Error output itself is never stored (it can carry secrets);
 * search queries are, since agents type them on purpose.
 */
export type UsageKind = 'search' | 'open' | 'match' | 'helpful' | 'outdated' | 'irrelevant'

export interface UsageEvent {
  kind: UsageKind
  query?: string
  ids?: string[]
  total?: number
  project?: string
  agent?: string
}

const RETENTION_DAYS = 180
// An open counts as following a search or match when it comes this soon after it.
const FOLLOW_WINDOW_MS = 30 * 60_000

export function logUsage(db: DatabaseSync, e: UsageEvent): void {
  try {
    const now = new Date()
    db.prepare('INSERT INTO usage_log (at, kind, query, ids, total, project, agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      now.toISOString(),
      e.kind,
      (e.query ?? '').slice(0, 500),
      JSON.stringify(e.ids ?? []),
      e.total ?? e.ids?.length ?? 0,
      e.project ?? '',
      e.agent ?? '',
    )
    db.prepare('DELETE FROM usage_log WHERE at < ?').run(new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString())
  } catch {
    // Logging must never break retrieval.
  }
}

interface Row {
  at: string
  kind: UsageKind
  query: string
  ids: string
  total: number
  project: string
}

export interface UsageReport {
  days: number
  counts: Partial<Record<UsageKind, number>>
  searches: { total: number; empty: number; followedByOpen: number }
  matches: { total: number; followedByOpen: number }
  recentEmpty: { at: string; query: string; project: string }[]
  recentUnopened: { at: string; query: string; project: string; total: number }[]
}

export function usageReport(db: DatabaseSync, days = 30): UsageReport {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = (db.prepare('SELECT at, kind, query, ids, total, project FROM usage_log WHERE at >= ? ORDER BY seq').all(since) as unknown as Row[]).map(
    (r) => ({ ...r, idList: JSON.parse(r.ids) as string[], t: Date.parse(r.at) }),
  )
  const opens = rows.filter((r) => r.kind === 'open')
  const followed = (r: (typeof rows)[number]) =>
    opens.some((o) => o.t >= r.t && o.t - r.t <= FOLLOW_WINDOW_MS && (!r.project || o.project === r.project) && r.idList.includes(o.idList[0] ?? ''))

  const counts: UsageReport['counts'] = {}
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  const searches = rows.filter((r) => r.kind === 'search')
  const matches = rows.filter((r) => r.kind === 'match')
  const pick = (r: Row) => ({ at: r.at.slice(0, 16), query: r.query, project: r.project })
  return {
    days,
    counts,
    searches: { total: searches.length, empty: searches.filter((r) => !r.total).length, followedByOpen: searches.filter(followed).length },
    matches: { total: matches.length, followedByOpen: matches.filter(followed).length },
    recentEmpty: searches.filter((r) => !r.total).slice(-15).reverse().map(pick),
    recentUnopened: searches
      .filter((r) => r.total && !followed(r))
      .slice(-15)
      .reverse()
      .map((r) => ({ ...pick(r), total: r.total })),
  }
}

export function formatUsageReport(r: UsageReport): string {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')
  return [
    `Last ${r.days} days: ${Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'no events'}`,
    `searches ${r.searches.total}: no result ${r.searches.empty} (${pct(r.searches.empty, r.searches.total)}), a result opened within 30 min ${r.searches.followedByOpen} (${pct(r.searches.followedByOpen, r.searches.total)})`,
    `failure matches pushed ${r.matches.total}: opened ${r.matches.followedByOpen} (${pct(r.matches.followedByOpen, r.matches.total)})`,
    r.recentEmpty.length ? `\nRecent searches with no result (possible misses):\n${r.recentEmpty.map((e) => `  ${e.at} [${e.project || '-'}] ${e.query}`).join('\n')}` : '',
    r.recentUnopened.length
      ? `\nRecent searches whose results were not opened (possible noise):\n${r.recentUnopened.map((e) => `  ${e.at} [${e.project || '-'}] ${e.query} (${e.total})`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export interface MatchRequest {
  /** Stack tags and command words; terms matches need an entry tag among them. */
  context?: string[]
  /** For the usage log. */
  project?: string
}

/** Server side of a hook's match request: match, then log which entries were pushed (not the output). */
export function matchAndLog(store: PitfallStore, output: string, req: MatchRequest = {}): ErrorMatch[] {
  const context = Array.isArray(req.context) ? req.context.filter((t): t is string => typeof t === 'string') : undefined
  const matches = matchErrorOutput(store, output, { context })
  if (matches.length) {
    logUsage(store.db, { kind: 'match', ids: matches.map((m) => m.pitfall.id), project: typeof req.project === 'string' ? req.project : '', agent: 'hook' })
  }
  return matches
}
