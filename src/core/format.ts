import type { ErrorMatch } from './match.js'
import type { Pitfall, SearchResult } from './types.js'

// Plain text for agents: one line per entry in lists, full detail only on request.

export function oneLine(p: Pitfall, extra = ''): string {
  const flag = p.severity === 'high' ? ' [high]' : ''
  const stale = p.status !== 'active' ? ` [${p.status}]` : ''
  return `- ${p.id}${flag}${stale} ${p.title} — fix: ${snippet(p.solution, 140)}${p.tags.length ? ` (${p.tags.join(', ')})` : ''}${extra}`
}

export function formatSearch(r: SearchResult, query: string): string {
  if (!r.items.length) return `No pitfalls found for "${query}".`
  const head = `${r.total} pitfall(s) for "${query}"${r.total > r.items.length ? `, showing ${r.items.length}` : ''}. Use get_pitfall for details.`
  return [head, ...r.items.map((p) => oneLine(p))].join('\n')
}

export function formatFull(p: Pitfall): string {
  const section = (name: string, body: string) => (body ? `\n## ${name}\n${body}\n` : '')
  return [
    `# ${p.title}`,
    `id: ${p.id} | severity: ${p.severity} | status: ${p.status} | tags: ${p.tags.join(', ') || '-'}`,
    `env: ${p.environment || '-'} | from: ${p.sourceProject || '-'}${p.sourceAgent ? ` via ${p.sourceAgent}` : ''} | updated: ${p.updatedAt.slice(0, 10)} | used ${p.hitCount}x, helpful ${p.helpfulCount}x`,
    p.errorSignature ? `signature: ${p.errorSignature}` : '',
    section('Symptom', p.symptom),
    section('Cause', p.cause),
    section('Solution', p.solution),
    section('Prevention', p.prevention),
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatErrorMatches(matches: ErrorMatch[]): string {
  return [
    '[pitfall-hub] This failure matches known pitfall(s). Check before debugging from scratch:',
    ...matches.map((m) => oneLine(m.pitfall, m.reason === 'signature' ? ' ← same error signature' : ` ← matched: ${m.matched.join(', ')}`)),
    'Read with get_pitfall <id>. Afterwards call pitfall_feedback (helpful / outdated).',
  ].join('\n')
}

export function snippet(text: string, max: number): string {
  const line = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/\n/g, ' ')).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
