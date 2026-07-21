# Assistant Browser Attach

Drive your **already-running, logged-in** browser from a wunderland mission —
research things behind a login (member portals, dashboards, price pages),
extract what matters, and export a CSV/HTML/PDF report. The session attaches to
the browser you are already using; it never launches a new one, never signs in
or out, and never closes anything.

## What it is

Attach mode adds a `browser_attach_*` tool family to the `browser-automation`
extension. Unlike the launch-mode tools (which start a headless Chromium),
these connect to your real desktop Chrome over one of two transports and
operate inside a single **agent tab** they claim for themselves.

| Tool | Side effect | Purpose |
|---|---|---|
| `browser_attach_status` | no | Report transport, state, lease, agent tab. |
| `browser_attach_claim` | yes | Acquire the single-session lease, verify the profile identity, claim the agent tab. |
| `browser_attach_goto` | yes | Navigate the agent tab to an `https` URL (`about:blank` allowed). |
| `browser_attach_read` | no | Read visible text (optionally by CSS selector). Returns **untrusted** page content. |
| `browser_attach_release` | yes | Park the tab at `about:blank` and release the lease. |
| `browser_attach_control` | yes | Runtime session controls: `pause` / `resume` / `dry_run_on` / `dry_run_off` / `status`. |

There is deliberately **no arbitrary-JavaScript tool** — page script could
submit forms, read cookies, or exfiltrate a session, which would defeat the
read-only contract.

### Session controls (robustness)

- **HITL approval.** Configure an `onNavigate` approver on the controller and it
  runs after the URL policy passes — a denial blocks the page. Use it to require
  per-page operator approval for anything an assistant opens.
- **Dry-run.** `WUNDERLAND_ATTACH_DRYRUN=1` (or `browser_attach_control` →
  `dry_run_on`) validates and reports navigation/reads without touching the
  browser — preview a mission's plan, or run it in CI, safely.
- **Pause / resume.** `browser_attach_control` → `pause` refuses further
  operations until `resume`. Status reports `paused`, `dryRun`, `navigations`,
  and `lastUrl`.
- **Deadline.** `WUNDERLAND_ATTACH_DEADLINE_MS` bounds every operation.

## The contract (enforced in code, not by convention)

- **Attach-only.** The controller can never launch a browser. If the target is
  missing or the profile identity does not match, `claim()` aborts with
  `PROFILE_MISMATCH` — it does not "helpfully" spawn Chrome.
- **Non-destructive.** The transport backend exposes no browser/tab close
  method, so `detach()` can only drop our own connection. Your browser, windows,
  and tabs are never closed.
- **Marker-tab bound.** Every operation targets the one tab the session claimed
  (tagged via `window.name`). Your other tabs are unreachable by construction.
- **Single session.** A cross-process lease (PID + nonce, 10-minute TTL) means
  two missions cannot drive the browser at once; the second gets `LEASE_DENIED`.
- **Deny-by-default navigation.** Only `https` (and `about:blank`) is allowed —
  never `file:`, `javascript:`, `data:`, `devtools:`, private/loopback hosts, or
  credential-bearing URLs. Redirects are re-validated against the same policy.
- **Untrusted reads.** `browser_attach_read` labels its output untrusted so the
  model treats page text as data, not instructions.

## Prerequisites (macOS)

1. Your daily Chrome is **running and signed in** to the target profile.
2. One-time permission: **View → Developer → "Allow JavaScript from Apple
   Events"** (the JXA transport reads page text through it). Also grant your
   terminal Accessibility permission if prompted.
3. Open a fresh **`about:blank`** tab in the target profile before running — the
   session claims that tab.

The **CDP transport** (`transport: 'cdp'`) is an alternative that reads the
`DevToolsActivePort` file from the profile root when Chrome runs with remote
debugging; the endpoint GUID rotates per browser launch, so it is re-read every
connect. On machines where the DevTools socket is unresponsive, use the default
JXA transport.

## Running it

