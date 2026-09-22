// ponytail: the smallest check that fails if the mapping or URL-gating breaks.
// Run: `node --experimental-strip-types plugins/searxng-search/selfcheck.ts`.
import assert from 'node:assert'
import {
  isLocalBaseURL,
  mapSearxngResponse,
  mapSearxngResult,
  resolveEnsureOptions,
  SEARXNG_DEFAULT_CONTAINER,
  SEARXNG_DEFAULT_IMAGE,
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
console.log('searxng-search selfcheck: ok')
