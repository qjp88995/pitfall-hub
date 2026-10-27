const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_.@/#:-]+/gu
const MAX_TERMS = 64

export interface ParsedQuery {
  /** FTS5 MATCH expression, or null when no term is long enough for the trigram index. */
  fts: string | null
  /** Terms shorter than a trigram; matched with LIKE when there is no FTS expression. */
  short: string[]
}

/**
 * The trigram tokenizer only matches substrings of 3+ characters, and CJK text has no word
 * boundaries. So CJK runs are cut into overlapping 3-grams and every term is OR-ed together:
 * bm25 then ranks documents by how many of the grams they contain.
 */
export function parseQuery(q: string): ParsedQuery {
  const terms = new Set<string>()
  const short = new Set<string>()

  for (const raw of q.match(TOKEN) ?? []) {
    const token = raw.replace(/^[.:/#-]+|[.:/#-]+$/g, '')
    const chars = [...token]
    if (chars.length >= 3) {
      if (CJK_RUN.test(token)) {
        for (let i = 0; i + 3 <= chars.length; i++) terms.add(chars.slice(i, i + 3).join(''))
      } else {
        terms.add(token)
      }
    } else if (chars.length === 2 || (chars.length === 1 && CJK_RUN.test(token))) {
      short.add(token)
    }
    if (terms.size >= MAX_TERMS) break
  }

  const fts = terms.size ? [...terms].map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ') : null
  return { fts, short: [...short] }
}

/** Strips the volatile parts of an error line so the same failure on another machine still matches. */
export function normalizeSignature(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@+-]+){2,}/g, '<path>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out = new Set<string>()
  for (const t of tags ?? []) {
    const tag = t.trim().toLowerCase().replace(/\s+/g, '-')
    if (tag) out.add(tag)
  }
  return [...out]
}
