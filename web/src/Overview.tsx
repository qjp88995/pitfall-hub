import { useEffect, useState, type ReactNode } from 'react'
import { KIND_LABEL } from './FeedbackPanel'
import { api, feedbackApi, type EvalRun, type Feedback, type Overview as OverviewData, type ReviewItem, type UsageReport } from './api'

const USAGE_DAYS = 30
const CREATED_DAYS = 30
const TOP_TAGS = 12

interface Props {
  onOpenPitfall: (id: string) => void
  onPickTag: (tag: string) => void
  onOpenFeedback: () => void
}

/** Is the knowledge base any use: how entries are found and used, what it holds, what needs attention. */
export function Overview({ onOpenPitfall, onPickTag, onOpenFeedback }: Props) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [review, setReview] = useState<{ items: ReviewItem[]; total: number } | null>(null)
  const [feedback, setFeedback] = useState<{ items: Feedback[]; total: number } | null>(null)

  useEffect(() => {
    api.overview().then(setData, () => {})
    api.usage(USAGE_DAYS).then(setUsage, () => {})
    api.evalRuns().then(setRuns, () => {})
    api.review(8).then(setReview, () => {})
    feedbackApi.list('open,planned').then(setFeedback, () => {})
  }, [])

  if (!data) return <p className="py-8 text-center text-sm text-muted">加载中…</p>

  return (
    <div className="flex flex-col gap-5 pb-8">
      <Lifecycle active={data.active} />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3" title={`使用效果 · 近 ${USAGE_DAYS} 天`} note={usage?.since ? `记录自 ${usage.since.slice(0, 10)}` : undefined}>
          <UsagePanel usage={usage} />
        </Card>
        <Card className="lg:col-span-2" title="搜索质量" note={runs[0] ? `评测于 ${runs[0].at.slice(0, 10)}` : undefined}>
          <EvalPanel runs={runs} onOpenPitfall={onOpenPitfall} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="来源项目" note={`${data.projects.length} 个`}>
          <BarList rows={data.projects.map((p) => ({ key: p.project, label: p.project, value: p.n }))} />
        </Card>
        <Card title="标签" note={`前 ${Math.min(TOP_TAGS, data.tags.length)} / ${data.tags.length}，点击筛选`}>
          <BarList rows={data.tags.slice(0, TOP_TAGS).map((t) => ({ key: t.tag, label: t.tag, value: t.count, onClick: () => onPickTag(t.tag) }))} mono />
        </Card>
        <Card title={`每日新增 · 近 ${CREATED_DAYS} 天`} note={`共 ${data.createdAt.length} 条`}>
          <DailyColumns createdAt={data.createdAt} days={CREATED_DAYS} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="待复核" note={review ? `${review.total} 条` : undefined}>
          {review?.items.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {review.items.map((r) => (
                <li key={r.pitfall.id}>
                  <button onClick={() => onOpenPitfall(r.pitfall.id)} className="block w-full py-2 text-left hover:bg-sunken">
                    <span className="line-clamp-1 text-sm">{r.pitfall.title}</span>
                    <span className="font-mono text-xs text-muted">{r.reasons.join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>没有需要复核的条目</Empty>
          )}
        </Card>
        <Card title="平台反馈" note={feedback ? `${feedback.total} 条待处理` : undefined}>
          {feedback?.items.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {feedback.items.slice(0, 8).map((f) => (
                <li key={f.id}>
                  <button onClick={onOpenFeedback} className="block w-full py-2 text-left hover:bg-sunken">
                    <span className="line-clamp-1 text-sm">{f.title}</span>
                    <span className="font-mono text-xs text-muted">
                      {KIND_LABEL[f.kind]} · ×{f.votes}
                      {f.sourceProject && ` · @${f.sourceProject}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>没有待处理的反馈</Empty>
          )}
        </Card>
      </div>
    </div>
  )
}

function Card({ title, note, className = '', children }: { title: string; note?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface p-4 ${className}`}>
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <span className="font-mono text-xs text-muted">{note}</span>}
      </header>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted">{children}</p>
}

function Tile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {sub && <span className="font-mono text-xs text-muted">{sub}</span>}
    </div>
  )
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–')

/** Active entries by how far they got: never opened → opened → marked helpful. One ordered whole, one hue in steps. */
function Lifecycle({ active }: { active: OverviewData['active'] }) {
  const parts = [
    { key: 'helpful', label: '标记有用', n: active.helpful, className: 'bg-ink' },
    { key: 'opened', label: '打开过、未标记', n: active.openedOnly, className: 'bg-ink/45' },
    { key: 'never', label: '从未打开', n: active.neverOpened, className: 'bg-ink/12' },
  ]
  return (
    <section className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Tile label="有效条目" value={active.total} />
        <Tile label="从未打开" value={active.neverOpened} sub={pct(active.neverOpened, active.total)} />
        <Tile label="打开过" value={active.openedOnly + active.helpful} sub={pct(active.openedOnly + active.helpful, active.total)} />
        <Tile label="标记有用" value={active.helpful} sub={pct(active.helpful, active.total)} />
        <Tile label="带报错签名" value={active.withSignature} sub={`${pct(active.withSignature, active.total)} 可自动匹配`} />
      </div>
      <div className="flex h-2.5 w-full gap-0.5" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join('，')}>
        {parts
          .filter((p) => p.n > 0)
          .map((p, i, shown) => (
            <div
              key={p.key}
              title={`${p.label} ${p.n}`}
              className={`${p.className} ${i === 0 ? 'rounded-l' : ''} ${i === shown.length - 1 ? 'rounded-r' : ''}`}
              style={{ flexGrow: p.n }}
            />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-sm ${p.className}`} />
            {p.label} <span className="font-mono text-ink">{p.n}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function UsagePanel({ usage }: { usage: UsageReport | null }) {
  if (!usage) return <Empty>加载中…</Empty>
  if (!usage.since) return <Empty>使用日志从 2026-11-11 起记录，还没有事件。</Empty>
  const c = usage.counts
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
        <Tile label="检索" value={usage.searches.total} />
        <Tile label="无结果" value={usage.searches.empty} sub={pct(usage.searches.empty, usage.searches.total)} />
        <Tile label="检索后打开" value={usage.searches.followedByOpen} sub={pct(usage.searches.followedByOpen, usage.searches.total)} />
        <Tile label="报错推送" value={usage.matches.total} sub={usage.matches.total ? `${pct(usage.matches.followedByOpen, usage.matches.total)} 被打开` : undefined} />
        <Tile label="标记有用" value={c.helpful ?? 0} />
        <Tile label="标记无关" value={c.irrelevant ?? 0} />
      </div>
      <QueryList title="没搜到的检索（可能是漏检）" rows={usage.recentEmpty} />
      <QueryList title="有结果但没打开（可能是噪声）" rows={usage.recentUnopened} />
    </div>
  )
}

function QueryList({ title, rows }: { title: string; rows: { at: string; query: string; project: string; total?: number }[] }) {
  if (!rows.length) return null
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs text-muted">{title}</h3>
      <ul className="flex flex-col gap-0.5 font-mono text-xs">
        {rows.slice(0, 6).map((r) => (
          <li key={`${r.at}${r.query}`} className="flex gap-3">
            <span className="shrink-0 text-muted">{r.at.slice(5, 10)}</span>
            <span className="min-w-0 flex-1 truncate" title={r.query}>
              {r.query}
            </span>
            {r.project && <span className="shrink-0 text-muted">@{r.project}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function EvalPanel({ runs, onOpenPitfall }: { runs: EvalRun[]; onOpenPitfall: (id: string) => void }) {
  const r = runs[0]
  if (!r) return <Empty>还没有评测记录（pitfall eval-search）</Empty>
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-4">
        <Tile label="首位命中" value={r.recallAt1.toFixed(2)} sub={`${r.answerable} 个检索`} />
        <Tile label="前 5 命中" value={r.recallAt5.toFixed(2)} sub={`MRR ${r.mrr.toFixed(2)}`} />
        <Tile label="无关问题有结果" value={`${r.noisy}/${r.unanswerable}`} sub="越少越好" />
      </div>
      {runs.length > 1 && (
        <table className="w-full font-mono text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-0.5 text-left font-normal">日期</th>
              <th className="py-0.5 text-right font-normal">首位</th>
              <th className="py-0.5 text-right font-normal">前 5</th>
              <th className="py-0.5 text-right font-normal">噪声</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 5).map((x) => (
              <tr key={x.at}>
                <td className="py-0.5">{x.at.slice(0, 10)}</td>
                <td className="py-0.5 text-right">{x.recallAt1.toFixed(2)}</td>
                <td className="py-0.5 text-right">{x.recallAt5.toFixed(2)}</td>
                <td className="py-0.5 text-right">
                  {x.noisy}/{x.unanswerable}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.misses.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-muted">没排进前 5 的检索</h3>
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {r.misses.slice(0, 5).map((m) => (
              <li key={m.query} className="flex gap-3">
                <span className="min-w-0 flex-1 truncate" title={m.query}>
                  {m.query}
                </span>
                <button onClick={() => onOpenPitfall(m.expect)} className="shrink-0 text-accent underline">
                  {m.expect}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Ranked horizontal bars, value at the tip. */
function BarList({ rows, mono = false }: { rows: { key: string; label: string; value: number; onClick?: () => void }[]; mono?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const body = (
          <>
            <span className={`w-28 shrink-0 truncate text-left text-xs ${mono ? 'font-mono' : ''}`} title={r.label}>
              {r.label}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="h-3 rounded-r bg-ink/70" style={{ width: `${(r.value / max) * 100}%` }} />
              <span className="font-mono text-xs text-muted tabular-nums">{r.value}</span>
            </span>
          </>
        )
        return (
          <li key={r.key}>
            {r.onClick ? (
              <button onClick={r.onClick} className="flex w-full items-center gap-2 rounded hover:bg-sunken">
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-2">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Entries added per day, in the viewer's time zone. Hovering a day shows its count in the header line. */
function DailyColumns({ createdAt, days }: { createdAt: string[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const counts = new Map<string, number>()
  for (const at of createdAt) {
    const day = localDay(new Date(at))
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const today = new Date()
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i))
    const day = localDay(d)
    return { day, n: counts.get(day) ?? 0 }
  })
  const max = Math.max(1, ...series.map((s) => s.n))
  const total = series.reduce((a, s) => a + s.n, 0)
  const shown = hover === null ? null : series[hover]
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs text-muted">
        {shown ? (
          <>
            {shown.day.slice(5)} · <span className="text-ink">{shown.n}</span> 条
          </>
        ) : (
          <>
            近 {days} 天 <span className="text-ink">{total}</span> 条 · 单日最多 <span className="text-ink">{max}</span>
          </>
        )}
      </p>
      <div className="flex h-36 items-end gap-0.5 border-b border-line" onMouseLeave={() => setHover(null)} role="img" aria-label={`近 ${days} 天每日新增条目`}>
        {series.map((s, i) => (
          <div key={s.day} className="flex h-full min-w-0 flex-1 items-end justify-center" onMouseEnter={() => setHover(i)}>
            <div
              className={`w-full max-w-6 rounded-t ${hover === i ? 'bg-accent' : 'bg-ink/70'}`}
              style={{ height: s.n ? `${Math.max((s.n / max) * 100, 2)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-xs text-muted">
        <span>{series[0]!.day.slice(5)}</span>
        <span>今天</span>
      </div>
    </div>
  )
}
