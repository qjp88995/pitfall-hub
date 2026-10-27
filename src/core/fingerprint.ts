import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Tags describing the machine / agent setup rather than the project's stack. Every project on
 * the machine carries them, so matching only on these says nothing about this project.
 */
export const ENVIRONMENT_TAGS = new Set(['linux', 'wsl', 'macos', 'windows', 'claude-code'])

export interface ProjectFingerprint {
  name: string
  root: string
  tags: string[]
}

/**
 * Derives tags for a project from its manifests, so recorded pitfalls (tagged with package
 * names and ecosystems) can be surfaced when a session starts in another project.
 */
export function fingerprint(cwd: string): ProjectFingerprint {
  const root = gitRoot(cwd) ?? cwd
  const tags = new Set<string>(platformTags())
  for (const dir of new Set([root, cwd])) scan(dir, tags)
  return { name: basename(root), root, tags: [...tags] }
}

function scan(dir: string, tags: Set<string>) {
  const has = (f: string) => existsSync(join(dir, f))
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), 'utf8')
    } catch {
      return ''
    }
  }

  const pkg = read('package.json')
  if (pkg) {
    tags.add('node')
    try {
      const json = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(json[field] ?? {})) {
          if (!name.startsWith('@types/')) tags.add(name.toLowerCase())
        }
      }
    } catch {}
  }
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) tags.add('pnpm')
  if (has('yarn.lock')) tags.add('yarn')
  if (has('bun.lockb') || has('bun.lock')) tags.add('bun')
  if (has('tsconfig.json')) tags.add('typescript')

  const py = read('pyproject.toml') + '\n' + read('requirements.txt')
  if (py.trim()) {
    tags.add('python')
    for (const m of py.matchAll(/^\s*"?([A-Za-z][\w.-]+)\s*(?:[<>=~!\[;"]|$)/gm)) tags.add(m[1]!.toLowerCase())
    if (has('uv.lock')) tags.add('uv')
  }
  if (has('Cargo.toml')) tags.add('rust')
  if (has('go.mod')) tags.add('go')
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) tags.add('docker')
  if (has('.claude') || has('CLAUDE.md')) tags.add('claude-code')
}

function platformTags(): string[] {
  if (process.platform === 'darwin') return ['macos']
  if (process.platform === 'win32') return ['windows']
  try {
    if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return ['linux', 'wsl']
  } catch {}
  return ['linux']
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}
