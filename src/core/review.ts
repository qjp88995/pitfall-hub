import type { PitfallStore } from './store.js'
import type { Pitfall, ReviewItem } from './types.js'

export type { ReviewItem }

// The review queue: active entries with evidence that they may be wrong, misleading or dead
// weight. Age alone is never a reason (an unhit entry is not a wrong one); every rule needs
// either usage or silence over a long stretch, and only evidence newer than the entry's last
// review counts, so a reviewed entry leaves the queue until something new happens.

/** Unresolved "irrelevant" votes against the entry since its last review. */
export const REVIEW_FALSE_POSITIVES = 2
/** Never opened nor marked helpful for this long since it was recorded / last reviewed. */
export const REVIEW_SILENT_DAYS = 90
/** Opened this often since the last review, never marked helpful. */
export const REVIEW_OPENED_UNHELPFUL = 5

export const REVIEW_VERDICTS = ['keep', 'outdated', 'archived'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]


const DAY = 86_400_000

export function reviewQueue(store: PitfallStore, opts: { limit?: number; now?: number } = {}): { items: ReviewItem[]; total: number } {
  const now = opts.now ?? Date.now()
  const silentBefore = new Date(now - REVIEW_SILENT_DAYS * DAY).toISOString()
  // The false-positive count is computed in SQL; the rest is cheap to check per entry.
  const rows = store.db
    .prepare(
      `SELECT p.id,
         (SELECT coalesce(sum(f.votes), 0) FROM feedback f
          WHERE f.pitfall_id = p.id AND f.kind = 'false_positive' AND f.status IN ('open', 'planned')
            AND (p.reviewed_at IS NULL OR f.updated_at >= p.reviewed_at)) AS fp
       FROM pitfalls p WHERE p.status = 'active'`,
    )
    .all() as { id: string; fp: number }[]

  const items: ReviewItem[] = []
  for (const { id, fp } of rows) {
    const p = store.get(id)!
    const opened = p.hitCount - p.reviewedHits
    const since = p.reviewedAt ?? p.createdAt
    const reasons: string[] = []
    if (fp >= REVIEW_FALSE_POSITIVES) reasons.push(`reported irrelevant ${fp}x`)
    if (opened >= REVIEW_OPENED_UNHELPFUL && p.helpfulCount === 0) reasons.push(`opened ${opened}x, never marked helpful`)
    if (opened === 0 && p.helpfulCount === 0 && since < silentBefore) {
      reasons.push(`never opened in ${Math.floor((now - Date.parse(since)) / DAY)} days`)
    }
    if (reasons.length) items.push({ pitfall: p, reasons })
  }
  // Wrong matches hurt other sessions now; silence costs nothing until someone hits it.
  const weight = (r: ReviewItem) => (r.reasons.some((x) => x.startsWith('reported')) ? 0 : r.reasons.some((x) => x.startsWith('opened')) ? 1 : 2)
  items.sort((a, b) => weight(a) - weight(b) || a.pitfall.updatedAt.localeCompare(b.pitfall.updatedAt))
  return { items: items.slice(0, opts.limit ?? 20), total: items.length }
}

/**
 * Records a review. keep: the entry stays as is (after any update_pitfall edits). outdated /
 * archived: it stops being surfaced. Either way its open false-positive reports are closed with
 * the note, since they were what the review answered.
 */
export function reviewPitfall(store: PitfallStore, id: string, verdict: ReviewVerdict, note = ''): Pitfall | null {
  const p = store.get(id)
  if (!p) return null
  if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`invalid verdict: ${verdict}`)
  const now = new Date().toISOString()
  note = note.trim()
  if (verdict !== 'keep') {
    store.update(id, {
      status: verdict,
      ...(note && { solution: `${p.solution}\n\n**${now.slice(0, 10)} reviewed, ${verdict}**: ${note}` }),
    })
  }
  store.db.prepare('UPDATE pitfalls SET reviewed_at = ?, reviewed_hits = hit_count WHERE id = ?').run(now, id)
  store.db
    .prepare(
      `UPDATE feedback SET status = 'done', resolution = ?, updated_at = ?
       WHERE pitfall_id = ? AND kind = 'false_positive' AND status IN ('open', 'planned')`,
    )
    .run(`Entry reviewed (${verdict})${note ? `: ${note}` : ''}`, now, id)
  return store.get(id)
}
