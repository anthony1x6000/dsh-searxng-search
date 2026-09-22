// ponytail: no Config/Volatile/schemastery here — $SEARXNG_BASE_URL plus the
// autostart knobs below are the whole surface.
/**
 * Local SearXNG search provider for the DeepSeek Harness `ctx.web` seam.
 * Talks to a self-hosted SearXNG instance (`GET {base}/search?q=…&format=json`,
 * see https://docs.searxng.org/dev/search_api.html) so `web_search` works
 * without the DeepSeek web-search API key.
 *
 * Load once per profile via `--patch` (no install, no profile edit):
 *   SEARXNG_BASE_URL=http://127.0.0.1:8888 pnpm dsh web \
 *     --patch ./plugins/searxng-search/cordis.patch.yml
 *
 * The container starts on demand: the first search probes `{base}/healthz`
 * and runs `podman start <container>` (loopback bases only) when it is down.
 * `apply()` also kicks a fire-and-forget warmup so it is usually hot already.
 * Boot never fails on this — a container that cannot start surfaces per
 * search as `WEB_PROVIDER_ERROR`.
 *
 * SearXNG must enable the `json` format (`search.formats`, default on; a
 * disabled format answers 403).
 *
 * @module searxng-search-plugin
 */

// Type-only Cordis/web imports: erased at load, so this file runs straight
// from a profile patch through the CLI tsx loader with no package install.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng-local'

/** Default local SearXNG base (no trailing path; `/search` is appended). */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8888'

/** Default container name started on demand for loopback bases. */
export const SEARXNG_DEFAULT_CONTAINER = 'searxng'

/** Default container CLI; `docker` is tried when `podman` is not installed. */
export const SEARXNG_DEFAULT_CLI = 'podman'

/** Default budget for on-demand start + readiness (ms). */
export const SEARXNG_DEFAULT_START_TIMEOUT_MS = 60_000

/** Default container image pulled on first use. */
export const SEARXNG_DEFAULT_IMAGE = 'docker.io/searxng/searxng:latest'

/** Default host port the container binds (loopback only). */
export const SEARXNG_DEFAULT_PORT = 8888

/** Default data dir holding `settings/settings.yml` and the image cache. */
export const SEARXNG_DEFAULT_DATA_DIR = '.local/share/searxng'

/** Plugin config: every field optional, env fills the gaps. */
export interface Config {
  /** SearXNG base URL. Falls back to `$SEARXNG_BASE_URL`, then localhost. */
  baseURL?: string
  /** Container started on demand. Falls back to `$SEARXNG_CONTAINER`, default `searxng`. */
  containerName?: string
  /** Container CLI. Falls back to `$SEARXNG_CLI`, default `podman` (with `docker` fallback). */
  containerCLI?: string
  /** Budget for on-demand start + readiness. Falls back to `$SEARXNG_START_TIMEOUT_MS`, default 60000. */
  startTimeoutMs?: number
  /** Create the container when missing (first boot on a new system). Default true. */
  autoCreate?: boolean
  /** Image pulled on first creation. Falls back to `$SEARXNG_IMAGE`, default docker.io latest. */
  image?: string
  /** Host port the container binds. Falls back to `$SEARXNG_PORT`, default 8888. */
  port?: number
}

/** Resolved on-demand-start options (env and constant defaults applied). */
export interface EnsureSearxngOptions {
  /** Container started on demand. */
  containerName: string
  /** Preferred container CLI. */
  containerCLI: string
  /** Budget for start + readiness (ms). */
  startTimeoutMs: number
  /** Create the container when missing (first boot on a new system). */
  autoCreate: boolean
  /** Image pulled on first creation. */
  image: string
  /** Host port the container binds. */
  port: number
  /** Data dir holding `settings/settings.yml` and the image cache. */
  dataDir: string
}

/**
 * Project one config section into the options the on-demand start uses.
 * @param config - the currently authoritative section.
 * @returns options with every value fully defaulted.
 */
