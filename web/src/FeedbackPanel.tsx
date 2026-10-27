import { useCallback, useEffect, useState } from 'react'
import { feedbackApi, type Feedback, type FeedbackStatus } from './api'

const KIND_LABEL: Record<Feedback['kind'], string> = {
  false_positive: '误报',
  missed: '漏检',
  bug: '缺陷',
  idea: '改进',
}

const STATUS_FILTERS = [
  { value: 'open,planned', label: '待处理' },
  { value: 'done,wontfix', label: '已关闭' },
  { value: 'all', label: '全部' },
]

const STATUS_LABEL: Record<FeedbackStatus, string> = { open: '待处理', planned: '已排期', done: '已完成', wontfix: '不处理' }

export function FeedbackPanel({ onOpenPitfall }: { onOpenPitfall: (id: string) => void }) {
  const [filter, setFilter] = useState('open,planned')
  const [data, setData] = useState<{ items: Feedback[]; total: number }>({ items: [], total: 0 })

  const refresh = useCallback(() => {
    feedbackApi.list(filter).then(setData, () => {})
  }, [filter])
  useEffect(refresh, [refresh])

  const resolve = async (f: Feedback, status: FeedbackStatus) => {
    const resolution = status === 'done' || status === 'wontfix' ? (prompt('处理说明（可选，如 commit hash）') ?? undefined) : undefined
    await feedbackApi.resolve(f.id, status, resolution)
    refresh()
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted">Agent 在其他项目中使用本平台时上报的问题，按上报次数排序。</p>
      <div className="flex gap-1">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s.value}
            onClick={() => setFilter(s.value)}
            className={`rounded px-2 py-1 text-xs ${filter === s.value ? 'bg-ink text-bg' : 'text-muted hover:bg-sunken'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
        {data.items.map((f) => (
          <li key={f.id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-start gap-2">
              <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent">{KIND_LABEL[f.kind]}</span>
              <span className="min-w-0 flex-1 text-sm font-medium">{f.title}</span>
              <span className="font-mono text-xs text-muted" title="上报次数">
                ×{f.votes}
              </span>
            </div>
            {f.detail && <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">{f.detail}</p>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted">
              <span>{f.id}</span>
              {f.sourceProject && <span>@{f.sourceProject}</span>}
              <span>{f.updatedAt.slice(0, 10)}</span>
              {f.pitfallId && (
                <button onClick={() => onOpenPitfall(f.pitfallId!)} className="text-accent underline">
                  {f.pitfallId}
                </button>
              )}
              {f.resolution && <span className="text-ok">→ {f.resolution}</span>}
              <select
                value={f.status}
                onChange={(e) => resolve(f, e.target.value as FeedbackStatus)}
                className="ml-auto rounded border border-line bg-bg px-1.5 py-0.5 text-xs"
              >
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
        {!data.items.length && <li className="px-3 py-8 text-center text-sm text-muted">没有反馈</li>}
      </ul>
    </section>
  )
}
