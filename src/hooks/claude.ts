import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDbPath } from '../core/db.js'
import { fingerprint } from '../core/fingerprint.js'
import { formatErrorMatches, oneLine } from '../core/format.js'
import { matchErrorOutput, type ErrorMatch } from '../core/match.js'
import type { PitfallStore } from '../core/store.js'
import type { Pitfall } from '../core/types.js'

// Claude Code hook handlers. Each reads the hook JSON from stdin and returns the JSON to print
// (or null for no output). They must stay fast and never throw into the agent's session.

interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  error?: unknown
  stop_hook_active?: boolean
}

interface SessionState {
  failures: number
  recorded: boolean
  nudged: boolean
}

/** Where hooks get their data: the local database, or a pitfall-hub server (e.g. the Docker container). */
export interface HookBackend {
  relevant(tags: string[], limit: number): Promise<{ items: Pitfall[]; total: number }>
  match(output: string): Promise<ErrorMatch[]>
}

export function localBackend(store: PitfallStore): HookBackend {
  return {
    relevant: async (tags, limit) => store.relevantForTags(tags, limit),
    match: async (output) => matchErrorOutput(store, output),
  }
}

export function remoteBackend(baseUrl: string, token?: string, timeoutMs = 3000): HookBackend {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return (await res.json()) as T
  }
  return {
    relevant: (tags, limit) => post('/api/relevant', { tags, limit }),
    match: (output) => post('/api/match', { output }),
  }
}

/** Talks to a pitfall-hub container through `docker exec`; no network path to it is needed. */
export function dockerBackend(container: string, timeoutMs = 5000): HookBackend {
  const rpc = <T>(method: string, body: unknown) =>
    new Promise<T>((resolve, reject) => {
      const child = execFile('docker', ['exec', '-i', container, 'pitfall', 'rpc', method], { timeout: timeoutMs }, (err, stdout) =>
        err ? reject(err) : resolve(JSON.parse(stdout) as T),
      )
      child.stdin?.end(JSON.stringify(body))
    })
  return {
    relevant: (tags, limit) => rpc('relevant', { tags, limit }),
    match: (output) => rpc('match', { output }),
  }
}

const SESSION_START_LIMIT = 6
const NUDGE_AFTER_FAILURES = 3

export async function handleHook(event: string, input: HookInput, backend: HookBackend): Promise<object | null> {
  switch (event) {
    case 'session-start':
      return sessionStart(input, backend)
    case 'tool-failure':
      return toolFailure(input, backend)
    case 'recorded':
      updateSession(input.session_id, (s) => ({ ...s, recorded: true }))
      return null
    case 'stop':
      return stop(input)
    default:
      throw new Error(`unknown hook event: ${event}`)
  }
}

async function sessionStart(input: HookInput, backend: HookBackend) {
  pruneSessions()
  const fp = fingerprint(input.cwd || process.cwd())
  const { items, total } = await backend.relevant(fp.tags, SESSION_START_LIMIT)
  if (!items.length) return null
  const lines = [
    `[pitfall-hub] ${total} known pitfall(s) relevant to this project's stack${total > items.length ? `, top ${items.length}` : ''}. Keep them in mind; get_pitfall <id> for details, search_pitfalls for more.`,
    ...items.map((p) => oneLine(p)),
  ]
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }
}

async function toolFailure(input: HookInput, backend: HookBackend) {
  updateSession(input.session_id, (s) => ({ ...s, failures: s.failures + 1 }))
  const output = collectText(input.error) + '\n' + collectText(input.tool_response)
  if (output.trim().length < 10) return null
  const matches = await backend.match(output)
  if (!matches.length) return null
  return {
    hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolUseFailure', additionalContext: formatErrorMatches(matches) },
  }
}

function stop(input: HookInput) {
  if (input.stop_hook_active || !input.session_id) return null
  const s = readSession(input.session_id)
  if (s.recorded || s.nudged || s.failures < NUDGE_AFTER_FAILURES) return null
  updateSession(input.session_id, (st) => ({ ...st, nudged: true }))
  return {
    decision: 'block',
    reason: `[pitfall-hub] ${s.failures} commands failed in this session. If any led to a non-obvious fix that would recur in other projects (tool/library/platform behaviour, version issue, misleading error), record it with record_pitfall (search_pitfalls first; update the existing entry if found). If nothing qualifies, just finish — do not mention this check.`,
  }
}

function collectText(v: unknown, depth = 0): string {
  if (v == null || depth > 3) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => collectText(x, depth + 1)).join('\n')
  if (typeof v === 'object') return Object.values(v).map((x) => collectText(x, depth + 1)).join('\n')
  return ''
}

function sessionsDir() {
  return join(dirname(defaultDbPath()), 'sessions')
}

function readSession(id: string): SessionState {
  try {
    return JSON.parse(readFileSync(join(sessionsDir(), `${id}.json`), 'utf8')) as SessionState
  } catch {
    return { failures: 0, recorded: false, nudged: false }
  }
}

function updateSession(id: string | undefined, fn: (s: SessionState) => SessionState) {
  if (!id || !/^[\w-]+$/.test(id)) return
  mkdirSync(sessionsDir(), { recursive: true })
  writeFileSync(join(sessionsDir(), `${id}.json`), JSON.stringify(fn(readSession(id))))
}

function pruneSessions() {
  const cutoff = Date.now() - 7 * 86_400_000
  try {
    for (const f of readdirSync(sessionsDir())) {
      const path = join(sessionsDir(), f)
      if (statSync(path).mtimeMs < cutoff) rmSync(path)
    }
  } catch {}
}
