import Markdown from 'react-markdown'
import { api, type Pitfall } from './api'
import { SeverityDot } from './App'

interface Props {
  pitfall: Pitfall
  onEdit: () => void
  onChanged: () => void
  onDeleted: () => void
}

const SECTIONS = [
  ['symptom', '现象'],
  ['cause', '根因'],
  ['solution', '解决方案'],
  ['prevention', '如何避免'],
] as const

export function PitfallView({ pitfall: p, onEdit, onChanged, onDeleted }: Props) {
  const setStatus = async (status: Pitfall['status']) => {
    await api.update(p.id, { status })
    onChanged()
  }
  const remove = async () => {
    if (!confirm(`删除「${p.title}」？此操作不可撤销，通常改为归档即可。`)) return
    await api.remove(p.id)
    onDeleted()
  }

  return (
    <article className="rounded-md border border-line bg-surface">
      <header className="border-b border-line px-5 py-4">
        <div className="flex items-start gap-2">
          <SeverityDot severity={p.severity} />
          <h2 className="text-base font-semibold leading-snug">{p.title}</h2>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs text-muted">
          <dt>id</dt>
          <dd className="select-all text-ink">{p.id}</dd>
          {p.tags.length > 0 && (
            <>
              <dt>tags</dt>
              <dd>{p.tags.join(', ')}</dd>
            </>
          )}
          {p.environment && (
            <>
              <dt>env</dt>
              <dd>{p.environment}</dd>
            </>
          )}
          {p.errorSignature && (
            <>
              <dt>signature</dt>
              <dd className="break-all text-ink">{p.errorSignature}</dd>
            </>
          )}
          <dt>source</dt>
          <dd>
            {p.sourceProject || '-'}
            {p.sourceAgent && ` via ${p.sourceAgent}`} · {p.createdAt.slice(0, 10)}
            {p.updatedAt !== p.createdAt && ` · 更新 ${p.updatedAt.slice(0, 10)}`}
          </dd>
          <dt>usage</dt>
          <dd>
            检索 {p.hitCount} 次 · 有用 {p.helpfulCount} 次{p.lastHitAt && ` · 最近 ${p.lastHitAt.slice(0, 10)}`}
          </dd>
        </dl>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        {SECTIONS.map(([key, label]) =>
          p[key] ? (
            <section key={key}>
              <h3 className="mb-1 font-mono text-xs uppercase tracking-wider text-muted">{label}</h3>
              <div className="prose-pitfall">
                <Markdown>{p[key]}</Markdown>
              </div>
            </section>
          ) : null,
        )}
      </div>

      {/* Stays in view while a long entry scrolls. */}
      <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-b-md border-t border-line bg-surface px-5 py-3 text-sm">
        <button onClick={onEdit} className="rounded-md bg-ink px-3 py-1 text-bg hover:opacity-85">
          编辑
        </button>
        {p.status === 'active' ? (
          <button onClick={() => setStatus('outdated')} className="rounded-md px-3 py-1 text-muted hover:bg-sunken">
            标记过时
          </button>
        ) : (
          <button onClick={() => setStatus('active')} className="rounded-md px-3 py-1 text-muted hover:bg-sunken">
            恢复有效
          </button>
        )}
        {p.status !== 'archived' && (
          <button onClick={() => setStatus('archived')} className="rounded-md px-3 py-1 text-muted hover:bg-sunken">
            归档
          </button>
        )}
        <button onClick={remove} className="ml-auto rounded-md px-3 py-1 text-accent hover:bg-accent-soft">
          删除
        </button>
      </footer>
    </article>
  )
}
