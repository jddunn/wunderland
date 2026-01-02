---
summary: "Optional Docker-based setup and onboarding for Clawdis"
read_when:
  - You want a containerized gateway instead of local installs
  - You are validating the Docker flow
---

# Docker (optional)

Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.

## Quick start (recommended)

From the repo root:

```bash
./docker-setup.sh
```

This script:
- builds the image
- runs the onboarding wizard
- runs WhatsApp login
- starts the gateway via Docker Compose

It writes config/workspace on the host:
- `~/.clawdis/`
- `~/clawd`

## Manual flow (compose)

```bash
docker build -t clawdis:local -f Dockerfile .
docker compose run --rm clawdis-cli onboard
docker compose run --rm clawdis-cli login
docker compose up -d clawdis-gateway
```

## E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

## Notes

- Gateway bind defaults to `lan` for container use.
- Health check:
  `docker compose exec clawdis-gateway node dist/index.js health --token "$CLAWDIS_GATEWAY_TOKEN"`
