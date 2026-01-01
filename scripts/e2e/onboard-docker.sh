#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="clawdis-onboard-e2e"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running onboarding E2E..."
docker run --rm -t "$IMAGE_NAME" bash -lc '
  set -euo pipefail

  node dist/index.js onboard \
    --non-interactive \
    --mode local \
    --workspace /root/clawd \
    --auth-choice skip \
    --gateway-port 18789 \
    --gateway-bind loopback \
    --gateway-auth off \
    --tailscale off \
    --skip-skills \
    --skip-health \
    --json

  node dist/index.js gateway-daemon --port 18789 --bind loopback > /tmp/gateway.log 2>&1 &
  GW_PID=$!
  sleep 2

  node dist/index.js health --timeout 2000 || (cat /tmp/gateway.log && exit 1)

  kill "$GW_PID"
  wait "$GW_PID" || true
'

echo "E2E complete."
