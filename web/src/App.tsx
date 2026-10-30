import { useCallback, useDeferredValue, useEffect, useState } from 'react'
import { api, feedbackApi, setToken, UnauthorizedError, type Pitfall, type SearchResult, type Stats } from './api'
import { FeedbackPanel } from './FeedbackPanel'
import { PitfallEditor } from './PitfallEditor'
import { PitfallView } from './PitfallView'
import { TagPicker } from './TagPicker'

const STATUS_FILTERS = [
  { value: 'active', label: '有效' },
  { value: 'outdated', label: '已过时' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
]

const ITEM_TAGS = 3

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
    // Wide screens: the page itself never scrolls; list and detail scroll on their own.
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 md:px-6 lg:h-dvh">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line py-3">
        <div className="flex items-baseline gap-5">
          <h1 className="font-mono text-lg font-semibold tracking-tight" title="Agent 在各个项目里踩过、并已解决的坑">
            pitfall<span className="text-accent">/</span>hub
          </h1>
          <nav className="flex gap-4 text-sm">
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
            <dl className="hidden gap-4 font-mono text-xs text-muted sm:flex">
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
        <p className="mt-3 shrink-0 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent" onClick={() => setError('')}>
          {error}
        </p>
      )}

      {view === 'feedback' && (
        <div className="min-h-0 flex-1 py-4 lg:overflow-y-auto">
          <FeedbackPanel
            onOpenPitfall={(id) => {
              setView('pitfalls')
              setStatus('all')
              setPanel({ mode: 'view', id })
            }}
          />
        </div>
      )}

      <div className={`grid min-h-0 flex-1 gap-5 pt-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] ${view === 'pitfalls' ? '' : 'hidden'}`}>
        {/* Narrow screens show either the list or the open entry. */}
        <section className={`min-h-0 min-w-0 flex-col gap-2.5 pb-5 lg:flex ${panel ? 'hidden' : 'flex'}`}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题、报错、方案……中英文都可以"
            className="w-full shrink-0 rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
          <div className="flex shrink-0 flex-wrap items-center gap-1">
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
            <span className="ml-auto font-mono text-xs text-muted">{result.total} 条</span>
          </div>
          {allTags.length > 0 && <TagPicker tags={allTags} selected={tags} onToggle={toggleTag} onClear={() => setTags([])} />}

          <ul className="flex min-h-0 flex-col divide-y divide-line overflow-hidden rounded-md border border-line bg-surface lg:overflow-y-auto">
            {result.items.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setPanel({ mode: 'view', id: p.id })}
                  className={`block w-full px-3 py-2 text-left transition-colors duration-100 hover:bg-sunken ${
                    panel?.mode === 'view' && panel.id === p.id ? 'bg-sunken' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <SeverityDot severity={p.severity} />
                    <span className="line-clamp-2 text-sm font-medium" title={p.title}>
                      {p.title}
                    </span>
                  </div>
                  <div className="mt-0.5 flex gap-x-3 pl-4 font-mono text-xs whitespace-nowrap text-muted">
                    {p.tags.length > 0 && (
                      <span className="min-w-0 truncate">
                        {p.tags.slice(0, ITEM_TAGS).join(' · ')}
                        {p.tags.length > ITEM_TAGS && ` +${p.tags.length - ITEM_TAGS}`}
                      </span>
                    )}
                    {p.sourceProject && <span className="min-w-0 truncate">@{p.sourceProject}</span>}
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

        <section className={`min-h-0 min-w-0 pb-5 lg:block lg:overflow-y-auto ${panel ? '' : 'hidden'}`}>
          {panel && (
            <button onClick={() => setPanel(null)} className="mb-3 text-sm text-muted hover:text-ink lg:hidden">
              ← 返回列表
            </button>
          )}
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
    <div className="flex items-baseline gap-1.5">
      <dt>{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  )
}

export function SeverityDot({ severity }: { severity: Pitfall['severity'] }) {
  const color = severity === 'high' ? 'bg-accent' : severity === 'medium' ? 'bg-warn' : 'bg-muted'
  return <span title={severity} className={`mt-1.5 size-2 shrink-0 rounded-full ${color}`} />
}
