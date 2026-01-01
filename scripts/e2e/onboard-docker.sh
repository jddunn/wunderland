#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="clawdis-onboard-e2e"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running onboarding E2E..."
docker run --rm -t "$IMAGE_NAME" bash -lc '
  set -euo pipefail
  export TERM=xterm-256color

  input_fifo="$(mktemp -u /tmp/clawdis-onboard-input.XXXXXX)"
  mkfifo "$input_fifo"
  script -q -c "node dist/index.js onboard" /dev/null < "$input_fifo" &
  wizard_pid=$!
  exec 3> "$input_fifo"

  send() {
    local payload="$1"
    local delay="${2:-0.4}"
    sleep "$delay"
    printf "%b" "$payload" >&3
  }

  send $'"'"'\r'"'"' 0.8
  send $'"'"'\r'"'"' 0.6
  send $'"'"'\e[B\e[B\e[B\r'"'"' 0.6
  send $'"'"'\r'"'"' 0.4
  send $'"'"'\r'"'"' 0.4
  send $'"'"'\r'"'"' 0.4
  send $'"'"'\r'"'"' 0.4
  send $'"'"'n\r'"'"' 0.4
  send $'"'"'n\r'"'"' 0.4
  send $'"'"'n\r'"'"' 0.4

  exec 3>&-
  wait "$wizard_pid"
  rm -f "$input_fifo"

  workspace_dir="$HOME/clawd"
  config_path="$HOME/.clawdis/clawdis.json"
  sessions_dir="$HOME/.clawdis/sessions"

  if [ ! -f "$config_path" ]; then
    echo "Missing config: $config_path"
    exit 1
  fi

  for file in AGENTS.md BOOTSTRAP.md IDENTITY.md SOUL.md TOOLS.md USER.md; do
    if [ ! -f "$workspace_dir/$file" ]; then
      echo "Missing workspace file: $workspace_dir/$file"
      exit 1
    fi
  done

  if [ ! -d "$sessions_dir" ]; then
    echo "Missing sessions dir: $sessions_dir"
    exit 1
  fi

  CONFIG_PATH="$config_path" WORKSPACE_DIR="$workspace_dir" node --input-type=module - <<'"'"'NODE'"'"'
import fs from "node:fs";
import JSON5 from "json5";

const cfg = JSON5.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
const expectedWorkspace = process.env.WORKSPACE_DIR;
const errors = [];

if (cfg?.agent?.workspace !== expectedWorkspace) {
  errors.push(`agent.workspace mismatch (got ${cfg?.agent?.workspace ?? "unset"})`);
}
if (cfg?.gateway?.mode !== "local") {
  errors.push(`gateway.mode mismatch (got ${cfg?.gateway?.mode ?? "unset"})`);
}
if (cfg?.gateway?.bind !== "loopback") {
  errors.push(`gateway.bind mismatch (got ${cfg?.gateway?.bind ?? "unset"})`);
}
if ((cfg?.gateway?.tailscale?.mode ?? "off") !== "off") {
  errors.push(
    `gateway.tailscale.mode mismatch (got ${cfg?.gateway?.tailscale?.mode ?? "unset"})`,
  );
}
if (!cfg?.wizard?.lastRunAt) {
  errors.push("wizard.lastRunAt missing");
}
if (!cfg?.wizard?.lastRunVersion) {
  errors.push("wizard.lastRunVersion missing");
}
if (cfg?.wizard?.lastRunCommand !== "onboard") {
  errors.push(
    `wizard.lastRunCommand mismatch (got ${cfg?.wizard?.lastRunCommand ?? "unset"})`,
  );
}
if (cfg?.wizard?.lastRunMode !== "local") {
  errors.push(
    `wizard.lastRunMode mismatch (got ${cfg?.wizard?.lastRunMode ?? "unset"})`,
  );
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE

  node dist/index.js gateway-daemon --port 18789 --bind loopback > /tmp/gateway.log 2>&1 &
  GW_PID=$!
  for _ in $(seq 1 10); do
    if grep -q "listening on ws://127.0.0.1:18789" /tmp/gateway.log; then
      break
    fi
    sleep 1
  done

  if ! grep -q "listening on ws://127.0.0.1:18789" /tmp/gateway.log; then
    cat /tmp/gateway.log
    exit 1
  fi

  node dist/index.js health --timeout 2000 || (cat /tmp/gateway.log && exit 1)

  kill "$GW_PID"
  wait "$GW_PID" || true
'

echo "E2E complete."
