import { normalizeSignature, normalizeTags } from './query.js'
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
   internal process expected unexpected missing invalid https http www com
   most recent call last
   typeerror referenceerror syntaxerror rangeerror valueerror keyerror indexerror attributeerror
   runtimeerror nameerror importerror oserror ioerror assertionerror
   enoent eacces eperm eexist eisdir enotdir enotempty ebusy emfile errno syscall such directory open`.split(/\s+/),
)
const MIN_SIGNATURE = 12
// Error codes, package names, flags: ERR_PNPM_LIFECYCLE, @prisma/client, linux-x64. Plain words
// like "server" or "curl" show up in unrelated failures and are not enough on their own.
const IDENTIFIER = /[_@/.$-]|\d/
const MIN_SIGNATURE_TOKENS = 2
// Plain English words ("type", "data", "instead") overlap almost any long symptom; without an
// identifier among them, demand more of them and a bigger share of the output's tokens.
const PLAIN_MIN_MATCHED = 4
const PLAIN_MIN_RATIO = 0.4

/**
 * A signature is only trusted for exact matching if something specific survives normalization.
 * "exit code 144" normalizes to "exit code <n>", which every failed command contains.
 */
export function isDistinctiveSignature(signature: string): boolean {
  const sig = normalizeSignature(signature)
  if (sig.length < MIN_SIGNATURE) return false
  const tokens = sig
    .replace(/<(?:path|n|hex)>/g, ' ')
    .match(/[a-z_$][\w$.@-]{3,}|[\p{Script=Han}]{2,}/gu)
  return new Set((tokens ?? []).filter((t) => !STOP.has(t))).size >= MIN_SIGNATURE_TOKENS
}

/**
 * Matches raw tool output (usually a failed command) against recorded pitfalls.
 * Built for precision: injecting a wrong pitfall into an agent's context is worse than none.
 *  1. signature: an entry's normalized error signature occurs verbatim in the normalized output.
 *  2. terms: distinctive tokens from the error lines (no generic words, no numbers) overlap the
 *     entry's title/symptom/signature. With an identifier-like token among them: 3+ tokens covering
 *     a quarter, or 2+ covering half. Plain words only: 4+ covering 40%. Output with no error-looking line at all (a command that failed
 *     silently after printing routine logs or NOTICEs) needs 2+ identifier-like tokens instead, since
 *     its words are just whatever the command printed ("migrations", "complete", "routine").
 *     With a `context` (the project's stack tags plus the words of the failed command), a terms
 *     match also needs one of the entry's tags in it: an eslint failure in a project without Docker
 *     must not pull in a Docker entry because both texts say "type" and "data". Signature matches
 *     are exact and need no context.
 */
export function matchErrorOutput(store: PitfallStore, output: string, opts: { limit?: number; context?: string[] } = {}): ErrorMatch[] {
  const limit = opts.limit ?? 3
  const context = opts.context ? new Set(normalizeTags(opts.context)) : null
  const text = output.length > 20_000 ? output.slice(0, 4_000) + '\n' + output.slice(-16_000) : output
  const normalized = normalizeSignature(text)
  const results: ErrorMatch[] = []
  const seen = new Set<string>()

  for (const p of store.withSignatures()) {
    if (!isDistinctiveSignature(p.errorSignature)) continue
    if (normalized.includes(normalizeSignature(p.errorSignature))) {
      results.push({ pitfall: p, reason: 'signature', matched: [p.errorSignature] })
      seen.add(p.id)
    }
  }

  const tokens = distinctiveTokens(text)
  const hasErrorLine = text.split('\n').some((l) => ERROR_LINE.test(l))
  if (tokens.length >= 2 && results.length < limit) {
    const { items } = store.search({ q: tokens.join(' '), limit: 10 })
    for (const p of items) {
      if (seen.has(p.id)) continue
      if (context && !p.tags.some((t) => context.has(t))) continue
      const hay = `${p.title}\n${p.symptom}\n${p.errorSignature}`.toLowerCase()
      const words = wordSet(hay)
      // Whole words only: "call" must not match "callback". CJK has no word boundaries.
      const matched = tokens.filter((t) => (/^\p{Script=Han}/u.test(t) ? hay.includes(t) : words.has(t)))
      const ratio = matched.length / tokens.length
      const specific = matched.filter((t) => IDENTIFIER.test(t)).length
      const ok = hasErrorLine
        ? specific >= 1
          ? (matched.length >= 3 && ratio >= 0.25) || (matched.length >= 2 && ratio >= 0.5)
          : matched.length >= PLAIN_MIN_MATCHED && ratio >= PLAIN_MIN_RATIO
        : specific >= 2
      if (ok) {
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
    for (const m of line.toLowerCase().matchAll(/[a-z_$][\w$.@/-]{3,}|[\p{Script=Han}]{3,}/gu)) {
      const t = m[0].replace(/[./-]+$/, '')
      // Paths: the token regex skips a leading "/", so look at the character before the match.
      const inPath = /[/\\~]/.test(line[m.index - 1] ?? '')
      if (t.length < 4 || STOP.has(t) || inPath || /^(?:\.\/|~\/)/.test(t) || /\d{3,}/.test(t)) continue
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  // Rare tokens are the distinctive ones (e.g. ERR_PNPM_LIFECYCLE, a package name).
  return [...counts.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([t]) => t)
}

/** Identifiers as written plus their parts, so "@prisma/client" also offers "prisma" and "client". */
function wordSet(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.match(/[a-z_$@][\w$.@/-]*/g) ?? []) {
    out.add(raw.replace(/[./-]+$/, ''))
    for (const part of raw.split(/[^\w$]+/)) if (part) out.add(part)
  }
  return out
}

const SIMILAR_MIN_SHARED = 3
const SIMILAR_MIN_OVERLAP = 0.3

/**
 * Existing entries that probably describe the same problem as `p`, shown after record_pitfall
 * so the agent can merge them. Shared tags or a shared word are not enough ("traefik" links a TLS
 * pitfall to an MCP one): the titles+symptoms must share several content terms, covering a good
 * part of the shorter one.
 */
export function similarEntries(store: PitfallStore, p: Pitfall, limit = 3): Pitfall[] {
  const mine = contentTerms(p)
  if (mine.size < SIMILAR_MIN_SHARED) return []
  const { items } = store.search({ q: `${p.title} ${p.symptom}`, limit: 20 })
  return items
    .filter((s) => s.id !== p.id)
    .map((s) => {
      const theirs = contentTerms(s)
      const shared = [...mine].filter((t) => theirs.has(t)).length
      return { s, shared, overlap: shared / Math.min(mine.size, theirs.size) }
    })
    .filter((x) => x.shared >= SIMILAR_MIN_SHARED && x.overlap >= SIMILAR_MIN_OVERLAP)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map((x) => x.s)
}

/** Latin words/identifiers (no generic words) and CJK bigrams from title, symptom and signature. */
function contentTerms(p: Pick<Pitfall, 'title' | 'symptom' | 'errorSignature'>): Set<string> {
  const out = new Set<string>()
  for (const raw of `${p.title}\n${p.symptom}\n${p.errorSignature}`.toLowerCase().match(/[a-z_$@][\w$.@/-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (/^\p{Script=Han}/u.test(raw)) {
      const chars = [...raw]
      for (let i = 0; i + 2 <= chars.length; i++) out.add(chars.slice(i, i + 2).join(''))
    } else {
      const t = raw.replace(/[./-]+$/, '')
      if (t.length >= 3 && !STOP.has(t)) out.add(t)
    }
  }
  return out
}

/**
 * What a failure is about, for matchErrorOutput's `context`: the command's words, with each
 * path also offering its last segment ("./node_modules/.bin/eslint" → "eslint").
 */
export function commandContext(command: string): string[] {
  const out = new Set<string>()
  for (const raw of command.slice(0, 2_000).toLowerCase().match(/[a-z0-9@][\w@./-]*/g) ?? []) {
    const t = raw.replace(/[./-]+$/, '')
    if (t) out.add(t)
    const last = t.split('/').pop()
    if (last) out.add(last)
  }
  return [...out]
}
