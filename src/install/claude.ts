import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_MD } from './skill.js'

const BIN = resolve(fileURLToPath(import.meta.url), '../../../bin/pitfall.js')
const MARKER = /pitfall\.js"? hook /

interface HookEntry {
  matcher?: string
  hooks: { type: string; command: string; timeout?: number }[]
}

type Target = { docker?: string; url?: string; token?: string }

function hookCommand(event: string, t: Target) {
  const token = t.url && t.token ? `PITFALL_HUB_TOKEN=${JSON.stringify(t.token)} ` : ''
  const env = t.docker ? `PITFALL_HUB_DOCKER=${t.docker} ` : t.url ? `PITFALL_HUB_URL=${JSON.stringify(t.url)} ${token}` : ''
  return `${env}node ${JSON.stringify(BIN)} hook ${event}`
}

const ourHooks = (url: Target): Record<string, HookEntry> => ({
  SessionStart: { hooks: [{ type: 'command', command: hookCommand('session-start', url), timeout: 10 }] },
  PostToolUseFailure: { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('tool-failure', url), timeout: 10 }] },
  PostToolUse: {
    matcher: 'mcp__pitfall-hub__(record_pitfall|update_pitfall|pitfall_feedback)',
    hooks: [{ type: 'command', command: hookCommand('recorded', url), timeout: 10 }],
  },
  Stop: { hooks: [{ type: 'command', command: hookCommand('stop', url), timeout: 10 }] },
})

export interface InstallOptions {
  claudeDir?: string
  /** Skip `claude mcp add` (e.g. in tests). */
  skipMcp?: boolean
  /** Base URL of a running pitfall-hub server. */
  url?: string
  /** Name of a pitfall-hub container reached with `docker exec` (no network path needed). */
  docker?: string
  /** Bearer token for `url`. */
  token?: string
}

export function install(opts: InstallOptions = {}): string[] {
  const dir = opts.claudeDir ?? join(homedir(), '.claude')
  const log: string[] = []

  const skillDir = join(dir, 'skills', 'pitfall-hub')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD)
  log.push(`skill   → ${join(skillDir, 'SKILL.md')}`)

  const url = opts.url?.replace(/\/+$/, '')
  const hooks = ourHooks({ docker: opts.docker, url, token: opts.token })
  editSettings(dir, (current) => {
    for (const [event, entry] of Object.entries(hooks)) {
      current[event] = [...withoutOurs(current[event]), entry]
    }
  })
  log.push(`hooks   → ${join(dir, 'settings.json')} (${Object.keys(hooks).join(', ')})`)

  if (!opts.skipMcp) {
    claude(['mcp', 'remove', '-s', 'user', 'pitfall-hub'], true)
    if (opts.docker) {
      // The MCP server runs inside the container; pass the agent's project name in, since cwd there is /app.
      const cmd = `exec docker exec -i -e PITFALL_PROJECT="$(basename "$PWD")" ${opts.docker} pitfall mcp`
      claude(['mcp', 'add', '-s', 'user', 'pitfall-hub', '--', 'sh', '-c', cmd])
    } else if (url) {
      // --header is variadic: it must come after the positionals or it swallows them.
      const auth = opts.token ? ['--header', `Authorization: Bearer ${opts.token}`] : []
      claude(['mcp', 'add', '-s', 'user', '--transport', 'http', 'pitfall-hub', `${url}/mcp`, ...auth])
    }
    else claude(['mcp', 'add', '-s', 'user', 'pitfall-hub', '--', 'node', BIN, 'mcp'])
    const how = opts.docker ? `docker exec ${opts.docker}` : url ? `http ${url}/mcp` : 'stdio, local database'
    log.push(`mcp     → registered "pitfall-hub" at user scope (${how})`)
  }
  return log
}

export function uninstall(opts: InstallOptions = {}): string[] {
  const dir = opts.claudeDir ?? join(homedir(), '.claude')
  rmSync(join(dir, 'skills', 'pitfall-hub'), { recursive: true, force: true })
  editSettings(dir, (hooks) => {
    for (const event of Object.keys(hooks)) {
      hooks[event] = withoutOurs(hooks[event])
      if (!hooks[event].length) delete hooks[event]
    }
  })
  if (!opts.skipMcp) claude(['mcp', 'remove', '-s', 'user', 'pitfall-hub'], true)
  return ['removed skill, hooks and MCP registration (the database is kept)']
}

function withoutOurs(entries: HookEntry[] | undefined): HookEntry[] {
  return (entries ?? []).filter((e) => !e.hooks?.some((h) => MARKER.test(h.command ?? '')))
}

function editSettings(dir: string, fn: (hooks: Record<string, HookEntry[]>) => void) {
  const path = join(dir, 'settings.json')
  const settings = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, HookEntry[]> }) : {}
  if (existsSync(path)) copyFileSync(path, `${path}.bak-pitfall-hub`)
  settings.hooks ??= {}
  fn(settings.hooks)
  if (!Object.keys(settings.hooks).length) delete settings.hooks
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

function claude(args: string[], ignoreFailure = false) {
  try {
    execFileSync('claude', args, { stdio: 'pipe' })
  } catch (err) {
    if (ignoreFailure) return
    // Never echo the command line: it can carry the bearer token.
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '').replace(/Bearer\s+\S+/g, 'Bearer ***')
    throw new Error(`claude ${args.slice(0, 3).join(' ')} … failed: ${stderr.trim()}`)
  }
}
