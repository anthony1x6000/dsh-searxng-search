// ponytail: the smallest check that fails if the mapping or URL-gating breaks.
// Run: `node --experimental-strip-types plugins/searxng-search/selfcheck.ts`.
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// The README install one-liner must survive a base-install `[]` patch file.
// The shell body is extracted straight from the README so docs and behavior
// cannot drift, then run against temp HOMEs (missing file, base `[]`
// template, and a rerun for idempotency).
const readme = readFileSync(join(import.meta.dirname, 'README.md'), 'utf8')
const oneliner = readme.split('\n').find((line) => line.startsWith('git clone ') && line.includes('mkdir -p'))
assert(oneliner !== undefined, 'README must contain the install one-liner')
const installerSh = oneliner.replace(/^git clone [^&]+&& /u, '')
function runInstaller(initial?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'searxng-install-'))
  const dir = join(home, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  if (initial !== undefined) writeFileSync(patchPath, initial)
  execFileSync('bash', ['-c', installerSh], { env: { ...process.env, HOME: home } })
  return readFileSync(patchPath, 'utf8')
}
const BASE_PATCH = '# Your patch layer for this dsh profile.\n[]\n'
for (const initial of [undefined, BASE_PATCH]) {
  const out = runInstaller(initial)
  assert.strictEqual(out.match(/id: web-search-searxng/gu)?.length ?? 0, 1, 'exactly one plugin insert')
  assert.strictEqual(out.match(/searchProvider: searxng-local/gu)?.length ?? 0, 1, 'exactly one provider pin')
  assert(!/^\[\]\s*$/mu.test(out), 'base `[]` must be gone')
}
{
  const home = mkdtempSync(join(tmpdir(), 'searxng-install-'))
  const dir = join(home, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env, HOME: home }
  execFileSync('bash', ['-c', installerSh], { env })
  execFileSync('bash', ['-c', installerSh], { env })
  const out = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.strictEqual(out.match(/id: web-search-searxng/gu)?.length ?? 0, 1, 'rerun must not duplicate the insert')
  assert.strictEqual(out.match(/searchProvider: searxng-local/gu)?.length ?? 0, 1, 'rerun must not duplicate the pin')
}
console.log('searxng-search selfcheck: ok')