export function resolveEnsureOptions(config: Config = {}): EnsureSearxngOptions {
  const startTimeoutMs = config.startTimeoutMs
    ?? Number(process.env.SEARXNG_START_TIMEOUT_MS ?? SEARXNG_DEFAULT_START_TIMEOUT_MS)
  const port = config.port ?? Number(process.env.SEARXNG_PORT ?? SEARXNG_DEFAULT_PORT)
  return {
    containerName: config.containerName ?? process.env.SEARXNG_CONTAINER ?? SEARXNG_DEFAULT_CONTAINER,
    containerCLI: config.containerCLI ?? process.env.SEARXNG_CLI ?? SEARXNG_DEFAULT_CLI,
    startTimeoutMs: Number.isInteger(startTimeoutMs) && (startTimeoutMs as number) > 0
      ? startTimeoutMs as number
      : SEARXNG_DEFAULT_START_TIMEOUT_MS,
    autoCreate: config.autoCreate ?? process.env.SEARXNG_AUTO_CREATE !== '0',
    image: config.image ?? process.env.SEARXNG_IMAGE ?? SEARXNG_DEFAULT_IMAGE,
    port: Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536
      ? port as number
      : SEARXNG_DEFAULT_PORT,
    dataDir: process.env.SEARXNG_DATA_DIR
      ?? `${process.env.HOME ?? '~'}/${SEARXNG_DEFAULT_DATA_DIR}`,
  }
}

/**
 * True when `baseURL` names this host. Autostart only manages loopback
 * instances — starting a local container can never fix a remote base.
 * @param baseURL - the configured SearXNG base.
 * @returns whether on-demand start applies.
 */
export function isLocalBaseURL(baseURL: string): boolean {
  let hostname = ''
  try {
    hostname = new URL(baseURL).hostname
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/** Minimal `WebError` stand-in: the seam and tool pipeline route on `code`. */
export class SearxngError extends Error {
  /** Machine-routable code (`WEB_ABORTED`, `WEB_PROVIDER_ERROR`). */
  readonly code: string
  /**
   * @param message - human-readable failure.
   * @param code - machine-routable code.
   * @param options - optional `{ cause }` chain.
   */
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SearxngError'
    this.code = code
  }
}

/** One entry of SearXNG's flat `results[]` (JSON format). */
export interface SearxngResult {
  url?: string
  title?: string
  content?: string
  publishedDate?: string | null
}

/** SearXNG's JSON search response envelope. */
export interface SearxngResponse {
  results?: SearxngResult[]
}

/**
 * Map one SearXNG result to a normalized source. Entries without a usable
 * URL are dropped; `content` (the engine excerpt) becomes `snippet`.
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  const url = result.url?.trim()
  if (url === undefined || url.length === 0) return undefined
  const title = result.title?.trim()
  const snippet = result.content?.trim()
  const publishedAt = typeof result.publishedDate === 'string' && result.publishedDate.length > 0
    ? result.publishedDate
    : undefined
  return {
    url,
    ...title !== undefined && title.length > 0 ? { title } : {},
    ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a SearXNG JSON envelope to a normalized search result. The seam owns
 * the final `maxResults` truncation, so `truncated` is always `false` here.
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result; URL-less entries are dropped.
 */
export function mapSearxngResponse(response: SearxngResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

const execFileAsync = promisify(execFile)

/** Throw the provider's stable cancellation error when the caller aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: signal.reason })
  }
}

/** True for a failed spawn of a missing executable (CLI not installed). */
function isEnoentCli(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** True when a `start`/`inspect` failure means the container does not exist. */
function isMissingContainer(error: unknown): boolean {
  const stderr = typeof error === 'object' && error !== null
    ? String((error as { stderr?: unknown }).stderr ?? (error as { message?: unknown }).message ?? error)
    : String(error)
  return /no such container|no container with name/i.test(stderr)
}

/**
 * Probe instance readiness without touching search state.
 * @param baseURL - the SearXNG base.
 * @param signal - caller cancellation, also bounding the probe.
 * @returns true when `/healthz` answers 2xx.
 */
async function probeSearxng(baseURL: string, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(3_000)
  try {
    const response = await fetch(`${baseURL}/healthz`, {
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Sleep that rejects with the stable cancellation error on caller abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: signal.reason }))
    }, { once: true })
  })
}

