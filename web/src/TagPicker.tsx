import { useEffect, useRef, useState } from 'react'

interface Props {
  tags: { tag: string; count: number }[]
  selected: string[]
  onToggle: (tag: string) => void
  onClear: () => void
}

/**
 * Tag filter that stays one line tall however many tags exist: selected tags and the most used
 * ones sit inline (overflow is cut), the full list lives in a searchable popover.
 */
export function TagPicker({ tags, selected, onToggle, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => root.current?.contains(e.target as Node) || setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const f = filter.trim().toLowerCase()
  const matching = f ? tags.filter((t) => t.tag.includes(f)) : tags
  const suggestions = tags.filter((t) => !selected.includes(t.tag))

  return (
    <div ref={root} className="relative flex shrink-0 items-center gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`shrink-0 rounded border px-2 py-0.5 text-xs ${open ? 'border-muted text-ink' : 'border-line text-muted hover:border-muted hover:text-ink'}`}
      >
        标签{selected.length > 0 && ` ${selected.length}`} ▾
      </button>
      {/* One line only: whatever does not fit is cut off, the popover has the rest. */}
      <div className="flex min-w-0 flex-1 gap-1 overflow-hidden whitespace-nowrap">
        {selected.map((tag) => (
          <button
            key={tag}
            onClick={() => onToggle(tag)}
            className="shrink-0 rounded border border-accent bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent"
            title="取消筛选"
          >
            {tag} ×
          </button>
        ))}
        {suggestions.map((t) => (
          <button
            key={t.tag}
            onClick={() => onToggle(t.tag)}
            className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-xs text-muted transition-colors duration-100 hover:border-muted"
          >
            {t.tag}
            <span className="ml-1 opacity-60">{t.count}</span>
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <button onClick={onClear} className="shrink-0 px-1 text-xs text-muted hover:text-ink">
          清除
        </button>
      )}

      {open && (
        <div className="absolute top-full left-0 z-10 mt-1 flex w-72 max-w-full flex-col rounded-md border border-line bg-surface shadow-lg">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`筛选 ${tags.length} 个标签`}
            className="border-b border-line bg-transparent px-3 py-2 font-mono text-xs outline-none placeholder:text-muted"
          />
          <ul className="max-h-72 overflow-y-auto py-1">
            {matching.map((t) => {
              const on = selected.includes(t.tag)
              return (
                <li key={t.tag}>
                  <button
                    onClick={() => onToggle(t.tag)}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-sunken ${on ? 'text-accent' : 'text-ink'}`}
                  >
                    <span className="w-3 shrink-0">{on ? '✓' : ''}</span>
                    <span className="min-w-0 flex-1 truncate">{t.tag}</span>
                    <span className="text-muted">{t.count}</span>
                  </button>
                </li>
              )
            })}
            {!matching.length && <li className="px-3 py-2 text-xs text-muted">没有匹配的标签</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
