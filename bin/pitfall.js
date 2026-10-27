#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning; it would pollute hook and MCP output.
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return
  return emitWarning.call(process, warning, ...args)
}

const { main } = await import('../dist/cli.js')
await main(process.argv.slice(2))
