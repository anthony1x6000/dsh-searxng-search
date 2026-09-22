#!/usr/bin/env bash
# Spin up local SearXNG with podman (or docker — same flags) and verify the
# JSON API the harness plugin consumes.
# Run on your HOST (podman cannot run inside the DSH sandbox: mount/net
# namespaces are blocked there), from the repo root:
#   bash plugins/searxng-search/searxng-podman.sh
# Then: SEARXNG_BASE_URL=http://127.0.0.1:8888 pnpm dsh web \
#         --patch ./plugins/searxng-search/cordis.patch.yml
set -euo pipefail

CLI=podman
command -v podman >/dev/null 2>&1 || CLI=docker
PORT="${SEARXNG_PORT:-8888}"
NAME="${SEARXNG_NAME:-searxng}"
SECRET="${SEARXNG_SECRET:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"
DATA_DIR="${SEARXNG_DATA_DIR:-$HOME/.local/share/searxng}"

mkdir -p "$DATA_DIR/settings" "$DATA_DIR/data"
SETTINGS="$DATA_DIR/settings/settings.yml"

if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<EOF
# Minimal SearXNG settings for local harness use.
# Full reference: https://docs.searxng.org/admin/settings/settings.html
use_default_settings: true
server:
  secret_key: "$SECRET"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
EOF
  echo "wrote $SETTINGS"
else
  echo "keeping existing $SETTINGS"
fi

if $CLI container exists "$NAME" >/dev/null 2>&1; then
  $CLI start "$NAME"
else
  # Public images (Docker Hub rate-limits anon pulls; GHCR mirrors it):
  #   https://hub.docker.com/r/searxng/searxng  /  ghcr.io/searxng/searxng
  $CLI run -d --name "$NAME" --restart unless-stopped \
    -p "127.0.0.1:${PORT}:8080" \
    -v "$DATA_DIR/settings:/etc/searxng:z" \
    -v "$DATA_DIR/data:/var/cache/searxng:z" \
    -e "BASE_URL=http://127.0.0.1:${PORT}/" \
    docker.io/searxng/searxng:latest
fi

echo "waiting for SearXNG on http://127.0.0.1:${PORT} ..."
for _ in $(seq 1 30); do
  curl -fsS -m 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://127.0.0.1:${PORT}/search?q=hello&format=json" | head -c 400
echo
echo "up: SEARXNG_BASE_URL=http://127.0.0.1:${PORT}"
