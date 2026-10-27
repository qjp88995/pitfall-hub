import { randomBytes } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  type Feedback,
  type FeedbackInput,
  type FeedbackKind,
  type FeedbackStatus,
} from './types.js'

export { FEEDBACK_KINDS, FEEDBACK_STATUSES, type Feedback, type FeedbackInput, type FeedbackKind, type FeedbackStatus }

interface Row {
  id: string
  kind: FeedbackKind
  title: string
  detail: string
  pitfall_id: string | null
  source_project: string
  source_agent: string
  status: FeedbackStatus
  votes: number
  resolution: string
  created_at: string
  updated_at: string
}

const UNRESOLVED = "status IN ('open', 'planned')"

export class FeedbackStore {
  constructor(readonly db: DatabaseSync) {}

  /**
   * Files a report, or adds a vote (and the new detail) to an unresolved report about the same
   * thing: same kind and pitfall for false positives, otherwise same normalized title.
   */
  report(input: FeedbackInput): { feedback: Feedback; duplicate: boolean } {
    if (!FEEDBACK_KINDS.includes(input.kind)) throw new Error(`invalid kind: ${input.kind}`)
    const title = input.title.trim()
    if (!title) throw new Error('title must not be empty')
    const now = new Date().toISOString()
    const detail = input.detail?.trim() ?? ''

    const existing = this.findSame(input.kind, title, input.pitfallId)
    if (existing) {
      const stamp = `**${now.slice(0, 10)}${input.sourceProject ? ` (${input.sourceProject})` : ''}**`
      const merged = detail ? `${existing.detail}${existing.detail ? '\n\n' : ''}${stamp}: ${detail}` : existing.detail
      this.db.prepare('UPDATE feedback SET votes = votes + 1, detail = ?, updated_at = ? WHERE id = ?').run(merged, now, existing.id)
      return { feedback: this.get(existing.id)!, duplicate: true }
    }

    const id = `fb_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    this.db
      .prepare(
        `INSERT INTO feedback (id, kind, title, detail, pitfall_id, source_project, source_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, title, detail, input.pitfallId ?? null, input.sourceProject ?? '', input.sourceAgent ?? '', now, now)
    return { feedback: this.get(id)!, duplicate: false }
  }

  get(id: string): Feedback | null {
    const row = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as Row | undefined
    return row ? toFeedback(row) : null
  }

  /** Most-reported first, so the list doubles as a priority order. */
  list(opts: { status?: FeedbackStatus[]; limit?: number } = {}): { items: Feedback[]; total: number } {
    const statuses = opts.status ?? ['open', 'planned']
    const where = statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(', ')})` : ''
    const params: SQLInputValue[] = [...statuses]
    const rows = this.db
      .prepare(`SELECT * FROM feedback ${where} ORDER BY votes DESC, updated_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 50) as unknown as Row[]
    const { n } = this.db.prepare(`SELECT count(*) AS n FROM feedback ${where}`).get(...params) as { n: number }
    return { items: rows.map(toFeedback), total: n }
  }

  resolve(id: string, status: FeedbackStatus, resolution?: string): Feedback | null {
    if (!FEEDBACK_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
    const { changes } = this.db
      .prepare('UPDATE feedback SET status = ?, resolution = coalesce(?, resolution), updated_at = ? WHERE id = ?')
      .run(status, resolution ?? null, new Date().toISOString(), id)
    return changes ? this.get(id) : null
  }

  private findSame(kind: FeedbackKind, title: string, pitfallId?: string): Row | undefined {
    if (kind === 'false_positive' && pitfallId) {
      return this.db
        .prepare(`SELECT * FROM feedback WHERE ${UNRESOLVED} AND kind = ? AND pitfall_id = ?`)
        .get(kind, pitfallId) as Row | undefined
    }
    const norm = normalizeTitle(title)
    const candidates = this.db.prepare(`SELECT * FROM feedback WHERE ${UNRESOLVED} AND kind = ?`).all(kind) as unknown as Row[]
    return candidates.find((r) => normalizeTitle(r.title) === norm)
  }
}

function normalizeTitle(s: string) {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

function toFeedback(r: Row): Feedback {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    pitfallId: r.pitfall_id,
    sourceProject: r.source_project,
    sourceAgent: r.source_agent,
    status: r.status,
    votes: r.votes,
    resolution: r.resolution,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