/**
 * Write the minimal `settings.yml` (secret + `json` format) when absent, then
 * `run` the container. Mirrors `searxng-podman.sh`; kept here so a new system
 * needs no manual setup step.
 */
async function createContainer(
  cli: string,
  options: EnsureSearxngOptions,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(join(options.dataDir, 'settings'), { recursive: true })
  mkdirSync(join(options.dataDir, 'data'), { recursive: true })
  const settingsPath = join(options.dataDir, 'settings', 'settings.yml')
  let hasSettings = false
  try {
    hasSettings = readFileSync(settingsPath, 'utf8').length > 0
  } catch {
    hasSettings = false
  }
  if (!hasSettings) {
    const secret = process.env.SEARXNG_SECRET ?? randomBytes(32).toString('hex')
    writeFileSync(settingsPath,
      '# Minimal SearXNG settings for local harness use (written by dsh-searxng-search).\n'
      + '# Full reference: https://docs.searxng.org/admin/settings/settings.html\n'
      + 'use_default_settings: true\n'
      + 'server:\n'
      + `  secret_key: "${secret}"\n`
      + '  limiter: false\n'
      + '  image_proxy: false\n'
      + 'search:\n'
      + '  formats:\n'
      + '    - html\n'
      + '    - json\n')
  }
  try {
    await execFileAsync(cli, [
      'run', '-d', '--name', options.containerName, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${options.port}:8080`,
      '-v', `${join(options.dataDir, 'settings')}:/etc/searxng:z`,
      '-v', `${join(options.dataDir, 'data')}:/var/cache/searxng:z`,
      '-e', `BASE_URL=http://127.0.0.1:${options.port}/`,
      options.image,
    ], { signal })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new SearxngError(
      `SearXNG container "${options.containerName}" failed to create`
      + ` (image pull of ${options.image} may need network): ${String(error)}`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
}

/**
 * Run `<cli> start <container>`, trying the alternate CLI when the preferred
 * one is not installed. A container that exists but fails to start keeps its
 * stderr; a missing container is created (or names the setup script when
 * `autoCreate` is off).
 */
async function startContainer(
  options: EnsureSearxngOptions,
  signal?: AbortSignal,
): Promise<{ cli: string }> {
  const clis = options.containerCLI === 'docker' ? ['docker', 'podman'] : ['podman', 'docker']
  let lastError: unknown
  for (const cli of clis) {
    try {
      await execFileAsync(cli, ['start', options.containerName], { signal })
      return { cli }
    } catch (error: unknown) {
      throwIfAborted(signal)
      lastError = error
      // A missing CLI binary is an environment problem on this rung — try the
      // alternate CLI before giving up.
      if (isEnoentCli(error)) continue
      const exists = isMissingContainer(error)
        ? false
        : await execFileAsync(cli, ['inspect', options.containerName], { signal })
          .then(() => true, () => false)
      if (!exists) {
        if (!options.autoCreate) {
          throw new SearxngError(
            `SearXNG container "${options.containerName}" does not exist; create it with searxng-podman.sh`,
            'WEB_PROVIDER_ERROR',
            { cause: error },
          )
        }
        await createContainer(cli, options, signal)
        return { cli }
      }
      throw new SearxngError(
        `SearXNG container "${options.containerName}" failed to start: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
  throw new SearxngError(
    'SearXNG autostart needs `podman` or `docker`, neither is installed',
    'WEB_PROVIDER_ERROR',
    { cause: lastError },
  )
}

/**
 * One autostart attempt: probe, start a loopback container when down, poll
 * readiness inside the budget.
 */
async function ensureSearxngOnce(
  baseURL: string,
  options: EnsureSearxngOptions,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  if (await probeSearxng(baseURL, signal)) return
  throwIfAborted(signal)
  if (!isLocalBaseURL(baseURL)) {
    throw new SearxngError(
      `SearXNG at ${baseURL} is unreachable; autostart only manages loopback instances`,
      'WEB_PROVIDER_ERROR',
    )
  }
  await startContainer(options, signal)
  const deadline = Date.now() + options.startTimeoutMs
  for (;;) {
    throwIfAborted(signal)
    if (await probeSearxng(baseURL, signal)) return
    if (Date.now() >= deadline) {
      throw new SearxngError(
        `SearXNG container "${options.containerName}" did not answer ${baseURL}/healthz`
        + ` within ${options.startTimeoutMs}ms; check \`podman logs ${options.containerName}\``,
        'WEB_PROVIDER_ERROR',
      )
    }
    await sleep(2_000, signal)
  }
}

/** In-flight starts, shared so concurrent searches start the container once. */
const inflightStarts = new Map<string, Promise<void>>()

/**
 * Ensure the instance answers before a search. Concurrent callers share one
 * attempt; a settled attempt is forgotten so the next search re-probes.
 * @param baseURL - the SearXNG base.
 * @param options - resolved autostart options.
 * @param signal - caller cancellation forwarded to start and polling.
 * @returns resolves when `/healthz` answers.
 */
export function ensureSearxng(
  baseURL: string,
  options: EnsureSearxngOptions,
  signal?: AbortSignal,
): Promise<void> {
  const key = `${baseURL}|${options.containerCLI}|${options.containerName}`
  const existing = inflightStarts.get(key)
  if (existing !== undefined) return existing
  const task = ensureSearxngOnce(baseURL, options, signal).finally(() => {
    if (inflightStarts.get(key) === task) inflightStarts.delete(key)
  })
  inflightStarts.set(key, task)
  return task
}

/**
 * Register the SearXNG search provider with `ctx.web`.
 * @param ctx - plugin context; `ctx.web` must be mounted.
 * @param config - optional base URL and autostart overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const baseURL = (config.baseURL ?? process.env.SEARXNG_BASE_URL ?? SEARXNG_DEFAULT_BASE_URL).replace(/\/+$/u, '')
  const ensureOptions = resolveEnsureOptions(config)
  // Fire-and-forget warmup so the container is usually hot by the first
  // search. A failed warmup never fails boot; the search re-attempts it.
  ensureSearxng(baseURL, ensureOptions).catch((error: unknown) => {
    console.warn(`[web-search-searxng] autostart warmup: ${error instanceof Error ? error.message : String(error)}`)
  })
  ctx.web.registerSearchProvider({
    id: SEARXNG_PROVIDER_ID,
    available(): boolean {
      return URL.canParse(baseURL)
    },
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      await ensureSearxng(baseURL, ensureOptions, signal)
      const params = new URLSearchParams({ q: request.query, format: 'json' })
      const endpoint = `${baseURL}/search?${params.toString()}`
      let response: Response
      try {
        response = await fetch(endpoint, {
          headers: { accept: 'application/json', 'user-agent': 'deepseek-harness/0.0.1' },
          redirect: 'error',
          ...signal !== undefined ? { signal } : {},
        })
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        }
        throw new SearxngError(
          `SearXNG search request failed: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
      if (!response.ok) {
        throw new SearxngError(
          response.status === 403
            ? 'SearXNG API error (HTTP 403): enable the json format in settings.yml (search.formats)'
            : `SearXNG API error (HTTP ${response.status})`,
          'WEB_PROVIDER_ERROR',
        )
      }
      try {
        return mapSearxngResponse(await response.json() as SearxngResponse)
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        }
        throw new SearxngError(
          `SearXNG returned an unprocessable response body: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    },
  })
}

// ponytail: one runnable check for the mapping logic (a branch = non-trivial).
// Run: `node --experimental-strip-types plugins/searxng-search/selfcheck.ts`
// (kept out of index.ts so the plugin file stays load-only).
