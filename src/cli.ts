import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultDbPath, openDatabase } from './core/db.js'
import { formatFull, formatSearch } from './core/format.js'
import { PitfallStore } from './core/store.js'
import { SEVERITIES, type PitfallInput } from './core/types.js'

const HELP = `pitfall — cross-project pitfall knowledge base for coding agents

Usage:
  pitfall search <query> [--tag t]... [--all] [--limit n] [--json]
  pitfall show <id> [--json]
  pitfall add --title T --solution S [--symptom ..] [--cause ..] [--prevention ..]
              [--tag t]... [--env ..] [--signature ..] [--severity low|medium|high]
  pitfall add --json <file|->          add one entry or an array from JSON
  pitfall match <file|->               match error output against known pitfalls
  pitfall export [file]                JSON dump (stdout by default)
  pitfall import <file>                upsert from a JSON dump
  pitfall stats
  pitfall serve [--port 4477]          Web UI + JSON API
  pitfall mcp                          MCP server over stdio
  pitfall hook <event>                 Claude Code hook handler (reads stdin)
  pitfall install | uninstall          register MCP server, skill and hooks in ~/.claude

Database: ${defaultDbPath()}  (override with PITFALL_HUB_DB)`

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv
  const { values: v, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      tag: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      port: { type: 'string' },
      title: { type: 'string' },
      solution: { type: 'string' },
      symptom: { type: 'string' },
      cause: { type: 'string' },
      prevention: { type: 'string' },
      env: { type: 'string' },
      signature: { type: 'string' },
      severity: { type: 'string' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (!cmd || cmd === 'help' || v.help) return console.log(HELP)

  if (cmd === 'install' || cmd === 'uninstall') {
    const mod = await import('./install/claude.js')
    return console.log((cmd === 'install' ? mod.install() : mod.uninstall()).join('\n'))
  }

  const store = new PitfallStore(openDatabase())
  const out = (data: unknown, text: string) => console.log(v.json ? JSON.stringify(data, null, 2) : text)

  switch (cmd) {
    case 'search': {
      const q = positionals.join(' ')
      const r = store.search({ q, tags: v.tag, status: v.all ? [] : ['active'], limit: Number(v.limit ?? 10) })
      return out(r, formatSearch(r, q))
    }
    case 'show': {
      const p = store.get(positionals[0] ?? '')
      if (!p) return fail(`No pitfall ${positionals[0]}`)
      return out(p, formatFull(p))
    }
    case 'add': {
      if (v.json) {
        const data = JSON.parse(readInput(positionals[0])) as PitfallInput | PitfallInput[]
        const created = (Array.isArray(data) ? data : [data]).map((d) => store.create(d))
        return out(created, created.map((p) => `Recorded ${p.id}: ${p.title}`).join('\n'))
      }
      if (!v.title || !v.solution) return fail('add needs --title and --solution (or --json)')
      if (v.severity && !SEVERITIES.includes(v.severity as never)) return fail(`--severity must be one of ${SEVERITIES.join(', ')}`)
      const p = store.create({
        title: v.title,
        solution: v.solution,
        symptom: v.symptom,
        cause: v.cause,
        prevention: v.prevention,
        tags: v.tag,
        environment: v.env,
        errorSignature: v.signature,
        severity: v.severity as PitfallInput['severity'],
        sourceProject: v.project ?? basename(process.cwd()),
        sourceAgent: 'cli',
      })
      return out(p, `Recorded ${p.id}: ${p.title}`)
    }
    case 'match': {
      const { matchErrorOutput } = await import('./core/match.js')
      const { formatErrorMatches } = await import('./core/format.js')
      const matches = matchErrorOutput(store, readInput(positionals[0]))
      return out(matches, matches.length ? formatErrorMatches(matches) : 'No known pitfall matches this output.')
    }
    case 'export': {
      const json = JSON.stringify(store.exportAll(), null, 2)
      if (positionals[0]) {
        writeFileSync(positionals[0], json)
        return console.error(`Exported to ${positionals[0]}`)
      }
      return console.log(json)
    }
    case 'import': {
      const r = store.importMany(JSON.parse(readInput(positionals[0])))
      return console.log(`created ${r.created}, updated ${r.updated}, skipped ${r.skipped}`)
    }
    case 'stats': {
      const s = store.stats()
      return out(
        s,
        [
          `${s.total} pitfalls (${Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`,
          `retrieved ${s.hits}x, marked helpful ${s.helpful}x`,
          s.projects.length ? `from: ${s.projects.map((p) => `${p.project} (${p.n})`).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    case 'serve': {
      const { runWebServer } = await import('./web/server.js')
      return runWebServer(store, Number(v.port ?? process.env.PORT ?? 4477))
    }
    case 'mcp': {
      const { runMcpServer } = await import('./mcp/server.js')
      return runMcpServer(store)
    }
    case 'hook': {
      const { handleHook } = await import('./hooks/claude.js')
      // A hook must never break the session: swallow everything, exit 0.
      try {
        const raw = readInput('-')
        const result = handleHook(positionals[0] ?? '', raw.trim() ? JSON.parse(raw) : {}, store)
        if (result) console.log(JSON.stringify(result))
      } catch (err) {
        console.error(`[pitfall-hub] hook ${positionals[0]} failed: ${(err as Error).message}`)
      }
      return
    }
    default:
      return fail(`Unknown command "${cmd}".\n\n${HELP}`)
  }
}

function readInput(source: string | undefined): string {
  if (!source || source === '-') {
    try {
      return readFileSync(0, 'utf8')
    } catch {
      return ''
    }
  }
  return readFileSync(source, 'utf8')
}

function fail(msg: string) {
  console.error(msg)
  process.exitCode = 1
}
