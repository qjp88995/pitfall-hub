import type { Pitfall, PitfallInput, PitfallPatch, SearchResult } from '../../src/core/types.ts'

export type { Pitfall, PitfallInput, PitfallPatch, SearchResult }

export interface Stats {
  total: number
  hits: number
  helpful: number
  byStatus: Record<string, number>
  projects: { project: string; n: number }[]
}

const TOKEN_KEY = 'pitfall-hub-token'

export class UnauthorizedError extends Error {}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
  })
  if (res.status === 401) throw new UnauthorizedError('unauthorized')
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText)
  return (res.status === 204 ? null : await res.json()) as T
}

export const api = {
  search: (params: { q: string; tags: string[]; status: string }) => {
    const qs = new URLSearchParams({ q: params.q, status: params.status, limit: '100' })
    if (params.tags.length) qs.set('tags', params.tags.join(','))
    return request<SearchResult>(`/pitfalls?${qs}`)
  },
  create: (input: PitfallInput) => request<Pitfall>('/pitfalls', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: PitfallPatch) => request<Pitfall>(`/pitfalls/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<null>(`/pitfalls/${id}`, { method: 'DELETE' }),
  tags: () => request<{ tag: string; count: number }[]>('/tags'),
  stats: () => request<Stats>('/stats'),
}

export type { Feedback, FeedbackStatus } from '../../src/core/types.ts'
import type { Feedback, FeedbackStatus } from '../../src/core/types.ts'

export const feedbackApi = {
  list: (status: string) => request<{ items: Feedback[]; total: number }>(`/feedback?status=${status}`),
  resolve: (id: string, status: FeedbackStatus, resolution?: string) =>
    request<Feedback>(`/feedback/${id}`, { method: 'PATCH', body: JSON.stringify({ status, resolution }) }),
}
