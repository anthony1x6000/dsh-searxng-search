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
 * Container start/creation runs inside a transient per-container `systemd
 * --user` scope, so the `conmon`/`pasta` helpers that actually own the loopback
 * port-forward are siblings of the caller rather than children of it. Without
 * that, a container started from inside `dsh-web.service` inherits its cgroup;
 * the default `KillMode=control-group` restart then SIGKILLs those helpers and
 * leaves SearXNG running but unreachable — `web_search` reports the provider
 * down while `podman ps` still shows the container `Up`. Set `SEARXNG_DETACH=0`
 * to opt out where no user systemd manager is reachable.
 *
 * SearXNG must enable the `json` format (`search.formats`, default on; a
 * disabled format answers 403).
 *
 * @module searxng-search-plugin
 */
// Type-only Cordis/web imports: erased at load, so this file runs straight
// from a profile patch through the CLI tsx loader with no package install.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng';
/** The web seam this provider registers into. */
export const inject = ['web'];
/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng-local';
/** Default local SearXNG base (no trailing path; `/search` is appended). */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8888';
/** Default container name started on demand for loopback bases. */
export const SEARXNG_DEFAULT_CONTAINER = 'searxng';
/** Default container CLI; `docker` is tried when `podman` is not installed. */
export const SEARXNG_DEFAULT_CLI = 'podman';
/** Default budget for on-demand start + readiness (ms). */
export const SEARXNG_DEFAULT_START_TIMEOUT_MS = 60_000;
/** Default container image pulled on first use. */
export const SEARXNG_DEFAULT_IMAGE = 'docker.io/searxng/searxng:latest';
/** Default host port the container binds (loopback only). */
export const SEARXNG_DEFAULT_PORT = 8888;
/** Default data dir holding `settings/settings.yml` and the image cache. */
export const SEARXNG_DEFAULT_DATA_DIR = '.local/share/searxng';
/** Default: run container start in a transient `systemd --user` scope (see `detach`). */
export const SEARXNG_DEFAULT_DETACH = true;
/**
 * Project one config section into the options the on-demand start uses.
 * @param config - the currently authoritative section.
 * @returns options with every value fully defaulted.
 */
export function resolveEnsureOptions(config = {}) {
    const startTimeoutMs = config.startTimeoutMs
        ?? Number(process.env.SEARXNG_START_TIMEOUT_MS ?? SEARXNG_DEFAULT_START_TIMEOUT_MS);
    const port = config.port ?? Number(process.env.SEARXNG_PORT ?? SEARXNG_DEFAULT_PORT);
    return {
        containerName: config.containerName ?? process.env.SEARXNG_CONTAINER ?? SEARXNG_DEFAULT_CONTAINER,
        containerCLI: config.containerCLI ?? process.env.SEARXNG_CLI ?? SEARXNG_DEFAULT_CLI,
        startTimeoutMs: Number.isInteger(startTimeoutMs) && startTimeoutMs > 0
            ? startTimeoutMs
            : SEARXNG_DEFAULT_START_TIMEOUT_MS,
        autoCreate: config.autoCreate ?? process.env.SEARXNG_AUTO_CREATE !== '0',
        image: config.image ?? process.env.SEARXNG_IMAGE ?? SEARXNG_DEFAULT_IMAGE,
        port: Number.isInteger(port) && port > 0 && port < 65536
            ? port
            : SEARXNG_DEFAULT_PORT,
        dataDir: process.env.SEARXNG_DATA_DIR
            ?? `${process.env.HOME ?? '~'}/${SEARXNG_DEFAULT_DATA_DIR}`,
        detach: config.detach ?? process.env.SEARXNG_DETACH !== '0',
    };
}
/**
 * True when `baseURL` names this host. Autostart only manages loopback
 * instances — starting a local container can never fix a remote base.
 * @param baseURL - the configured SearXNG base.
 * @returns whether on-demand start applies.
 */
