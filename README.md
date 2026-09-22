# dsh-searxng-search

Keyless `web_search` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via a self-hosted [SearXNG](https://docs.searxng.org/) instance. A thin `ctx.web` provider (`searxng-local`) plus on-demand `podman start` — no API key, no MCP hop.

## Install

```sh
git clone https://github.com/anthony1x6000/dsh-searxng-search.git ~/.dsh/plugins/searxng-search
```

Append to `~/.dsh/profiles/web/cordis.patch.yml` (and `headless`, if you use it):

```yaml
- insert:
    - id: web-search-searxng
      name: '/home/USER/.dsh/plugins/searxng-search/index.ts'
```

Then just `dsh web`. First search creates the container if missing (~1–2 min for the image pull), later ones start it on demand after reboots. If DeepSeek search is also configured, pin this one by adding `searchProvider: searxng-local` to the `dsh-web` row config.

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
| `SEARXNG_AUTO_CREATE` / `autoCreate` | `true` | Create the container when missing (set `0`/`false` to start-only) |
| `SEARXNG_IMAGE` / `image` | `docker.io/searxng/searxng:latest` | Image pulled on first creation |
| `SEARXNG_PORT` / `port` | `8888` | Host port the container binds |

Autostart only manages loopback bases (`localhost`, `127.0.0.1`, `::1`); remote bases fail fast. Redirects are rejected (`redirect: 'error'`); SearXNG returns no generated answer, so results carry sources only.
