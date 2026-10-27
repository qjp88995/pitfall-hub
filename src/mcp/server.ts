import { basename } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { formatErrorMatches, formatFull, formatSearch, oneLine } from '../core/format.js'
import { matchErrorOutput } from '../core/match.js'
import type { PitfallStore } from '../core/store.js'
import { SEVERITIES, STATUSES, type PitfallPatch } from '../core/types.js'

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError })

const fields = {
  title: z.string().describe('Short, searchable statement of the problem, e.g. "pnpm v10 skips sharp build scripts"'),
  symptom: z.string().optional().describe('What was observed. Paste the key error lines verbatim.'),
  cause: z.string().optional().describe('Root cause, once understood.'),
  solution: z.string().describe('What actually fixed it (markdown, include exact commands/config).'),
  prevention: z.string().optional().describe('How to avoid it next time, e.g. a check to run first.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Package names exactly as in the manifest (next, vite, sharp, prisma) plus ecosystem/platform (node, python, pnpm, docker, wsl, macos). These drive auto-surfacing in other projects.'),
  environment: z.string().optional().describe('Versions/OS it was seen on, e.g. "next@15.1, node 22, WSL2".'),
  error_signature: z
    .string()
    .optional()
    .describe('The single most distinctive error line, verbatim. Used to auto-match future failures, so avoid generic lines.'),
  severity: z.enum(SEVERITIES).optional().describe('high = cost a lot of time or causes silent breakage'),
}

export function createMcpServer(store: PitfallStore) {
  const server = new McpServer({ name: 'pitfall-hub', version: '0.1.0' })
  const project = basename(process.env.CLAUDE_PROJECT_DIR || process.cwd())
  const agent = () => server.server.getClientVersion()?.name ?? ''

  server.registerTool(
    'search_pitfalls',
    {
      description:
        'Search the cross-project pitfall knowledge base (pitfalls previously hit and solved in any project). Use before debugging an unfamiliar error, before touching tooling/config you have had trouble with, or when starting work with a library. Accepts keywords, Chinese or English, or pasted error text.',
      inputSchema: {
        query: z.string().describe('Keywords or error text'),
        tags: z.array(z.string()).optional().describe('Only entries with at least one of these tags'),
        include_outdated: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tags, include_outdated, limit }) =>
      text(formatSearch(store.search({ q: query, tags, limit: limit ?? 8, status: include_outdated ? ['active', 'outdated'] : ['active'] }), query)),
  )

  server.registerTool(
    'match_error',
    {
      description:
        'Match raw failing output (compiler/runtime/install errors) against known pitfalls with high precision. Returns nothing when there is no confident match.',
      inputSchema: { output: z.string().describe('The error output, as-is') },
      annotations: { readOnlyHint: true },
    },
    async ({ output }) => {
      const matches = matchErrorOutput(store, output)
      return text(matches.length ? formatErrorMatches(matches) : 'No known pitfall matches this output.')
    },
  )

  server.registerTool(
    'get_pitfall',
    {
      description: 'Full detail of one pitfall (symptom, cause, solution, prevention, environment).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const p = store.get(id, { trackHit: true })
      return p ? text(formatFull(p)) : text(`No pitfall ${id}`, true)
    },
  )

  server.registerTool(
    'record_pitfall',
    {
      description:
        'Record a pitfall after solving it, so it is not hit again in other projects. Worth recording: non-obvious fixes that took more than one attempt and would recur elsewhere (tool/library/platform behaviour, version incompatibilities, misleading errors). Not worth it: typos, project-specific business logic, things documented on the first search result. Refuses exact duplicates and returns the existing entry; then use update_pitfall.',
      inputSchema: { ...fields, force: z.boolean().optional().describe('Record even if a duplicate exists') },
    },
    async ({ error_signature, force, ...input }) => {
      if (!force) {
        const dupes = store.findDuplicates({ title: input.title, errorSignature: error_signature })
        if (dupes.length) {
          return text(
            ['Not recorded: this looks like an existing pitfall. Update it with update_pitfall (e.g. append_note), or pass force=true if it is really different.', ...dupes.map((d) => oneLine(d))].join('\n'),
          )
        }
      }
      const p = store.create({ ...input, errorSignature: error_signature, sourceProject: project, sourceAgent: agent() })
      const similar = store
        .search({ q: input.title, limit: 4 })
        .items.filter((s) => s.id !== p.id)
        .slice(0, 3)
      return text(
        [`Recorded ${p.id}: ${p.title}`, ...(similar.length ? ['Similar existing entries (merge if they are the same issue):', ...similar.map((s) => oneLine(s))] : [])].join('\n'),
      )
    },
  )

  server.registerTool(
    'update_pitfall',
    {
      description:
        'Improve an existing pitfall: correct fields, add tags, or append_note with a new variant/workaround (dated, appended to the solution).',
      inputSchema: {
        id: z.string(),
        ...fields,
        title: fields.title.optional(),
        solution: fields.solution.optional(),
        append_note: z.string().optional().describe('New variant / workaround / caveat to append to the solution'),
        status: z.enum(STATUSES).optional(),
      },
    },
    async ({ id, append_note, error_signature, ...rest }) => {
      const current = store.get(id)
      if (!current) return text(`No pitfall ${id}`, true)
      const patch: PitfallPatch = { ...rest, ...(error_signature !== undefined && { errorSignature: error_signature }) }
      if (append_note) {
        const base = patch.solution ?? current.solution
        patch.solution = `${base}\n\n**${new Date().toISOString().slice(0, 10)} (${project})**: ${append_note}`
      }
      const p = store.update(id, patch)!
      return text(`Updated ${p.id}: ${p.title}`)
    },
  )

  server.registerTool(
    'pitfall_feedback',
    {
      description: 'Report whether a pitfall helped. "outdated" hides it from searches and auto-surfacing (e.g. fixed upstream).',
      inputSchema: { id: z.string(), kind: z.enum(['helpful', 'outdated']), note: z.string().optional() },
    },
    async ({ id, kind, note }) => {
      let p = store.feedback(id, kind)
      if (!p) return text(`No pitfall ${id}`, true)
      if (note) {
        p = store.update(id, { solution: `${p.solution}\n\n**${new Date().toISOString().slice(0, 10)} ${kind}**: ${note}` })!
      }
      return text(`${kind === 'helpful' ? 'Marked helpful' : 'Marked outdated'}: ${p.id}`)
    },
  )

  server.registerTool(
    'list_pitfall_tags',
    { description: 'All tags in use with counts; reuse existing tags when recording.', annotations: { readOnlyHint: true } },
    async () => text(store.tags().map((t) => `${t.tag} (${t.count})`).join(', ') || 'No tags yet.'),
  )

  return server
}

export async function runMcpServer(store: PitfallStore) {
  await createMcpServer(store).connect(new StdioServerTransport())
}
