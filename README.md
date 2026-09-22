# dsh-searxng-search

Keyless `web_search` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via a self-hosted [SearXNG](https://docs.searxng.org/) instance. A thin `ctx.web` provider (`searxng-local`) plus on-demand `podman start` — no API key, no MCP hop.

## Install

```sh
# 1. Clone (private repo — you need access):
git clone https://github.com/anthony1x6000/dsh-searxng-search.git

# 2. Create + start the SearXNG container (podman preferred, docker fallback):
bash dsh-searxng-search/searxng-podman.sh

# 3. Boot dsh with the overlay (any profile):
SEARXNG_BASE_URL=http://127.0.0.1:8888 pnpm dsh web \
  --patch ./dsh-searxng-search/cordis.patch.yml
```

The container auto-starts on first search (and warms up at boot), so after step 2 you only need step 3 — including after a reboot. If DeepSeek search is also configured, pin the provider by adding `searchProvider: searxng-local` to the `dsh-web` row config.

To make it permanent, copy `cordis.patch.yml`'s two lines into your profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<name>/cordis.patch.yml`).

## Files

| File | Role |
|---|---|
| `index.ts` | The plugin: `WebSearchProvider` over `GET {base}/search?format=json`, on-demand `podman start` for loopback bases |
| `cordis.patch.yml` | `--patch` overlay (relative entry, no install) |
| `searxng-podman.sh` | One-shot SearXNG setup: `settings.yml` (secret + `json` format), container run, health check |
| `selfcheck.ts` | Mapping + URL-gating asserts: `node --experimental-strip-types selfcheck.ts` |

## Config

| Env / row field | Default | Meaning |
|---|---|---|
| `SEARXNG_BASE_URL` / `baseURL` | `http://127.0.0.1:8888` | SearXNG base; `/search` is appended |
| `SEARXNG_CONTAINER` / `containerName` | `searxng` | Container started on demand |
| `SEARXNG_CLI` / `containerCLI` | `podman` | `podman`, `docker` tried as fallback |
| `SEARXNG_START_TIMEOUT_MS` / `startTimeoutMs` | `60000` | Start + readiness budget per search |

Autostart only manages loopback bases (`localhost`, `127.0.0.1`, `::1`); remote bases fail fast. Redirects are rejected (`redirect: 'error'`); SearXNG returns no generated answer, so results carry sources only.
