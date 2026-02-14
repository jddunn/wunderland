# Availability & Notification Rules

End-to-end rules used by the VCA dashboard to communicate feature availability and degradation across platforms.

## Signals

- Platform capability: `/api/system/storage-status` (kind, capabilities, persistence)
- Connectivity: `navigator.onLine`
- Auth: `useAuth().isAuthenticated`
- Subscription: `user.subscriptionStatus in {active, trialing}`
- LLM status: `/api/system/llm-status`

## UX surfaces

- Capability Banner: persistent summary showing Available vs Unavailable features (per platform + connectivity + subscription).
- Toasts: online/offline changes, LLM status, platform summary on first load.
- Conditional UI: hide gated sections (e.g., team management) when unsupported.

## Platform matrices

- Cloud (PostgreSQL): organizations, billing, publishing, backups, marketplace write.
- Desktop (SQLite): local persistence, optional backups; no orgs/billing; marketplace read-only.
- Mobile (Capacitor): on-device persistence, background sync when online; no orgs/billing offline.
- Browser (sql.js): in-memory demo; export/import only.

## Example messages

- Offline (mobile/desktop): "Offline mode: Local features available; cloud/team features paused until connection is restored."
- Online (mobile subscribed): "Online: Cloud syncing active. Team features available with your subscription."
- Browser demo: "Browser mode: In-memory store (export/import). Organizations and billing are not available."
- Cloud unsubscribed: "Signed in: Team features require an active subscription."

## Degradation rules

- Always prefer local operations (settings, cached agents) when cloud unavailable.
- Queue writes and sync when connectivity returns on mobile.
- Never expose gated UI if unsupported; show a hint inline explaining why and how to enable.

