import { useState, type FormEvent, type ReactNode } from 'react'
import { api, type Pitfall, type PitfallInput } from './api'

interface Props {
  pitfall?: Pitfall
  onCancel: () => void
  onSaved: (p: Pitfall) => void
}

const TEXT_FIELDS = [
  { key: 'symptom', label: '现象', hint: '报错原文 / 观察到的行为', rows: 4, mono: true },
  { key: 'cause', label: '根因', rows: 3 },
  { key: 'solution', label: '解决方案 *', hint: 'Markdown，写清具体命令或配置', rows: 6 },
  { key: 'prevention', label: '如何避免', rows: 2 },
] as const

export function PitfallEditor({ pitfall, onCancel, onSaved }: Props) {
  const [form, setForm] = useState({
    title: pitfall?.title ?? '',
    symptom: pitfall?.symptom ?? '',
    cause: pitfall?.cause ?? '',
    solution: pitfall?.solution ?? '',
    prevention: pitfall?.prevention ?? '',
    tags: pitfall?.tags.join(', ') ?? '',
    environment: pitfall?.environment ?? '',
    errorSignature: pitfall?.errorSignature ?? '',
    severity: pitfall?.severity ?? 'medium',
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const input: PitfallInput = { ...form, tags: form.tags.split(/[,，\s]+/).filter(Boolean) }
    try {
      onSaved(pitfall ? await api.update(pitfall.id, input) : await api.create(input))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const field = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent'

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <h2 className="font-mono text-xs uppercase tracking-wider text-muted">{pitfall ? `编辑 ${pitfall.id}` : '新建条目'}</h2>
      <Label text="标题 *">
        <input required value={form.title} onChange={set('title')} className={field} placeholder="一句话描述这个坑，便于检索" />
      </Label>
      {TEXT_FIELDS.map((f) => (
        <Label key={f.key} text={f.label} hint={'hint' in f ? f.hint : undefined}>
          <textarea
            required={f.key === 'solution'}
            rows={f.rows}
            value={form[f.key]}
            onChange={set(f.key)}
            className={`${field} ${'mono' in f ? 'font-mono text-xs' : ''}`}
          />
        </Label>
      ))}
      <Label text="错误签名" hint="最有辨识度的一行报错，用于自动匹配">
        <input value={form.errorSignature} onChange={set('errorSignature')} className={`${field} font-mono text-xs`} />
      </Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="标签" hint="包名 + 生态/平台，逗号分隔">
          <input value={form.tags} onChange={set('tags')} className={`${field} font-mono text-xs`} placeholder="next, pnpm, wsl" />
        </Label>
        <Label text="环境">
          <input value={form.environment} onChange={set('environment')} className={field} placeholder="next@15, node 22, WSL2" />
        </Label>
      </div>
      <Label text="严重程度">
        <select value={form.severity} onChange={set('severity')} className={field}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high — 耗时很久或会静默出错</option>
        </select>
      </Label>
      {error && <p className="text-sm text-accent">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button disabled={saving} className="rounded-md bg-ink px-4 py-1.5 text-sm text-bg hover:opacity-85 disabled:opacity-50">
          保存
        </button>
        <button type="button" onClick={onCancel} className="rounded-md px-4 py-1.5 text-sm text-muted hover:bg-sunken">
          取消
        </button>
      </div>
    </form>
  )
}

function Label({ text, hint, children }: { text: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">
        {text}
        {hint && <span className="ml-2 font-normal text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
