import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/core/db.js'
import { normalizeSignature, parseQuery } from '../src/core/query.js'
import { PitfallStore } from '../src/core/store.js'

let store: PitfallStore

beforeEach(() => {
  store = new PitfallStore(openDatabase(':memory:'))
})

function seed() {
  const sharp = store.create({
    title: 'pnpm 安装 sharp 时原生模块编译失败',
    symptom: 'ERR_PNPM_LIFECYCLE sharp@0.33.2 install: node-gyp rebuild exit code 1',
    cause: 'pnpm v10 默认不执行依赖的 postinstall 脚本',
    solution: '在 package.json 里加 `pnpm.onlyBuiltDependencies: ["sharp"]` 后重新安装',
    tags: ['pnpm', 'Sharp', 'node-gyp'],
    errorSignature: 'ERR_PNPM_LIFECYCLE sharp@0.33.2 install /home/a/proj/node_modules/sharp',
    sourceProject: 'novel-studio',
  })
  const wsl = store.create({
    title: 'WSL2 下 Vite 热更新不生效',
    symptom: '修改文件后浏览器不刷新',
    cause: '项目放在 /mnt/c 下，inotify 收不到 Windows 文件系统的事件',
    solution: '把项目移到 Linux 文件系统，或设置 `server.watch.usePolling = true`',
    tags: ['vite', 'wsl'],
    severity: 'high',
  })
  return { sharp, wsl }
}

describe('parseQuery', () => {
  it('cuts CJK runs into trigrams and keeps short terms aside', () => {
    expect(parseQuery('原生模块编译')).toEqual({
      fts: '"原生模" OR "生模块" OR "模块编" OR "块编译"',
      short: [],
    })
    expect(parseQuery('ts 报错')).toEqual({ fts: null, short: ['ts', '报错'] })
    expect(parseQuery('say "hi" pnpm')).toEqual({ fts: '"say" OR "pnpm"', short: ['hi'] })
  })

  it('normalizes volatile parts of error signatures', () => {
    expect(normalizeSignature('Error at /home/a/x/y.ts:12:3 code 0xFF')).toBe(normalizeSignature('error at /Users/b/z.ts:99:1 code 0x1'))
  })
})

describe('PitfallStore', () => {
  it('finds entries by CJK fragments, English terms and short terms', () => {
    const { sharp, wsl } = seed()
    expect(store.search({ q: '编译失败了怎么办' }).items[0]?.id).toBe(sharp.id)
    expect(store.search({ q: 'usePolling' }).items.map((i) => i.id)).toEqual([wsl.id])
    expect(store.search({ q: '热更' }).items.map((i) => i.id)).toEqual([wsl.id])
    expect(store.search({ q: 'ERR_PNPM_LIFECYCLE' }).total).toBe(1)
  })

  it('filters by tag (case-insensitive) and status', () => {
    const { sharp, wsl } = seed()
    expect(store.search({ tags: ['SHARP'] }).items.map((i) => i.id)).toEqual([sharp.id])
    store.feedback(wsl.id, 'outdated')
    expect(store.search({ q: 'vite' }).total).toBe(0)
    expect(store.search({ q: 'vite', status: [] }).total).toBe(1)
  })

  it('keeps the FTS index in sync on update and delete', () => {
    const { sharp } = seed()
    store.update(sharp.id, { solution: 'use onlyBuiltDependencies or approve-builds' })
    expect(store.search({ q: 'approve-builds' }).total).toBe(1)
    store.remove(sharp.id)
    expect(store.search({ q: 'approve-builds' }).total).toBe(0)
  })

  it('detects duplicates by title or normalized error signature', () => {
    const { sharp } = seed()
    const dupes = store.findDuplicates({
      title: 'something else',
      errorSignature: 'ERR_PNPM_LIFECYCLE sharp@0.34.0 install /Users/b/other/node_modules/sharp',
    })
    expect(dupes.map((d) => d.id)).toEqual([sharp.id])
    expect(store.findDuplicates({ title: '  WSL2 下 vite 热更新不生效 ' })).toHaveLength(1)
    expect(store.findDuplicates({ title: 'unrelated' })).toHaveLength(0)
  })

  it('ranks entries for a project fingerprint by matched tags', () => {
    const { sharp, wsl } = seed()
    const { items } = store.relevantForTags(['wsl', 'vite', 'pnpm'])
    expect(items.map((i) => i.id)).toEqual([wsl.id, sharp.id])
    expect(items[0]?.matchedTags.sort()).toEqual(['vite', 'wsl'])
  })

  it('round-trips through export / import', () => {
    seed()
    const dump = store.exportAll()
    const other = new PitfallStore(openDatabase(':memory:'))
    expect(other.importMany(dump)).toEqual({ created: 2, updated: 0, skipped: 0 })
    expect(other.exportAll()).toEqual(dump)
    expect(other.importMany(dump)).toEqual({ created: 0, updated: 0, skipped: 2 })
  })
})

describe('fuzzy fallback', () => {
  it('finds Chinese queries phrased differently, but not on a single shared word', () => {
    const { sharp, wsl } = seed()
    expect(store.search({ q: '原生模块安装编不过' }).items.map((i) => i.id)).toEqual([sharp.id])
    expect(store.search({ q: 'vite 热更新失效了' }).items[0]?.id).toBe(wsl.id)
    expect(store.search({ q: '数据库连接失败' }).total).toBe(0)
  })
})
