# dsh-searxng-search

Keyless `web_search` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via a self-hosted [SearXNG](https://docs.searxng.org/) instance. A thin `ctx.web` provider (`searxng-local`) plus on-demand `podman start` — no API key, no MCP hop.

## Install

One-liner for `podman`:

```sh
sudo apt update && sudo apt install -y podman
```

One-liner for the plugin (clone + patch the `web` profile: registers `searxng-local` and pins it as the search provider):

```sh
git clone https://github.com/anthony1x6000/dsh-searxng-search.git ~/.dsh/plugins/searxng-search && mkdir -p ~/.dsh/profiles/web && touch ~/.dsh/profiles/web/cordis.patch.yml && sed -i '/^\[\][[:space:]]*$/d' ~/.dsh/profiles/web/cordis.patch.yml && { grep -q 'id: web-search-searxng' ~/.dsh/profiles/web/cordis.patch.yml || printf -- "- insert:\n    - id: web-search-searxng\n      name: '%s/.dsh/plugins/searxng-search/index.ts'\n" "$HOME" >> ~/.dsh/profiles/web/cordis.patch.yml; } && { grep -q 'searchProvider: searxng-local' ~/.dsh/profiles/web/cordis.patch.yml || printf -- "- id: web\n  config:\n    searchProvider: searxng-local\n    fetchProvider: http\n" >> ~/.dsh/profiles/web/cordis.patch.yml; }
```

Then just `dsh web`. First search creates the container if missing (~1–2 min for the image pull), later ones start it on demand after reboots. Repeat for `headless` profile if you use it (swap `web` with `headless` in the path). The installer pins `searchProvider: searxng-local` because the base bundle defaults to `deepseek-official` (hosted API, needs a key) — without the pin, searches never reach your local instance. To go back to hosted search, drop the `- id: web` block from the patch file.

## Files

| File | Role |
|---|---|
| `index.ts` | The plugin: `WebSearchProvider` over `GET {base}/search?format=json`, on-demand `podman start` for loopback bases |
| `cordis.patch.yml` | `--patch` overlay (relative entry + `searxng-local` provider pin, no install) |
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