Attach tools are **off by default**. They load only when (a) a mission lists the
`browser-automation` pack under `tools:` (which also scopes the mission to
`deny-side-effects` approval) and (b) `WUNDERLAND_ATTACH_IDENTITY` is set — the
env var that supplies the `expectedIdentity` the session must match. Pin a cloud
model so the planner is not a local 7B:

```bash
export WUNDERLAND_ATTACH_IDENTITY='you@gmail.com'   # required to enable attach
# optional:
#   WUNDERLAND_ATTACH_TRANSPORT=jxa|cdp   (default jxa)
#   WUNDERLAND_ATTACH_HOSTS=founderscard.com,hotels.com   (https allowlist)
#   WUNDERLAND_ATTACH_PROFILE_ROOT=/path/to/Chrome   (non-default profile root)

wunderland mission run examples/mission-assistant-browse.yaml \
  --planner-model anthropic/claude-sonnet-5 \
  --execution-model anthropic/claude-sonnet-5 \
  --autonomy autonomous --output ./assistant-report --format md
```

See [`examples/mission-assistant-browse.yaml`](../../examples/mission-assistant-browse.yaml).

### Configuring attach on the pack

```ts
createExtensionPack({
  options: {
    attach: {
      expectedIdentity: 'you@gmail.com', // required — gates the profile
      transport: 'jxa',                  // 'jxa' (default) or 'cdp'
      allowHosts: ['founderscard.com', 'hotels.com'], // optional https allowlist
    },
  },
});
```

## Exporting a report

Assistant research often wants a shareable artifact. `mission run` emits CSV
natively; the export helper adds print-safe HTML and PDF:

```ts
import { exportReport } from 'wunderland/cli/export/report-export';

await exportReport(
  { title: 'LA Hotels', columns: ['hotel', 'rate'], rows: [...] },
  './assistant-report',
  { basename: 'hotels', pdf: true },
);
// → hotels.csv, hotels.html, hotels.pdf
```

The PDF renders through an **isolated** headless-Chrome `--user-data-dir`, never
your live profile.

### Interactive report

Pass `interactive: true` to also emit `<basename>.interactive.html` — a
self-contained interactive report with client-side column sort (numeric-aware),
a live search box, value heat-shading (`heat: 'higher-better' | 'lower-better'`
per column), stat cards, a light/dark toggle, and a client-side CSV export of
the current view. No external resources — one shareable file.

```ts
await exportReport(dataset, './report', {
  interactive: {
    stats: [{ label: 'hotels', value: '23' }],
    columns: [
      { key: 'rate', numeric: true, heat: 'lower-better' },
      { key: 'score', numeric: true, heat: 'higher-better' },
    ],
  },
});
// → report.csv, report.html, report.pdf, report.interactive.html
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `JS_DISABLED` | Enable **Allow JavaScript from Apple Events** (see prerequisites). |
| `ACCESSIBILITY_DENIED` | Grant your terminal Accessibility permission in System Settings. |
| `PROFILE_MISMATCH` | The running browser's signed-in profile does not match `expectedIdentity`. Switch profiles or fix the config — the session will not launch a browser to compensate. |
| `LEASE_DENIED` | Another mission holds the session (or a stale lease has not expired). Wait out the 10-minute TTL or release the prior session. |
| `CDP_UNAVAILABLE` / `CDP_TIMEOUT` | Remote debugging is off or the DevTools socket is wedged. Use `transport: 'jxa'`. |
| `NO_BLANK_TAB` | Open a fresh `about:blank` tab in the target profile first. |

## Verifying end to end

A real-browser verification lives in
`src/cli/commands/__tests__/attach-verify.e2e.test.ts`, skipped unless
`WUNDERLAND_ATTACH_E2E=1` (CI has no attachable browser). It claims a
nonce-marked tab, drives only that tab, and asserts every other tab is
unchanged afterward — the marker-tab contract, proven.

```bash
WUNDERLAND_ATTACH_E2E=1 WUNDERLAND_ATTACH_IDENTITY='@gmail.com' \
  npx vitest run src/cli/commands/__tests__/attach-verify.e2e.test.ts
```
