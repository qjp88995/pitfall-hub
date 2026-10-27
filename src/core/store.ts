import { randomBytes } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { fallbackTerms, normalizeSignature, normalizeTags, parseQuery } from './query.js'
import {
  SEVERITIES,
  STATUSES,
  type Pitfall,
  type PitfallInput,
  type PitfallPatch,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from './types.js'

interface Row {
  id: string
  title: string
  symptom: string
  cause: string
  solution: string
  prevention: string
  tags: string
  environment: string
  error_signature: string
  source_project: string
  source_agent: string
  severity: Pitfall['severity']
  status: Pitfall['status']
  hit_count: number
  helpful_count: number
  created_at: string
  updated_at: string
  last_hit_at: string | null
  score?: number | null
}

const COLUMNS = {
  title: 'title',
  symptom: 'symptom',
  cause: 'cause',
  solution: 'solution',
  prevention: 'prevention',
  tags: 'tags',
  environment: 'environment',
  errorSignature: 'error_signature',
  severity: 'severity',
  status: 'status',
} as const satisfies Record<keyof PitfallPatch, string>

// bm25 column weights, in pitfalls_fts column order.
const BM25 = 'bm25(pitfalls_fts, 10, 5, 2, 2, 1, 6, 8, 1)'
const LIKE_FIELDS = ['title', 'symptom', 'cause', 'solution', 'tags', 'error_signature']

export class PitfallStore {
  constructor(readonly db: DatabaseSync) {}

  create(input: PitfallInput): Pitfall {
    const now = new Date().toISOString()
    const id = `pf_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    const p = sanitize(input)
    this.db
      .prepare(
        `INSERT INTO pitfalls (id, title, symptom, cause, solution, prevention, tags, environment, error_signature,
           source_project, source_agent, severity, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.title,
        p.symptom ?? '',
        p.cause ?? '',
        p.solution,
        p.prevention ?? '',
        JSON.stringify(p.tags ?? []),
        p.environment ?? '',
        p.errorSignature ?? '',
        p.sourceProject ?? '',
        p.sourceAgent ?? '',
        p.severity ?? 'medium',
        p.status ?? 'active',
        now,
        now,
      )
    return this.get(id)!
  }

  get(id: string, opts: { trackHit?: boolean } = {}): Pitfall | null {
    if (opts.trackHit) {
      this.db
        .prepare('UPDATE pitfalls SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id)
    }
    const row = this.db.prepare('SELECT * FROM pitfalls WHERE id = ?').get(id) as Row | undefined
    return row ? toPitfall(row) : null
  }

  update(id: string, patch: PitfallPatch): Pitfall | null {
    const p = sanitize(patch)
    const sets: string[] = []
    const values: SQLInputValue[] = []
    for (const [key, column] of Object.entries(COLUMNS) as [keyof PitfallPatch, string][]) {
      const value = p[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(key === 'tags' ? JSON.stringify(value) : (value as string))
    }
    if (!sets.length) return this.get(id)
    sets.push('updated_at = ?')
    values.push(new Date().toISOString(), id)
    const { changes } = this.db.prepare(`UPDATE pitfalls SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return changes ? this.get(id) : null
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM pitfalls WHERE id = ?').run(id).changes > 0
  }

  feedback(id: string, kind: 'helpful' | 'outdated'): Pitfall | null {
    const sql =
      kind === 'helpful'
        ? 'UPDATE pitfalls SET helpful_count = helpful_count + 1 WHERE id = ?'
        : "UPDATE pitfalls SET status = 'outdated', updated_at = ? WHERE id = ?"
    const args = kind === 'helpful' ? [id] : [new Date().toISOString(), id]
    return this.db.prepare(sql).run(...args).changes ? this.get(id) : null
  }

  search(opts: SearchOptions = {}): SearchResult {
    const limit = clamp(opts.limit ?? 10, 1, 200)
    const offset = Math.max(0, opts.offset ?? 0)
    const where: string[] = []
    const params: SQLInputValue[] = []

    const statuses = opts.status ?? ['active']
    if (statuses.length) {
      where.push(`p.status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    const tags = normalizeTags(opts.tags)
    if (tags.length) {
      where.push(`EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value IN (${tags.map(() => '?').join(', ')}))`)
      params.push(...tags)
    }
    if (opts.project) {
      where.push('p.source_project = ?')
      params.push(opts.project)
    }

    const filters = { where: [...where], params: [...params] }
    const { fts, short } = parseQuery(opts.q ?? '')
    let from = 'pitfalls p'
    let score = 'NULL'
    // Helpful entries get a mild boost; bm25 is negative, so scaling it up ranks higher.
    let order = 'p.helpful_count DESC, p.updated_at DESC'
    if (fts) {
      from = 'pitfalls_fts JOIN pitfalls p ON p.seq = pitfalls_fts.rowid'
      where.unshift('pitfalls_fts MATCH ?')
      params.unshift(fts)
      score = `${BM25} * (1 + 0.1 * min(p.helpful_count, 10))`
      order = 'score ASC'
    } else if (short.length) {
      for (const term of short) {
        where.push(`(${LIKE_FIELDS.map((f) => `p.${f} LIKE ?`).join(' OR ')})`)
        params.push(...LIKE_FIELDS.map(() => `%${term}%`))
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT p.*, ${score} AS score FROM ${from} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as Row[]
    const { n } = this.db.prepare(`SELECT count(*) AS n FROM ${from} ${whereSql}`).get(...params) as { n: number }
    if (n === 0 && opts.q?.trim()) return this.fuzzySearch(opts.q, filters, limit, offset)
    return { items: rows.map(toHit), total: n }
  }

  /**
   * Fallback when the trigram index finds nothing, mostly for Chinese phrased differently from
   * the entry ("安装失败的模块" vs "模块安装报错"). Scores by the share of CJK bigrams / short
   * terms present; requires real overlap so it does not return noise.
   */
  private fuzzySearch(q: string, filters: { where: string[]; params: SQLInputValue[] }, limit: number, offset: number): SearchResult {
    const terms = fallbackTerms(q)
    if (!terms.length) return { items: [], total: 0 }
    const like = terms.map(() => `(${LIKE_FIELDS.map((f) => `p.${f} LIKE ?`).join(' OR ')})`).join(' OR ')
    const where = [...filters.where, `(${like})`]
    const rows = this.db
      .prepare(`SELECT p.* FROM pitfalls p WHERE ${where.join(' AND ')}`)
      .all(...filters.params, ...terms.flatMap((t) => LIKE_FIELDS.map(() => `%${t}%`))) as unknown as Row[]
    const minHits = terms.length === 1 ? 1 : 2
    const scored = rows
      .map((r) => {
        const hay = LIKE_FIELDS.map((f) => r[f as keyof Row]).join('\n').toLowerCase()
        const hits = terms.filter((t) => hay.includes(t)).length
        return { row: r, hits, ratio: hits / terms.length }
      })
      .filter((s) => s.hits >= minHits && s.ratio >= 1 / 3)
      .sort((a, b) => b.ratio - a.ratio || b.row.helpful_count - a.row.helpful_count)
    return {
      items: scored.slice(offset, offset + limit).map((s) => ({ ...toPitfall(s.row), score: -s.ratio })),
      total: scored.length,
    }
  }

  /**
   * Entries that are almost certainly the same pitfall: identical title or identical error
   * signature once paths and numbers are stripped. Used to stop agents from recording twice.
   */
  findDuplicates(input: Pick<PitfallInput, 'title' | 'errorSignature'>): Pitfall[] {
    const title = input.title.trim().toLowerCase()
    const sig = input.errorSignature ? normalizeSignature(input.errorSignature) : ''
    const rows = this.db
      .prepare("SELECT * FROM pitfalls WHERE status != 'archived' AND (lower(title) = ? OR error_signature != '')")
      .all(title) as unknown as Row[]
    return rows
      .filter((r) => r.title.trim().toLowerCase() === title || (sig && normalizeSignature(r.error_signature) === sig))
      .map(toPitfall)
  }

  withSignatures(): Pitfall[] {
    return (
      this.db.prepare("SELECT * FROM pitfalls WHERE status = 'active' AND error_signature != ''").all() as unknown as Row[]
    ).map(toPitfall)
  }

  /** Active entries sharing tags with the given project fingerprint, best matches first. */
  relevantForTags(tags: string[], limit = 8): { items: (Pitfall & { matchedTags: string[] })[]; total: number } {
    const wanted = normalizeTags(tags)
    if (!wanted.length) return { items: [], total: 0 }
    const placeholders = wanted.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT json_group_array(value) FROM json_each(p.tags) WHERE value IN (${placeholders})) AS matched
         FROM pitfalls p
         WHERE p.status = 'active' AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value IN (${placeholders}))
         ORDER BY json_array_length(matched) DESC,
                  CASE p.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                  p.helpful_count DESC, p.updated_at DESC`,
      )
      .all(...wanted, ...wanted) as unknown as (Row & { matched: string })[]
    return {
      items: rows.slice(0, limit).map((r) => ({ ...toPitfall(r), matchedTags: JSON.parse(r.matched) as string[] })),
      total: rows.length,
    }
  }

  tags(): { tag: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT j.value AS tag, count(*) AS count FROM pitfalls p, json_each(p.tags) j
         WHERE p.status != 'archived' GROUP BY j.value ORDER BY count DESC, tag ASC`,
      )
      .all() as unknown as { tag: string; count: number }[]
  }

  stats() {
    const byStatus = this.db.prepare('SELECT status, count(*) AS n FROM pitfalls GROUP BY status').all() as unknown as {
      status: string
      n: number
    }[]
    const totals = this.db
      .prepare('SELECT count(*) AS total, coalesce(sum(hit_count), 0) AS hits, coalesce(sum(helpful_count), 0) AS helpful FROM pitfalls')
      .get() as { total: number; hits: number; helpful: number }
    const projects = this.db
      .prepare(
        "SELECT source_project AS project, count(*) AS n FROM pitfalls WHERE source_project != '' GROUP BY source_project ORDER BY n DESC LIMIT 20",
      )
      .all() as unknown as { project: string; n: number }[]
    return { ...totals, byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s.n])), projects }
  }

  exportAll(): Pitfall[] {
    return (this.db.prepare('SELECT * FROM pitfalls ORDER BY seq').all() as unknown as Row[]).map(toPitfall)
  }

  /** Upserts by id, keeping whichever side was updated last. Entries without an id are created. */
  importMany(items: (PitfallInput & Partial<Pitfall>)[]): { created: number; updated: number; skipped: number } {
    const result = { created: 0, updated: 0, skipped: 0 }
    this.db.exec('BEGIN')
    try {
      for (const item of items) {
        const existing = item.id ? this.get(item.id) : null
        if (!existing) {
          const created = this.create(item)
          if (item.id) this.restoreMeta(created.id, item)
          result.created++
        } else if (item.updatedAt && item.updatedAt > existing.updatedAt) {
          this.update(existing.id, item)
          this.restoreMeta(existing.id, item)
          result.updated++
        } else {
          result.skipped++
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return result
  }

  private restoreMeta(currentId: string, item: Partial<Pitfall>) {
    this.db
      .prepare(
        `UPDATE pitfalls SET id = ?, hit_count = max(hit_count, ?), helpful_count = max(helpful_count, ?),
           created_at = coalesce(?, created_at), updated_at = coalesce(?, updated_at), last_hit_at = coalesce(?, last_hit_at)
         WHERE id = ?`,
      )
      .run(
        item.id ?? currentId,
        item.hitCount ?? 0,
        item.helpfulCount ?? 0,
        item.createdAt ?? null,
        item.updatedAt ?? null,
        item.lastHitAt ?? null,
        currentId,
      )
  }
}

function sanitize<T extends PitfallPatch>(input: T): T {
  const out = { ...input }
  for (const key of ['title', 'symptom', 'cause', 'solution', 'prevention', 'environment', 'errorSignature'] as const) {
    if (typeof out[key] === 'string') out[key] = out[key].trim()
  }
  if (out.tags) out.tags = normalizeTags(out.tags)
  if (out.severity && !SEVERITIES.includes(out.severity)) throw new Error(`invalid severity: ${out.severity}`)
  if (out.status && !STATUSES.includes(out.status)) throw new Error(`invalid status: ${out.status}`)
  if (out.title === '') throw new Error('title must not be empty')
  if (out.solution === '') throw new Error('solution must not be empty')
  return out
}

function toPitfall(r: Row): Pitfall {
  return {
    id: r.id,
    title: r.title,
    symptom: r.symptom,
    cause: r.cause,
    solution: r.solution,
    prevention: r.prevention,
    tags: JSON.parse(r.tags) as string[],
    environment: r.environment,
    errorSignature: r.error_signature,
    sourceProject: r.source_project,
    sourceAgent: r.source_agent,
    severity: r.severity,
    status: r.status,
    hitCount: r.hit_count,
    helpfulCount: r.helpful_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastHitAt: r.last_hit_at,
  }
}

function toHit(r: Row): SearchHit {
  return { ...toPitfall(r), score: r.score ?? null }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}
