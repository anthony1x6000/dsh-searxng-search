# dsh-searxng-search

[![ci](https://github.com/anthony1x6000/dsh-searxng-search/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-searxng-search/actions/workflows/ci.yml)

Keyless `web_search` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via a self-hosted [SearXNG](https://docs.searxng.org/) instance. A thin `ctx.web` provider (`searxng-local`) plus on-demand `podman start` — no API key, no MCP hop.

## Install

One-liner for `podman` (system dependency, outside pnpm):

```sh
sudo apt update && sudo apt install -y podman
```

Install the bundle into your `web` profile (pnpm only — no profile hand-editing):

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-searxng-search#main"
```

Verify the layer without booting:

```sh
dsh --profile web --dump-config | grep -B 1 -A 4 searxng
```

Then restart `dsh web` for the new bundle layer to take effect. The first search creates the container if missing (~1–2 min for the image pull), later ones start it on demand after reboots.

The bundle pins `searchProvider: searxng-local` in its own layer because the base bundle defaults to `deepseek-official` (hosted API, needs a key) — without the pin, searches never reach your local instance. Your profile patch can still override it. To go back to hosted search, `dsh plugin --profile web remove dsh-searxng-search` (then restart) and the layer — pin included — is gone.

Local development: `pnpm install && pnpm build`, then `dsh plugin --profile web add link:/path/to/dsh-searxng-search`.

## Files

| File | Role |
|---|---|
| `index.ts` | The plugin source: `WebSearchProvider` over `GET {base}/search?format=json`, on-demand `podman start` for loopback bases |
| `lib/index.js` | Built artifact (`pnpm build`), committed — what installed profiles actually load |
| `package.json` | Bundle manifest (`dsh.bundle.patch`); build-only devDeps, zero runtime deps |
| `cordis.patch.yml` | Bundle layer: package-name entry + `searxng-local` provider pin |
| `searxng-podman.sh` | One-shot SearXNG setup: `settings.yml` (secret + `json` format), container run, health check |
| `selfcheck.ts` | Mapping + URL-gating + packaging asserts: `pnpm selfcheck` |

## Config

| Env / row field | Default | Meaning |
|---|---|---|
| `SEARXNG_BASE_URL` / `baseURL` | `http://127.0.0.1:8888` | SearXNG base; `/search` is appended |
| `SEARXNG_CONTAINER` / `containerName` | `searxng` | Container started on demand |
| `SEARXNG_CLI` / `containerCLI` | `podman` | `podman`, `docker` tried as fallback |
| `SEARXNG_START_TIMEOUT_MS` / `startTimeoutMs` | `60000` | Start + readiness budget per search |
| `SEARXNG_AUTO_CREATE` / `autoCreate` | `true` | Create the container when missing (set `0`/`false` to start-only) |
| `SEARXNG_IMAGE` / `image` | `docker.io/searxng/searxng:latest` | Image pulled on first creation |
| `SEARXNG_PORT` / `port` | `8888` | Host port the container binds |

Autostart only manages loopback bases (`localhost`, `127.0.0.1`, `::1`); remote bases fail fast. Redirects are rejected (`redirect: 'error'`); SearXNG returns no generated answer, so results carry sources only.
