// ponytail: the smallest check that fails if the mapping or URL-gating breaks.
// Run: `node --experimental-strip-types plugins/searxng-search/selfcheck.ts`.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isLocalBaseURL,
  mapSearxngResponse,
  mapSearxngResult,
  name,
  resolveEnsureOptions,
  SEARXNG_DEFAULT_CONTAINER,
  SEARXNG_DEFAULT_IMAGE,
  SEARXNG_PROVIDER_ID,
} from './index.ts'

assert.deepStrictEqual(
  mapSearxngResult({ url: 'https://a.test/', title: ' A ', content: ' excerpt ', publishedDate: '2026-01-01' }),
  { url: 'https://a.test/', title: 'A', snippet: 'excerpt', publishedAt: '2026-01-01' },
)
assert.strictEqual(mapSearxngResult({ title: 'no url' }), undefined)
assert.deepStrictEqual(mapSearxngResult({ url: 'https://b.test/', title: null as never }), { url: 'https://b.test/' })
assert.deepStrictEqual(mapSearxngResponse({}).sources, [])
assert.deepStrictEqual(
  mapSearxngResponse({ results: [{ url: 'https://a.test/', content: 'one' }, { content: 'dropped' }] }),
  { sources: [{ url: 'https://a.test/', snippet: 'one' }], truncated: false },
)

assert.strictEqual(isLocalBaseURL('http://127.0.0.1:8888'), true)
assert.strictEqual(isLocalBaseURL('http://localhost:8888'), true)
assert.strictEqual(isLocalBaseURL('http://[::1]:8888'), true)
assert.strictEqual(isLocalBaseURL('https://searx.example.org/'), false)
assert.strictEqual(isLocalBaseURL('not a url'), false)

assert.deepStrictEqual(resolveEnsureOptions({}), {
  containerName: SEARXNG_DEFAULT_CONTAINER,
  containerCLI: 'podman',
  startTimeoutMs: 60_000,
  autoCreate: true,
  image: SEARXNG_DEFAULT_IMAGE,
  port: 8888,
  dataDir: `${process.env.HOME}/.local/share/searxng`,
})
assert.deepStrictEqual(
  resolveEnsureOptions({ containerName: 'sxng', containerCLI: 'docker', startTimeoutMs: 5_000 }),
  {
    containerName: 'sxng',
    containerCLI: 'docker',
    startTimeoutMs: 5_000,
    autoCreate: true,
    image: SEARXNG_DEFAULT_IMAGE,
    port: 8888,
    dataDir: `${process.env.HOME}/.local/share/searxng`,
  },
)
assert.strictEqual(resolveEnsureOptions({ startTimeoutMs: -1 }).startTimeoutMs, 60_000)
assert.strictEqual(resolveEnsureOptions({ port: 99999 }).port, 8888)
assert.strictEqual(resolveEnsureOptions({ autoCreate: false }).autoCreate, false)

// Packaging asserts: `dsh plugin add` only mounts what the manifest declares,
// so the manifest, the shipped files, and the bundle layer are checked here.
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as {
  name: string
  files: string[]
  dsh?: { bundle?: { patch?: string } }
}
assert.strictEqual(manifest.name, 'dsh-searxng-search', 'package name is the module row reference')
const patchRel = manifest.dsh?.bundle?.patch
assert(typeof patchRel === 'string' && patchRel.length > 0, 'package.json must declare dsh.bundle.patch')
const patchPath = join(import.meta.dirname, patchRel)
const patch = readFileSync(patchPath, 'utf8')
for (const shipped of [patchRel.replace(/^\.\//u, ''), 'lib/index.js']) {
  assert((manifest.files as string[]).includes(shipped), `files must ship ${shipped}`)
  assert.doesNotThrow(() => readFileSync(join(import.meta.dirname, shipped), 'utf8'), `${shipped} must exist`)
}
assert(patch.includes(`name: '${manifest.name}'`), 'bundle layer must reference the module by package name')
assert(!patch.includes('./index.ts'), 'bundle layer must not reference source paths')
assert(patch.includes('searchProvider: searxng-local'), 'bundle layer must pin the local provider')
assert(patch.includes('fetchProvider: http'), 'a web row override must restate every key it owns')

// The committed build artifact is what installed profiles load: import it and
// exercise the provider surface (no network; `available()` is a local check).
const built = await import('./lib/index.js') as typeof import('./index.ts')
assert.strictEqual(built.name, name, 'built artifact must export the plugin name')
assert.strictEqual(built.SEARXNG_PROVIDER_ID, SEARXNG_PROVIDER_ID, 'built artifact must export the provider id')
assert.strictEqual(typeof built.apply, 'function', 'built artifact must export apply')
assert.strictEqual(typeof built.mapSearxngResult, 'function', 'built artifact must export the mapping')
assert.deepStrictEqual(
  built.mapSearxngResult({ url: 'https://a.test/', content: ' excerpt ' }),
  { url: 'https://a.test/', snippet: 'excerpt' },
)
console.log('searxng-search selfcheck: ok')
