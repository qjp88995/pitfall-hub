import { useCallback, useDeferredValue, useEffect, useState } from 'react'
import { api, feedbackApi, setToken, UnauthorizedError, type Pitfall, type SearchResult, type Stats } from './api'
import { FeedbackPanel } from './FeedbackPanel'
import { PitfallEditor } from './PitfallEditor'
import { PitfallView } from './PitfallView'

const STATUS_FILTERS = [
  { value: 'active', label: '有效' },
  { value: 'outdated', label: '已过时' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
]

type Panel = { mode: 'view'; id: string } | { mode: 'edit'; pitfall: Pitfall } | { mode: 'create' } | null

export function App() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('active')
  const [tags, setTags] = useState<string[]>([])
  const [result, setResult] = useState<SearchResult>({ items: [], total: 0 })
  const [allTags, setAllTags] = useState<{ tag: string; count: number }[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [error, setError] = useState('')
  const [locked, setLocked] = useState(false)
  const [authVersion, setAuthVersion] = useState(0)
  const [view, setView] = useState<'pitfalls' | 'feedback'>('pitfalls')
  const [openFeedback, setOpenFeedback] = useState(0)
  const deferredQ = useDeferredValue(q)

  const refresh = useCallback(() => {
    const onError = (e: Error) => (e instanceof UnauthorizedError ? setLocked(true) : setError(e.message))
    api.search({ q: deferredQ, tags, status }).then(setResult, onError)
    api.tags().then(setAllTags, () => {})
    api.stats().then(setStats, () => {})
    feedbackApi.list('open,planned').then((r) => setOpenFeedback(r.total), () => {})
  }, [deferredQ, tags, status, authVersion])

  useEffect(refresh, [refresh])

  if (locked) {
    return (
      <TokenGate
        onSubmit={(token) => {
          setToken(token)
          setLocked(false)
          setAuthVersion((v) => v + 1)
        }}
      />
    )
  }

  const selected = panel?.mode === 'view' ? result.items.find((p) => p.id === panel.id) : undefined
  const toggleTag = (tag: string) => setTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : [...t, tag]))

  const onSaved = (p: Pitfall) => {
    setPanel({ mode: 'view', id: p.id })
    refresh()
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-5 md:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div>
          <h1 className="font-mono text-lg font-semibold tracking-tight">
            pitfall<span className="text-accent">/</span>hub
          </h1>
          <p className="text-sm text-muted">Agent 在各个项目里踩过、并已解决的坑</p>
          <nav className="mt-3 flex gap-4 text-sm">
            {(
              [
                ['pitfalls', '坑'],
                ['feedback', `平台反馈${openFeedback ? ` ${openFeedback}` : ''}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`border-b-2 pb-0.5 ${view === key ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-5">
          {stats && (
            <dl className="flex gap-5 font-mono text-xs text-muted">
              <Stat label="条目" value={stats.total} />
              <Stat label="被检索" value={stats.hits} />
              <Stat label="有用" value={stats.helpful} />
              <Stat label="来源项目" value={stats.projects.length} />
            </dl>
          )}
          <button
            onClick={() => setPanel({ mode: 'create' })}
            className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-bg transition-opacity duration-150 hover:opacity-85"
          >
            新建
          </button>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent" onClick={() => setError('')}>
          {error}
        </p>
      )}

      {view === 'feedback' && (
        <FeedbackPanel
          onOpenPitfall={(id) => {
            setView('pitfalls')
            setStatus('all')
            setPanel({ mode: 'view', id })
          }}
        />
      )}

      <div className={`grid flex-1 gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] ${view === 'pitfalls' ? '' : 'hidden'}`}>
        <section className="flex min-w-0 flex-col gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题、报错、方案……中英文都可以"
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.value}
                onClick={() => setStatus(s.value)}
                className={`rounded px-2 py-1 text-xs ${status === s.value ? 'bg-ink text-bg' : 'text-muted hover:bg-sunken'}`}
              >
                {s.label}
                {s.value !== 'all' && stats?.byStatus[s.value] ? ` ${stats.byStatus[s.value]}` : ''}
              </button>
            ))}
          </div>
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {allTags.slice(0, 40).map((t) => (
                <button
                  key={t.tag}
                  onClick={() => toggleTag(t.tag)}
                  className={`rounded border px-1.5 py-0.5 font-mono text-xs transition-colors duration-100 ${
                    tags.includes(t.tag) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-muted'
                  }`}
                >
                  {t.tag}
                  <span className="ml-1 opacity-60">{t.count}</span>
                </button>
              ))}
            </div>
          )}

          <p className="font-mono text-xs text-muted">{result.total} 条</p>
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
            {result.items.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setPanel({ mode: 'view', id: p.id })}
                  className={`block w-full px-3 py-2.5 text-left transition-colors duration-100 hover:bg-sunken ${
                    panel?.mode === 'view' && panel.id === p.id ? 'bg-sunken' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <SeverityDot severity={p.severity} />
                    <span className="text-sm font-medium">{p.title}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-4 font-mono text-xs text-muted">
                    {p.tags.length > 0 && <span>{p.tags.join(' · ')}</span>}
                    {p.sourceProject && <span>@{p.sourceProject}</span>}
                    {p.hitCount > 0 && <span>↺{p.hitCount}</span>}
                    {p.helpfulCount > 0 && <span className="text-ok">✓{p.helpfulCount}</span>}
                    {p.status !== 'active' && <span className="text-warn">{p.status}</span>}
                  </div>
                </button>
              </li>
            ))}
            {!result.items.length && <li className="px-3 py-8 text-center text-sm text-muted">没有匹配的条目</li>}
          </ul>
        </section>

        <section className="min-w-0">
          {panel?.mode === 'create' && <PitfallEditor onCancel={() => setPanel(null)} onSaved={onSaved} />}
          {panel?.mode === 'edit' && (
            <PitfallEditor pitfall={panel.pitfall} onCancel={() => setPanel({ mode: 'view', id: panel.pitfall.id })} onSaved={onSaved} />
          )}
          {panel?.mode === 'view' && selected && (
            <PitfallView
              pitfall={selected}
              onEdit={() => setPanel({ mode: 'edit', pitfall: selected })}
              onChanged={refresh}
              onDeleted={() => {
                setPanel(null)
                refresh()
              }}
            />
          )}
          {(!panel || (panel.mode === 'view' && !selected)) && (
            <div className="hidden h-full min-h-60 items-center justify-center rounded-md border border-dashed border-line text-sm text-muted lg:flex">
              选择左侧条目查看详情
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setValue] = useState('')
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(token.trim())
        }}
        className="flex w-full max-w-sm flex-col gap-3 rounded-md border border-line bg-surface p-6"
      >
        <h1 className="font-mono text-lg font-semibold">
          pitfall<span className="text-accent">/</span>hub
        </h1>
        <p className="text-sm text-muted">输入访问令牌（服务端的 PITFALL_HUB_TOKEN），仅保存在本浏览器。</p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
        <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-bg hover:opacity-85">进入</button>
      </form>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <dt>{label}</dt>
      <dd className="text-base text-ink">{value}</dd>
    </div>
  )
}

export function SeverityDot({ severity }: { severity: Pitfall['severity'] }) {
  const color = severity === 'high' ? 'bg-accent' : severity === 'medium' ? 'bg-warn' : 'bg-muted'
  return <span title={severity} className={`mt-1.5 size-2 shrink-0 rounded-full ${color}`} />
}
