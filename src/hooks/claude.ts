import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDbPath } from '../core/db.js'
import { ENVIRONMENT_TAGS, fingerprint } from '../core/fingerprint.js'
import { formatErrorMatches, oneLine } from '../core/format.js'
import { matchErrorOutput, type ErrorMatch } from '../core/match.js'
import type { PitfallStore } from '../core/store.js'
import { FeedbackStore, type Feedback } from '../core/feedback.js'
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
  relevant(tags: string[], limit: number): Promise<{ items: (Pitfall & { matchedTags: string[] })[]; total: number }>
  match(output: string): Promise<ErrorMatch[]>
  openIssues(limit: number): Promise<{ items: Feedback[]; total: number }>
}

/** The project whose sessions get the platform's open feedback at start. */
const PLATFORM_PROJECT = 'pitfall-hub'

export function localBackend(store: PitfallStore): HookBackend {
  return {
    relevant: async (tags, limit) => store.relevantForTags(tags, limit),
    match: async (output) => matchErrorOutput(store, output),
    openIssues: async (limit) => new FeedbackStore(store.db).list({ limit }),
  }
}

export function remoteBackend(baseUrl: string, token?: string, timeoutMs = 3000): HookBackend {
  const post = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(new URL(path, baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return (await res.json()) as T
  }
  return {
    relevant: (tags, limit) => post('/api/relevant', { tags, limit }),
    match: (output) => post('/api/match', { output }),
    openIssues: (limit) => post(`/api/feedback?limit=${limit}`),
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
    openIssues: (limit) => rpc('issues', { limit }),
  }
}

const STACK_LIMIT = 6
const ENVIRONMENT_LIMIT = 2

// Always shown, so the platform is known in every project even when nothing matches yet.
const PRESENCE = `[pitfall-hub] Cross-project pitfall knowledge base (MCP server "pitfall-hub", skill "pitfall-hub"). Before a second debugging attempt: search_pitfalls / match_error. After a non-obvious fix that would recur elsewhere: record_pitfall. When it surfaces something unrelated or misses something: pitfall_feedback irrelevant / report_platform_issue.`
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
  let items: (Pitfall & { matchedTags: string[] })[] = []
  let issues: { items: Feedback[]; total: number } | null = null
  let unreachable = ''
  try {
    ;[{ items }, issues] = await Promise.all([
      backend.relevant(fp.tags, 50),
      fp.name === PLATFORM_PROJECT ? backend.openIssues(10) : null,
    ])
  } catch (err) {
    // The announcement must survive an unreachable server; only the data is missing.
    unreachable = `(The knowledge base is unreachable right now: ${(err as Error).message}. Its tools will fail until it is back.)`
  }
  const isEnvOnly = (p: { matchedTags: string[] }) => p.matchedTags.every((t) => ENVIRONMENT_TAGS.has(t))
  const stack = items.filter((p) => !isEnvOnly(p))
  const env = items.filter(isEnvOnly)

  const lines = [PRESENCE]
  if (unreachable) lines.push(unreachable)
  if (stack.length) {
    lines.push(
      `Known pitfalls for this project's stack (${stack.length}${stack.length > STACK_LIMIT ? `, top ${STACK_LIMIT}` : ''}; get_pitfall <id> for details):`,
      ...stack.slice(0, STACK_LIMIT).map((p) => oneLine(p)),
    )
  }
  if (env.length) {
    lines.push(
      `Known pitfalls for this machine / agent environment (${env.length}${env.length > ENVIRONMENT_LIMIT ? `, top ${ENVIRONMENT_LIMIT}` : ''}):`,
      ...env.slice(0, ENVIRONMENT_LIMIT).map((p) => oneLine(p)),
    )
  }
  if (issues?.items.length) {
    lines.push(
      `[pitfall-hub] ${issues.total} open report(s) about this platform from agents in other projects (list_platform_issues for details, resolve_platform_issue when fixed):`,
      ...issues.items.map((f) => `- ${f.id} [${f.kind}] ${f.votes}x ${f.title}`),
    )
  }
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