export function isLocalBaseURL(baseURL) {
    let hostname = '';
    try {
        hostname = new URL(baseURL).hostname;
    }
    catch {
        return false;
    }
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
/** Minimal `WebError` stand-in: the seam and tool pipeline route on `code`. */
export class SearxngError extends Error {
    /** Machine-routable code (`WEB_ABORTED`, `WEB_PROVIDER_ERROR`). */
    code;
    /**
     * @param message - human-readable failure.
     * @param code - machine-routable code.
     * @param options - optional `{ cause }` chain.
     */
    constructor(message, code, options) {
        super(message, options);
        this.name = 'SearxngError';
        this.code = code;
    }
}
/**
 * Map one SearXNG result to a normalized source. Entries without a usable
 * URL are dropped; `content` (the engine excerpt) becomes `snippet`.
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearxngResult(result) {
    const url = result.url?.trim();
    if (url === undefined || url.length === 0)
        return undefined;
    const title = result.title?.trim();
    const snippet = result.content?.trim();
    const publishedAt = typeof result.publishedDate === 'string' && result.publishedDate.length > 0
        ? result.publishedDate
        : undefined;
    return {
        url,
        ...title !== undefined && title.length > 0 ? { title } : {},
        ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
        ...publishedAt !== undefined ? { publishedAt } : {},
    };
}
/**
 * Map a SearXNG JSON envelope to a normalized search result. The seam owns
 * the final `maxResults` truncation, so `truncated` is always `false` here.
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result; URL-less entries are dropped.
 */
export function mapSearxngResponse(response) {
    const sources = (response.results ?? [])
        .map(mapSearxngResult)
        .filter((source) => source !== undefined);
    return { sources, truncated: false };
}
const execFileAsync = promisify(execFile);
/** Throw the provider's stable cancellation error when the caller aborted. */
function throwIfAborted(signal) {
    if (signal?.aborted === true) {
        throw new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: signal.reason });
    }
}
/** True for a failed spawn of a missing executable (CLI not installed). */
function isEnoentCli(error) {
    return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
/** Collapse an exec failure into the stderr/message text callers match on. */
function errorText(error) {
    return typeof error === 'object' && error !== null
        ? String(error.stderr ?? error.message ?? error)
        : String(error);
}
/** True when a `start`/`inspect` failure means the container does not exist. */
function isMissingContainer(error) {
    return /no such container|no container with name/i.test(errorText(error));
}
/**
 * Transient scope unit that owns one container's start. The `.scope` suffix is
 * required; characters outside systemd's safe set become `-`.
 * @param containerName - the container the scope starts.
 * @returns a deterministic unit name (`dsh-searxng-<container>.scope`).
 */
export function searxngScopeUnit(containerName) {
    const safe = containerName.replace(/[^A-Za-z0-9_.-]/gu, '-').replace(/^-+/u, '');
    return `dsh-searxng-${safe.length > 0 ? safe : 'searxng'}.scope`;
}
/** True when `systemd-run` refused because this container's scope is already live. */
function isScopeAlreadyLive(error) {
    return /already loaded or has a fragment file|already exists/iu.test(errorText(error));
}
/**
 * True when `systemd-run` itself is unusable (no binary, or no user systemd
 * manager on the bus). Failures of the wrapped CLI are relayed verbatim and
 * must stay visible, so they are deliberately not matched here.
 */
function isDetachUnavailable(error) {
    if (isEnoentCli(error))
        return true;
    return /failed to connect to bus|failed to connect to socket|failed to create bus connection|not booted with systemd/iu
        .test(errorText(error));
}
/**
 * Run a container-mutating CLI call so the helpers it spawns (`conmon`,
 * `pasta`, which own the loopback port-forward) live outside the caller's
 * cgroup. A transient `systemd --user` scope is a sibling of `dsh-web.service`,
 * so restarting that service can no longer strand a running-but-unreachable
 * container. Without a reachable user manager the call runs directly — the
 * pre-fix behaviour — with a one-line warning.
 * @param cli - `podman` or `docker`.
 * @param args - the CLI arguments (at least the subcommand).
 * @param options - resolved autostart options; `detach` gates the wrapper.
 * @param signal - caller cancellation forwarded to the CLI.
 */
async function execContainerCli(cli, args, options, signal) {
    if (options.detach) {
        try {
            await execFileAsync('systemd-run', [
                '--user', '--scope', '--collect', '--quiet',
                '--unit', searxngScopeUnit(options.containerName),
                cli, ...args,
            ], { signal });
            return;
        }
        catch (error) {
            throwIfAborted(signal);
            // The scope is already live: a start is in flight (or the container is
            // up); the readiness poll in the caller decides.
            if (isScopeAlreadyLive(error))
                return;
            if (!isDetachUnavailable(error))
                throw error;
            console.warn(`[web-search-searxng] systemd-run unavailable; running \`${cli} ${args[0] ?? ''}\``
                + ` in the caller's cgroup: ${errorText(error)}`);
        }
    }
    await execFileAsync(cli, args, { signal });
}
/**
 * Probe instance readiness without touching search state.
 * @param baseURL - the SearXNG base.
 * @param signal - caller cancellation, also bounding the probe.
 * @returns true when `/healthz` answers 2xx.
 */
async function probeSearxng(baseURL, signal) {
    const timeout = AbortSignal.timeout(3_000);
    try {
        const response = await fetch(`${baseURL}/healthz`, {
            signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
/** Sleep that rejects with the stable cancellation error on caller abort. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: signal.reason }));
        }, { once: true });
    });
}
/**
 * Write the minimal `settings.yml` (secret + `json` format) when absent, then
 * `run` the container. Mirrors `searxng-podman.sh`; kept here so a new system
 * needs no manual setup step.
 */
async function createContainer(cli, options, signal) {
    mkdirSync(join(options.dataDir, 'settings'), { recursive: true });
    mkdirSync(join(options.dataDir, 'data'), { recursive: true });
    const settingsPath = join(options.dataDir, 'settings', 'settings.yml');
    let hasSettings = false;
    try {
        hasSettings = readFileSync(settingsPath, 'utf8').length > 0;
    }
    catch {
        hasSettings = false;
    }
    if (!hasSettings) {
        const secret = process.env.SEARXNG_SECRET ?? randomBytes(32).toString('hex');
        writeFileSync(settingsPath, '# Minimal SearXNG settings for local harness use (written by dsh-searxng-search).\n'
            + '# Full reference: https://docs.searxng.org/admin/settings/settings.html\n'
            + 'use_default_settings: true\n'
            + 'server:\n'
            + `  secret_key: "${secret}"\n`
            + '  limiter: false\n'
            + '  image_proxy: false\n'
            + 'search:\n'
            + '  formats:\n'
            + '    - html\n'
            + '    - json\n');
    }
    try {
        await execContainerCli(cli, [
            'run', '-d', '--name', options.containerName, '--restart', 'unless-stopped',
            '-p', `127.0.0.1:${options.port}:8080`,
            '-v', `${join(options.dataDir, 'settings')}:/etc/searxng:z`,
            '-v', `${join(options.dataDir, 'data')}:/var/cache/searxng:z`,
            '-e', `BASE_URL=http://127.0.0.1:${options.port}/`,
            options.image,
        ], options, signal);
    }
    catch (error) {
        throwIfAborted(signal);
        throw new SearxngError(`SearXNG container "${options.containerName}" failed to create`
            + ` (image pull of ${options.image} may need network): ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
    }
}
/**
 * Run `<cli> start <container>`, trying the alternate CLI when the preferred
 * one is not installed. A container that exists but fails to start keeps its
 * stderr; a missing container is created (or names the setup script when
 * `autoCreate` is off).
 */
async function startContainer(options, signal) {
    const clis = options.containerCLI === 'docker' ? ['docker', 'podman'] : ['podman', 'docker'];
    let lastError;
    for (const cli of clis) {
        try {
            await execContainerCli(cli, ['start', options.containerName], options, signal);
            return { cli };
        }
        catch (error) {
            throwIfAborted(signal);
            lastError = error;
            // A missing CLI binary is an environment problem on this rung — try the
            // alternate CLI before giving up.
            if (isEnoentCli(error))
                continue;
            const exists = isMissingContainer(error)
                ? false
                : await execFileAsync(cli, ['inspect', options.containerName], { signal })
                    .then(() => true, () => false);
            if (!exists) {
                if (!options.autoCreate) {
                    throw new SearxngError(`SearXNG container "${options.containerName}" does not exist; create it with searxng-podman.sh`, 'WEB_PROVIDER_ERROR', { cause: error });
                }
                await createContainer(cli, options, signal);
                return { cli };
            }
            throw new SearxngError(`SearXNG container "${options.containerName}" failed to start: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
    }
    throw new SearxngError('SearXNG autostart needs `podman` or `docker`, neither is installed', 'WEB_PROVIDER_ERROR', { cause: lastError });
}
/**
 * One autostart attempt: probe, start a loopback container when down, poll
 * readiness inside the budget.
 */
async function ensureSearxngOnce(baseURL, options, signal) {
    throwIfAborted(signal);
    if (await probeSearxng(baseURL, signal))
        return;
    throwIfAborted(signal);
    if (!isLocalBaseURL(baseURL)) {
        throw new SearxngError(`SearXNG at ${baseURL} is unreachable; autostart only manages loopback instances`, 'WEB_PROVIDER_ERROR');
    }
    await startContainer(options, signal);
    const deadline = Date.now() + options.startTimeoutMs;
    for (;;) {
        throwIfAborted(signal);
        if (await probeSearxng(baseURL, signal))
            return;
        if (Date.now() >= deadline) {
            throw new SearxngError(`SearXNG container "${options.containerName}" did not answer ${baseURL}/healthz`
                + ` within ${options.startTimeoutMs}ms; check \`podman logs ${options.containerName}\``, 'WEB_PROVIDER_ERROR');
        }
        await sleep(2_000, signal);
    }
}
/** In-flight starts, shared so concurrent searches start the container once. */
const inflightStarts = new Map();
/**
 * Ensure the instance answers before a search. Concurrent callers share one
 * attempt; a settled attempt is forgotten so the next search re-probes.
 * @param baseURL - the SearXNG base.
 * @param options - resolved autostart options.
 * @param signal - caller cancellation forwarded to start and polling.
 * @returns resolves when `/healthz` answers.
 */
export function ensureSearxng(baseURL, options, signal) {
    const key = `${baseURL}|${options.containerCLI}|${options.containerName}`;
    const existing = inflightStarts.get(key);
    if (existing !== undefined)
        return existing;
    const task = ensureSearxngOnce(baseURL, options, signal).finally(() => {
        if (inflightStarts.get(key) === task)
            inflightStarts.delete(key);
    });
    inflightStarts.set(key, task);
    return task;
}
/**
 * Register the SearXNG search provider with `ctx.web`.
 * @param ctx - plugin context; `ctx.web` must be mounted.
 * @param config - optional base URL and autostart overrides.
 */
export function apply(ctx, config = {}) {
    const baseURL = (config.baseURL ?? process.env.SEARXNG_BASE_URL ?? SEARXNG_DEFAULT_BASE_URL).replace(/\/+$/u, '');
    const ensureOptions = resolveEnsureOptions(config);
    // Fire-and-forget warmup so the container is usually hot by the first
    // search. A failed warmup never fails boot; the search re-attempts it.
    ensureSearxng(baseURL, ensureOptions).catch((error) => {
        console.warn(`[web-search-searxng] autostart warmup: ${error instanceof Error ? error.message : String(error)}`);
    });
    ctx.web.registerSearchProvider({
        id: SEARXNG_PROVIDER_ID,
        available() {
            return URL.canParse(baseURL);
        },
        async search(request, signal) {
            await ensureSearxng(baseURL, ensureOptions, signal);
            const params = new URLSearchParams({ q: request.query, format: 'json' });
            const endpoint = `${baseURL}/search?${params.toString()}`;
            let response;
            try {
                response = await fetch(endpoint, {
                    headers: { accept: 'application/json', 'user-agent': 'deepseek-harness/0.0.1' },
                    redirect: 'error',
                    ...signal !== undefined ? { signal } : {},
                });
            }
            catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    throw new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: error });
                }
                throw new SearxngError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
            }
            if (!response.ok) {
                throw new SearxngError(response.status === 403
                    ? 'SearXNG API error (HTTP 403): enable the json format in settings.yml (search.formats)'
                    : `SearXNG API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR');
            }
            try {
                return mapSearxngResponse(await response.json());
            }
            catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    throw new SearxngError('SearXNG search aborted', 'WEB_ABORTED', { cause: error });
                }
                throw new SearxngError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
            }
        },
    });
}
// ponytail: one runnable check for the mapping logic (a branch = non-trivial).
// Run: `node --experimental-strip-types plugins/searxng-search/selfcheck.ts`
// (kept out of index.ts so the plugin file stays load-only).
