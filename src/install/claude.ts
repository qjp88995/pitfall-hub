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

function hookCommand(event: string) {
  return `node ${JSON.stringify(BIN)} hook ${event}`
}

const OUR_HOOKS: Record<string, HookEntry> = {
  SessionStart: { hooks: [{ type: 'command', command: hookCommand('session-start'), timeout: 10 }] },
  PostToolUseFailure: { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('tool-failure'), timeout: 10 }] },
  PostToolUse: {
    matcher: 'mcp__pitfall-hub__(record_pitfall|update_pitfall|pitfall_feedback)',
    hooks: [{ type: 'command', command: hookCommand('recorded'), timeout: 10 }],
  },
  Stop: { hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 10 }] },
}

export interface InstallOptions {
  claudeDir?: string
  /** Skip `claude mcp add` (e.g. in tests). */
  skipMcp?: boolean
}

export function install(opts: InstallOptions = {}): string[] {
  const dir = opts.claudeDir ?? join(homedir(), '.claude')
  const log: string[] = []

  const skillDir = join(dir, 'skills', 'pitfall-hub')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD)
  log.push(`skill   → ${join(skillDir, 'SKILL.md')}`)

  editSettings(dir, (hooks) => {
    for (const [event, entry] of Object.entries(OUR_HOOKS)) {
      hooks[event] = [...withoutOurs(hooks[event]), entry]
    }
  })
  log.push(`hooks   → ${join(dir, 'settings.json')} (${Object.keys(OUR_HOOKS).join(', ')})`)

  if (!opts.skipMcp) {
    claude(['mcp', 'remove', '-s', 'user', 'pitfall-hub'], true)
    claude(['mcp', 'add', '-s', 'user', 'pitfall-hub', '--', 'node', BIN, 'mcp'])
    log.push('mcp     → registered "pitfall-hub" at user scope')
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
    if (!ignoreFailure) throw err
  }
}
