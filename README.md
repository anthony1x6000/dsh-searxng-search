# dsh-searxng-search

Keyless `web_search` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via a self-hosted [SearXNG](https://docs.searxng.org/) instance. A thin `ctx.web` provider (`searxng-local`) plus on-demand `podman start` — no API key, no MCP hop.

## Install

```sh
sudo apt update && sudo apt install -y podman
```

```sh
git clone https://github.com/anthony1x6000/dsh-searxng-search.git ~/.dsh/plugins/searxng-search && node -e '
const fs = require("fs"), path = require("path");
const p = path.join(process.env.HOME, ".dsh/profiles/web/cordis.patch.yml");
fs.mkdirSync(path.dirname(p), { recursive: true });
let c = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const entry = "    - id: web-search-searxng\n      name: '\''" + path.join(process.env.HOME, ".dsh/plugins/searxng-search/index.ts") + "'\''\n";
if (!c.includes("id: web-search-searxng")) {
  c = c.replace(/^\[\]\s*$/m, "");
  c = c.includes("- insert:\n") ? c.replace("- insert:\n", "- insert:\n" + entry) : (c.trim() ? c.trim() + "\n" : "") + "- insert:\n" + entry;
}
if (!c.includes("searchProvider: searxng-local")) {
  if (!c.endsWith("\n")) c += "\n";
  c += "- id: web\n  config:\n    searchProvider: searxng-local\n    fetchProvider: http\n";
}
fs.writeFileSync(p, c);
'
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
