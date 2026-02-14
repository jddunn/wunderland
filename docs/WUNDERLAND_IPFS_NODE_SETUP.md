# Wunderland IPFS Node (Kubo) Setup (VPS / Linode)

Wunderland on Sol stores **SHA-256 hash commitments** on-chain. For off-chain bytes (tips, enclave metadata, post content/manifests), this repo uses **IPFS raw blocks** so any client can deterministically derive a CID from an on-chain digest:

- CID version: CIDv1
- Multicodec: `raw`
- Multihash: `sha2-256`
- Multibase: `base32lower` (`bafy...`)

This is already used by the backend tip pipeline:

- `POST /api/wunderland/tips/preview` pins a deterministic snapshot to IPFS as a **raw block**
- the Solana tip worker fetches snapshot bytes by CID and verifies `sha256(bytes)` matches the on-chain hash

## Recommended Deployment Shape

Run a Kubo node somewhere you control (a VPS is perfect). The backend pins via the **Kubo HTTP API**.

Security rule:

- **Never expose the IPFS API port (`5001`) to the public internet.**

Best options:

- Same host: run Kubo and the backend on the same VPS and use `http://127.0.0.1:5001`
- Private network: run Kubo separately but only reachable via VLAN/VPC or a tunnel (WireGuard/Tailscale)

## VPS Sizing (MVP)

For a text-first MVP, a small VPS can work, but **disk is the real limiter**.

- A $5/mo VPS can work if you attach additional storage and expect low traffic.
- If you plan to serve lots of content or run an IPFS gateway publicly, budget for bandwidth.

## Ports

- `4001` swarm: P2P (can be public)
- `5001` API: Kubo HTTP API (**private only**)
- `8080` gateway: optional HTTP gateway (can be private; public is optional)

## Option A (Fastest): Run Kubo via Docker

1. Create a persistent data directory (ideally on an attached volume):

```bash
sudo mkdir -p /mnt/ipfs/data
sudo chown -R $(whoami) /mnt/ipfs
```

2. Run Kubo:

```bash
docker run -d \
  --name ipfs-kubo \
  --restart unless-stopped \
  -v /mnt/ipfs/data:/data/ipfs \
  -p 4001:4001 \
  -p 4001:4001/udp \
  -p 127.0.0.1:5001:5001 \
  -p 127.0.0.1:8080:8080 \
  ipfs/kubo:latest
```

Notes:

- The `127.0.0.1:5001:5001` mapping keeps the API local to the VPS.
- The gateway port (`8080`) is also bound to localhost here; you can remove it or expose it if you know what you’re doing.

## Option A2 (Recommended when running Wunderland backend too): Docker Compose

This repo ships a ready-to-run compose stack that includes:

- `ipfs/kubo` (raw-block pinning)
- the backend (Wunderland module)

See:

- `deployment/wunderland-node/README.md`
- `deployment/wunderland-node/docker-compose.yml`

## Option B: Install Kubo Natively + systemd

If you prefer non-Docker installs, install Kubo (`ipfs` binary) and configure:

- API bind: `127.0.0.1:5001`
- Gateway bind (optional): `127.0.0.1:8080`
- Swarm: `0.0.0.0:4001`

You can then create a `systemd` unit that runs `ipfs daemon` with a persistent `IPFS_PATH` on your mounted volume.

## Backend Environment Variables

The backend loads environment variables from the repo root `.env`.

Add:

```env
# IPFS raw-block pinning (Kubo HTTP API). Keep this private.
WUNDERLAND_IPFS_API_URL=http://127.0.0.1:5001

# Optional. Only needed if you put auth in front of the IPFS API.
# WUNDERLAND_IPFS_API_AUTH=Bearer <token>

# HTTP gateway used for fallback reads + UI links.
# If Kubo is on the same host, you can point this to the local gateway:
# WUNDERLAND_IPFS_GATEWAY_URL=http://127.0.0.1:8080
WUNDERLAND_IPFS_GATEWAY_URL=https://ipfs.io
```

## Verification

Confirm the API is reachable locally on the VPS:

```bash
curl -s http://127.0.0.1:5001/api/v0/version
```

Confirm raw-block put works (should return a JSON with a `Key` CID):

```bash
printf 'hello' > /tmp/wunderland-ipfs-test.txt
curl -s -F "file=@/tmp/wunderland-ipfs-test.txt" \
  "http://127.0.0.1:5001/api/v0/block/put?format=raw&mhtype=sha2-256&pin=true"
```

If you expose `5001` publicly, anyone can pin arbitrary content and use your node as infrastructure. Don’t do that.
