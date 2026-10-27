import { normalizeSignature } from './query.js'
import type { PitfallStore } from './store.js'
import type { Pitfall } from './types.js'

export interface ErrorMatch {
  pitfall: Pitfall
  reason: 'signature' | 'terms'
  matched: string[]
}

const ERROR_LINE = /error|err!|err_|fail|cannot|can't|could not|not found|no such|denied|refused|exception|panic|traceback|fatal|invalid|unexpected|undefined|missing|timeout|timed out|abort|segfault|错误|失败|异常/i
const STOP = new Set(
  `error errors failed failure fatal warning warn info debug cannot could not found with from that this have been were will when
   then than which there their your into while above below undefined null true false return value exit code status node_modules
   command commands line file files path module modules version run running npm pnpm yarn exception stack trace traceback
   internal process expected unexpected missing invalid https http www com`.split(/\s+/),
)
const MIN_SIGNATURE = 12

/**
 * Matches raw tool output (usually a failed command) against recorded pitfalls.
 * Built for precision: injecting a wrong pitfall into an agent's context is worse than none.
 *  1. signature: an entry's normalized error signature occurs verbatim in the normalized output.
 *  2. terms: distinctive tokens from the error lines (no generic words, no numbers) overlap
 *     the entry's title/symptom/signature at least twice and cover a quarter of the tokens.
 */
export function matchErrorOutput(store: PitfallStore, output: string, limit = 3): ErrorMatch[] {
  const text = output.length > 20_000 ? output.slice(0, 4_000) + '\n' + output.slice(-16_000) : output
  const normalized = normalizeSignature(text)
  const results: ErrorMatch[] = []
  const seen = new Set<string>()

  for (const p of store.withSignatures()) {
    const sig = normalizeSignature(p.errorSignature)
    if (sig.length >= MIN_SIGNATURE && normalized.includes(sig)) {
      results.push({ pitfall: p, reason: 'signature', matched: [p.errorSignature] })
      seen.add(p.id)
    }
  }

  const tokens = distinctiveTokens(text)
  if (tokens.length >= 2 && results.length < limit) {
    const { items } = store.search({ q: tokens.join(' '), limit: 10 })
    for (const p of items) {
      if (seen.has(p.id)) continue
      const hay = `${p.title}\n${p.symptom}\n${p.errorSignature}`.toLowerCase()
      const matched = tokens.filter((t) => hay.includes(t))
      if (matched.length >= 2 && matched.length / tokens.length >= 0.25) {
        results.push({ pitfall: p, reason: 'terms', matched })
      }
    }
  }
  return results.slice(0, limit)
}

export function distinctiveTokens(output: string, max = 12): string[] {
  const lines = output.split('\n').filter((l) => ERROR_LINE.test(l))
  const counts = new Map<string, number>()
  for (const line of (lines.length ? lines : output.split('\n')).slice(0, 40)) {
    for (const raw of line.toLowerCase().match(/[a-z_$][\w$.@/-]{3,}|[\p{Script=Han}]{3,}/gu) ?? []) {
      const t = raw.replace(/[./-]+$/, '')
      if (t.length < 4 || STOP.has(t) || /^(?:\/|\.\/|~\/)/.test(t) || /\d{3,}/.test(t)) continue
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  // Rare tokens are the distinctive ones (e.g. ERR_PNPM_LIFECYCLE, a package name).
  return [...counts.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([t]) => t)
}
