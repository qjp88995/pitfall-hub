import { createInterface } from 'node:readline'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
  params?: { clientInfo?: { name?: string } }
}

/**
 * Stdio MCP server that forwards every JSON-RPC message to a remote pitfall-hub's /mcp.
 * Lets an agent use the hosted knowledge base through `docker exec` from a container on a
 * normal network, with the token kept in that container instead of the agent's config.
 * The remote endpoint is stateless, so each message is one independent POST.
 */
export async function runMcpProxy(opts: { url: string; token?: string; project?: string }) {
  const endpoint = new URL('/mcp', opts.url)
  let agent = ''
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)

  const forward = async (msg: JsonRpcMessage) => {
    if (msg.method === 'initialize') agent = msg.params?.clientInfo?.name ?? ''
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(opts.token && { authorization: `Bearer ${opts.token}` }),
        // Stateless server: it cannot remember who initialized, so say it on every request.
        ...(opts.project && { 'x-pitfall-project': encodeURIComponent(opts.project) }),
        ...(agent && { 'x-pitfall-agent': encodeURIComponent(agent) }),
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(30_000),
    })
    if (msg.id === undefined) return
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (check PITFALL_HUB_TOKEN)' : ''}`)
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      for (const line of (await res.text()).split('\n')) if (line.startsWith('data:')) write(JSON.parse(line.slice(5)))
    } else {
      write(await res.json())
    }
  }

  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      continue
    }
    forward(msg).catch((err: Error) => {
      if (msg.id !== undefined) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `pitfall-hub unreachable: ${err.message}` } })
      }
    })
  }
}
