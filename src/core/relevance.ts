import type { Pitfall } from './types.js'

/**
 * The full-text index ORs every query term together, so it returns something for any query:
 * "vitest vi.mock not applied" brings back prettier and oidc entries on "applied" and "module".
 * Coverage decides whether a hit is really about the query: the share of the query's terms the
 * entry contains, each weighted by how rare it is across the knowledge base (a hit on "node" or
 * "error" says little, a hit on "pptxgenjs" or "ERR_REQUIRE_ESM" says a lot).
 *
 * Measured on agent-style queries written per entry plus queries for problems the base does not
 * cover: at 0.5, recall@5 stays at 0.99 while queries with no answer go from 20/20 returning
 * noise to 1/20.
 */
export const SEARCH_MIN_COVERAGE = 0.5

const STOP = new Set(
  `the and for with not when after before from into than that this then there does doesn don dont
   fail fails failed failing failure error errors wrong works work working using use used get gets set
   run runs running why how can cannot only some still also just like but are was were has have had
   its out off all any one new two what which while where who issue problem broken instead`.split(/\s+/),
)
const CJK = /^\p{Script=Han}/u

export function queryTerms(q: string): string[] {
  const out = new Set<string>()
  for (const t of q.toLowerCase().match(/\p{Script=Han}+|[a-z0-9_@$][\w@$./-]*/gu) ?? []) {
    if (CJK.test(t)) {
      const c = [...t]
      for (let i = 0; i + 2 <= c.length; i++) out.add(c.slice(i, i + 2).join(''))
    } else {
      const w = t.replace(/[./-]+$/, '')
      if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w)
    }
  }
  return [...out]
}

interface DocWords {
  hay: string
  words: Set<string>
}

function docWords(p: Pick<Pitfall, 'title' | 'symptom' | 'cause' | 'solution' | 'errorSignature' | 'tags'>): DocWords {
  const hay = [p.title, p.symptom, p.cause, p.solution, p.errorSignature, p.tags.join(' ')].join('\n').toLowerCase()
  const words = new Set<string>()
  for (const raw of hay.match(/[a-z0-9_@$][\w@$./-]*/g) ?? []) {
    words.add(raw.replace(/[./-]+$/, ''))
    for (const part of raw.split(/[^\w$@]+/)) if (part) words.add(part)
  }
  return { hay, words }
}

/** Whole words, or a near inflection ("render" / "rendering", "font" / "fonts"); CJK by substring. */
function contains(d: DocWords, t: string): boolean {
  if (CJK.test(t)) return d.hay.includes(t)
  if (d.words.has(t)) return true
  for (const w of d.words) {
    if (w.length >= 4 && Math.abs(w.length - t.length) <= 3 && (t.startsWith(w) || w.startsWith(t))) return true
  }
  return false
}

export class Relevance {
  private readonly docs: Map<string, DocWords>
  private readonly idfCache = new Map<string, number>()

  constructor(pitfalls: Pitfall[]) {
    this.docs = new Map(pitfalls.map((p) => [p.id, docWords(p)]))
  }

  private idf(t: string): number {
    let v = this.idfCache.get(t)
    if (v === undefined) {
      let df = 0
      for (const d of this.docs.values()) if (contains(d, t)) df++
      v = Math.log((this.docs.size + 1) / (df + 0.5))
      this.idfCache.set(t, v)
    }
    return v
  }

  /** 0..1; 1 when the query has no usable terms, so such queries are not filtered. */
  coverage(q: string, p: Pitfall): number {
    const terms = queryTerms(q)
    if (!terms.length) return 1
    const d = this.docs.get(p.id) ?? docWords(p)
    let total = 0
    let hit = 0
    for (const t of terms) {
      const w = Math.max(this.idf(t), 0.05)
      total += w
      if (contains(d, t)) hit += w
    }
    return hit / total
  }
}
