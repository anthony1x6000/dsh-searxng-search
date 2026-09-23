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
import type { Context } from '@deepseek-ai/cordis';
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "web-search-searxng";
/** The web seam this provider registers into. */
export declare const inject: string[];
/** Stable id this provider registers under. */
export declare const SEARXNG_PROVIDER_ID = "searxng-local";
/** Default local SearXNG base (no trailing path; `/search` is appended). */
export declare const SEARXNG_DEFAULT_BASE_URL = "http://127.0.0.1:8888";
/** Default container name started on demand for loopback bases. */
export declare const SEARXNG_DEFAULT_CONTAINER = "searxng";
/** Default container CLI; `docker` is tried when `podman` is not installed. */
export declare const SEARXNG_DEFAULT_CLI = "podman";
/** Default budget for on-demand start + readiness (ms). */
export declare const SEARXNG_DEFAULT_START_TIMEOUT_MS = 60000;
/** Default container image pulled on first use. */
export declare const SEARXNG_DEFAULT_IMAGE = "docker.io/searxng/searxng:latest";
/** Default host port the container binds (loopback only). */
export declare const SEARXNG_DEFAULT_PORT = 8888;
/** Default data dir holding `settings/settings.yml` and the image cache. */
export declare const SEARXNG_DEFAULT_DATA_DIR = ".local/share/searxng";
/** Plugin config: every field optional, env fills the gaps. */
export interface Config {
    /** SearXNG base URL. Falls back to `$SEARXNG_BASE_URL`, then localhost. */
    baseURL?: string;
    /** Container started on demand. Falls back to `$SEARXNG_CONTAINER`, default `searxng`. */
    containerName?: string;
    /** Container CLI. Falls back to `$SEARXNG_CLI`, default `podman` (with `docker` fallback). */
    containerCLI?: string;
    /** Budget for on-demand start + readiness. Falls back to `$SEARXNG_START_TIMEOUT_MS`, default 60000. */
    startTimeoutMs?: number;
    /** Create the container when missing (first boot on a new system). Default true. */
    autoCreate?: boolean;
    /** Image pulled on first creation. Falls back to `$SEARXNG_IMAGE`, default docker.io latest. */
    image?: string;
    /** Host port the container binds. Falls back to `$SEARXNG_PORT`, default 8888. */
    port?: number;
}
/** Resolved on-demand-start options (env and constant defaults applied). */
export interface EnsureSearxngOptions {
    /** Container started on demand. */
    containerName: string;
    /** Preferred container CLI. */
    containerCLI: string;
    /** Budget for start + readiness (ms). */
    startTimeoutMs: number;
    /** Create the container when missing (first boot on a new system). */
    autoCreate: boolean;
    /** Image pulled on first creation. */
    image: string;
    /** Host port the container binds. */
    port: number;
    /** Data dir holding `settings/settings.yml` and the image cache. */
    dataDir: string;
}
/**
 * Project one config section into the options the on-demand start uses.
 * @param config - the currently authoritative section.
 * @returns options with every value fully defaulted.
 */
export declare function resolveEnsureOptions(config?: Config): EnsureSearxngOptions;
/**
 * True when `baseURL` names this host. Autostart only manages loopback
 * instances — starting a local container can never fix a remote base.
 * @param baseURL - the configured SearXNG base.
 * @returns whether on-demand start applies.
 */
export declare function isLocalBaseURL(baseURL: string): boolean;
/** Minimal `WebError` stand-in: the seam and tool pipeline route on `code`. */
export declare class SearxngError extends Error {
    /** Machine-routable code (`WEB_ABORTED`, `WEB_PROVIDER_ERROR`). */
    readonly code: string;
    /**
     * @param message - human-readable failure.
     * @param code - machine-routable code.
     * @param options - optional `{ cause }` chain.
     */
    constructor(message: string, code: string, options?: {
        cause?: unknown;
    });
}
/** One entry of SearXNG's flat `results[]` (JSON format). */
export interface SearxngResult {
    url?: string;
    title?: string;
    content?: string;
    publishedDate?: string | null;
}
/** SearXNG's JSON search response envelope. */
export interface SearxngResponse {
    results?: SearxngResult[];
}
/**
 * Map one SearXNG result to a normalized source. Entries without a usable
 * URL are dropped; `content` (the engine excerpt) becomes `snippet`.
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export declare function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined;
/**
 * Map a SearXNG JSON envelope to a normalized search result. The seam owns
 * the final `maxResults` truncation, so `truncated` is always `false` here.
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result; URL-less entries are dropped.
 */
export declare function mapSearxngResponse(response: SearxngResponse): WebSearchResult;
/**
 * Ensure the instance answers before a search. Concurrent callers share one
 * attempt; a settled attempt is forgotten so the next search re-probes.
 * @param baseURL - the SearXNG base.
 * @param options - resolved autostart options.
 * @param signal - caller cancellation forwarded to start and polling.
 * @returns resolves when `/healthz` answers.
 */
export declare function ensureSearxng(baseURL: string, options: EnsureSearxngOptions, signal?: AbortSignal): Promise<void>;
/**
 * Register the SearXNG search provider with `ctx.web`.
 * @param ctx - plugin context; `ctx.web` must be mounted.
 * @param config - optional base URL and autostart overrides.
 */
export declare function apply(ctx: Context, config?: Config): void;
