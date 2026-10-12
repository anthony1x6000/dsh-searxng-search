# dsh-searxng-search

[![ci](https://github.com/anthony1x6000/dsh-searxng-search/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-searxng-search/actions/workflows/ci.yml)

Keyless `web_search` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via a self-hosted [SearXNG](https://docs.searxng.org/) instance. A thin `ctx.web` provider (`searxng-local`) plus on-demand `podman start` — no API key, no MCP hop. The start is detached into a transient systemd scope, so restarting `dsh-web` cannot kill the container's port-forward (see [why](#why-the-container-start-is-scoped)).

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

Then restart `dsh web` for the new bundle layer to take effect. Build artifacts (`lib/`) are committed, so installing from git runs no build and needs no pnpm `allowBuilds` approval. The first search creates the container if missing (~1–2 min for the image pull), later ones start it on demand after reboots.

### Why the container start is scoped

`podman run` / `podman start` inherit the cgroup of whoever invokes them. Installed as a bundle that caller is `dsh-web.service`, so the container's `conmon` and `pasta` — the processes that actually own the `127.0.0.1:8888` forward — end up inside that service's cgroup. A `systemctl --user restart dsh-web` then tears the cgroup down with the default `KillMode=control-group`: SearXNG keeps running, but nothing listens on the port any more, so `web_search` reports the provider down while `podman ps` still shows the container `Up`.

Every container-mutating CLI call is therefore wrapped in a transient per-container scope:

```sh
systemd-run --user --scope --collect --quiet --unit dsh-searxng-<container>.scope podman …
```

A scope is a *sibling* of `dsh-web.service` under `user@1000.service/app.slice`, so restarting DSH never touches it. Inspect it with `systemctl --user status dsh-searxng-searxng.scope`. Where no user systemd manager is reachable (macOS, a bare CI container, `systemd-run` missing) the plugin calls the CLI directly and logs a one-line warning; `SEARXNG_DETACH=0` forces that behaviour. `searxng-podman.sh` uses the same wrapper.

The bundle pins `searchProvider: searxng-local` in its own layer because the base bundle defaults to `deepseek-official` (hosted API, needs a key) — without the pin, searches never reach your local instance. Your profile patch can still override it. To go back to hosted search, `dsh plugin --profile web remove dsh-searxng-search` (then restart) and the layer — pin included — is gone.

Local development: `pnpm install && pnpm build`, then `dsh plugin --profile web add link:/path/to/dsh-searxng-search`.

## Files

| File | Role |
|---|---|
| `index.ts` | The plugin source: `WebSearchProvider` over `GET {base}/search?format=json`, on-demand `podman start` scoped out of the caller's cgroup |
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
| `SEARXNG_DETACH` / `detach` | `true` | Start the container in a transient `systemd --user` scope so it leaves the caller's cgroup (`0` calls the CLI directly) |

Autostart only manages loopback bases (`localhost`, `127.0.0.1`, `::1`); remote bases fail fast. Redirects are rejected (`redirect: 'error'`); SearXNG returns no generated answer, so results carry sources only.
