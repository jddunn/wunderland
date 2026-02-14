# Plans, Pricing, and Billing

This note defines the commercial plans, daily token budgets, and billing integrations for Voice Chat Assistant. All plan metadata lives in `shared/planCatalog.ts` so both backend and frontend read the same source of truth.

> **AgentOS core vs billing**
>
> AgentOS core (`@framers/agentos`) does not implement billing or plan logic. It only consumes an `ISubscriptionService` interface (typically backed by your backend and plan catalog) to decide whether a user can access a given persona or tool. Everything in this document applies to the **SaaS app and backend**, not to the core library itself.

## Plan Catalog Overview

| Plan                   | Monthly Price | Usage Allocation     | Daily Platform Allowance                | BYO Keys                 | Audience                 |
| ---------------------- | ------------- | -------------------- | --------------------------------------- | ------------------------ | ------------------------ |
| Global Lifetime Access | Invite-only   | Internal allocation  | ~31,800 GPT-4o tokens (USD 0.35)        | No                       | Internal cohorts         |
| Free                   | $0            | N/A                  | ~1,800 GPT-4o tokens (~51K GPT-4o mini) | No                       | Product evaluation       |
| Basic                  | $9            | 35% -> USD 0.105/day | ~9,500 GPT-4o tokens                    | No                       | Individual developers    |
| Creator                | $18           | 40% -> USD 0.24/day  | ~21,800 GPT-4o tokens                   | Optional after allowance | Freelancers and builders |
| Organization           | $99           | 45% -> USD 1.485/day | ~135,000 GPT-4o tokens (shared)         | Optional after allowance | Teams (>= five seats)    |

## Custom Agent Limits & Feature Flags

User-managed agents are now a first-class feature. Each plan ships explicit limits that are exported from `shared/planCatalog.ts`, persisted through `backend/src/features/agents/**`, and surfaced in the client dashboard (`frontend/src/views/agents/AgentDashboard.vue`).

| Plan                  | Max Active Custom Agents | Monthly Agent Creations | Knowledge Docs / Agent | Agency Launches / Week | Feature Flags & Seats                                                                |
| --------------------- | ------------------------ | ----------------------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| Free                  | 1 (session/IP scoped)    | 1                       | 5                      | 0                      | `custom-agent-lite` - GPT-4o mini only, limited RAG bundle, no tool chaining         |
| Basic (VCA Basic)     | 3                        | 3                       | 25                     | 1                      | `custom-agents`, 1 agency seat for sharing                                           |
| Creator (VCA Premium) | 8                        | 8                       | 100                    | 3                      | `custom-agents`, `agency-lite`, `advanced-models`, 3 agency seats                    |
| Organization          | 50                       | 50                      | 500                    | 7                      | `custom-agents`, `agency-pro`, `team-management`, `advanced-models`, 10 agency seats |

Agency launches are an example quota you can use for hosted plans. The reference implementation enforces a 7-day rolling window via `agency_usage_log`, but self-hosted deployments can change or remove the check.

- Free users manage a single lightweight agent that is bound to their session and IP. The dashboard guides them toward upgrading once they hit the creation limit or request premium models/RAG scopes.
- Monthly creation tracking is persisted in `user_agent_creation_log`; active agent slots live in `user_agents`. Both tables are initialised by `AppDatabase.ensureSchema()` and gated by the new quota helpers in `UserAgentService`.
- The frontend plan snapshot endpoint (`GET /api/plan/snapshot`) feeds the quota HUD used in `AgentHub` and settings pages so users always see available slots before creating a new agent.

### Why these numbers?

1. **Model cost assumptions**
   - GPT-4o blended cost per 1K tokens ~ USD 0.011 (40% input @ 0.005 + 60% output @ 0.015).
   - GPT-4o mini blended cost per 1K tokens ~ USD 0.00039 (40% input @ 0.00015 + 60% output @ 0.00060).
2. **Budget allocation**
   - Basic allocates 35% of revenue to usage, Creator 40%, Organization 45%.
   - Daily allowance = (monthly price \* allocation percentage) / 30.
   - Approximate GPT-4o tokens = floor((daily allowance USD / 0.011) \* 1000).
3. **Margins**
   - Gross margin stays above ~55% for each paid tier while funding the built-in usage budget.
   - Creator and Organization tiers fall back to bring-your-own keys after the house allowance is used.

## Platform vs BYO Keys

- **Basic**: usage stops when the platform budget is exhausted.
- **Creator**: platform budget first, then BYO keys with UI telemetry and reporting.
- **Organization**: shared pool first, optional seat caps, then BYO keys per member.

The rollover rules are exported from `shared/planCatalog.ts` so both UI and API can explain the behaviour.

## Global Lifetime Access

- Maintain a small list of shared passphrases (rotate manually via config or admin tooling).
- Each passphrase maps to the same allowance as Basic (USD 0.35/day ~31,800 GPT-4o tokens) but enforced per IP.
- Document rotation in the internal runbook: issue new passphrase, offer a grace period, then retire the old one.

## Provider Toggle

Plans ship checkout descriptors for both Lemon Squeezy and Stripe. Only populate the env vars for the provider you use.

```
# Lemon Squeezy
LEMONSQUEEZY_API_KEY=
LEMONSQUEEZY_STORE_ID=
LEMONSQUEEZY_WEBHOOK_SECRET=
LEMONSQUEEZY_BASIC_PRODUCT_ID=
LEMONSQUEEZY_BASIC_VARIANT_ID=
LEMONSQUEEZY_CREATOR_PRODUCT_ID=
LEMONSQUEEZY_CREATOR_VARIANT_ID=
LEMONSQUEEZY_ORG_PRODUCT_ID=
LEMONSQUEEZY_ORG_VARIANT_ID=

# Stripe (optional)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_BASIC_PRODUCT_ID=
STRIPE_BASIC_PRICE_ID=
STRIPE_CREATOR_PRODUCT_ID=
STRIPE_CREATOR_PRICE_ID=
STRIPE_ORG_PRODUCT_ID=
STRIPE_ORG_PRICE_ID=
```

For the frontend, mirror the IDs using `VITE_LEMONSQUEEZY_*` and `VITE_STRIPE_*` so buttons and modals render correctly.

## Lemon Squeezy Checklist

1. Create Basic, Creator, and Organization products with matching variants.
2. Store the product/variant IDs in the env vars above.
3. Point the webhook to `/api/billing/webhook` and share the secret with the backend.
4. (Optional) create add-on variants for additional Organization seats.

### Where to find Lemon Squeezy IDs

1. Login to the Lemon Squeezy dashboard and open **Products**.
2. Create or select your plan product (Basic, Creator, Organization).
3. Inside the product, open the **Variants** tab.
4. Click a variant and copy its numeric ID from the URL (`/variants/{variant_id}`) or from the API panel in the sidebar.
5. Copy the product ID from the parent product URL (`/products/{product_id}`) or the same API panel.
6. Paste both IDs into `.env` (`LEMONSQUEEZY_*`) and `frontend/.env.local` (`VITE_LEMONSQUEEZY_*`).
7. Optional: visit **Checkout > Advanced Settings** to set `success_url` and `cancel_url` so they match your environment defaults.

The IDs are short numeric strings (for example `123456`) and are visible without calling the API.

## Stripe Checklist (Optional)

1. Create the same three products and monthly price IDs.
2. Add the secret key and price IDs to the env vars above.
3. Configure a webhook for `invoice.paid`, `customer.subscription.updated`, and `customer.subscription.deleted`.
4. Implement the Stripe webhook handler (mirrors the Lemon Squeezy handler) before enabling for customers.

## Team and Organization Flow

- Tables: `organizations`, `organization_members`, `organization_invites`.
- Roles: admin (billing + seats), builder (full usage), viewer (read-only future).
- Invites: admin triggers email, recipient accepts, seat count enforced before activation.
- UI: Settings > Team Management now handles seat limits, member roles, and distributing invite links.
- Usage telemetry tracks `platform_spend_usd` and `byo_spend_usd` so dashboards can break out cost sources.

## Reuse Checklist

1. Edit `shared/planCatalog.ts` when pricing or features change.
2. Update `.env.example`, `frontend/.env.example`, `CONFIGURATION.md`, and this doc with any new env vars.
3. Re-run marketing copy (About page, Login hints, Settings billing card) which now pull directly from the shared plan catalog.
4. Copy the same files into any derivative app so pricing stays DRY.

## Retention & privacy

- `agency_usage_log` retains launch metadata for approximately 18 months (launch timestamp, plan id, seats). Records older than that window are automatically expired during insertions.
- `agentos_persona_submissions` stores pending bundle metadata until approval. Approved bundles have their prompts materialised under `prompts/_dynamic`; rejected bundles retain audit trails but no runtime access.
- Marketplace listings honour visibility and ownership metadata; only owners or organisation members can mutate non-public listings.

## Roadmap

- Add Stripe checkout + webhook parity.
- Build team management UI (invitations, seat caps, role assignment).
- Add an admin tool for global passphrase rotation.
- Expand telemetry dashboards to show platform vs BYO spend per plan.

---

## Quarry Pro - Stripe Configuration

Quarry is a separate product with its own Stripe pricing. This section documents the setup for self-hosted Quarry deployments.

### Product Details

| Field            | Value                                   |
| ---------------- | --------------------------------------- |
| **Product ID**   | `prod_TjRWbCphp957L4`                   |
| **Product Name** | Quarry Pro                              |
| **Description**  | AI-native personal knowledge management |

### Pricing Tiers (Updated January 2026)

| Plan              | Price ID                         | Price    | Notes                                                   |
| ----------------- | -------------------------------- | -------- | ------------------------------------------------------- |
| Free              | N/A                              | $0       | Open source MIT license                                 |
| Pro Monthly       | `price_1SlyduCBrYnyjAOOlYvgIcx2` | $9/month | BYOK, includes cloud sync. Grandfathered (normally $18) |
| Pro Annual        | `price_1Sm1OFCBrYnyjAOO7SFJdLJZ` | $79/year | Save 27% vs monthly                                     |
| Lifetime          | `price_1Sm1OFCBrYnyjAOOgZNAjakB` | $199     | One-time purchase (Beta: $99)                           |
| Cloud Sync Add-on | TBD                              | $3/month | For Lifetime users (discounted from $9)                 |

### Grandfathered Pricing Strategy

All beta pricing is **grandfathered**—early adopters keep their price forever:

1. **Pro Monthly**: $9/month during beta, $18/month after launch
   - Early subscribers keep $9/month forever
2. **Lifetime**: $99 during beta, $199 after launch
   - Beta purchasers keep $99 price forever
3. **Cloud Sync Add-on**: $3/month for Lifetime users (discounted from $9)
4. **Team Features**: Coming free for all premium users who purchase during beta

### Environment Variables

Add these to your production `.env`:

```bash
# Required
STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Quarry Pro Price IDs
STRIPE_QUARRY_PRO_PRODUCT_ID=prod_TjRWbCphp957L4
STRIPE_QUARRY_PRO_MONTHLY=price_1SlyduCBrYnyjAOOlYvgIcx2
STRIPE_QUARRY_PRO_ANNUAL=price_1Sm1OFCBrYnyjAOO7SFJdLJZ
STRIPE_QUARRY_PRO_LIFETIME=price_1Sm1OFCBrYnyjAOOgZNAjakB
```

### Promotional Coupons

All coupons apply to lifetime purchases.

| Code           | Discount     | Final Price | Limit     | Use Case                         |
| -------------- | ------------ | ----------- | --------- | -------------------------------- |
| (default beta) | $100 off     | $99         | Unlimited | Standard beta pricing            |
| `EARLYBIRD`    | $150 off     | $49         | 499       | First 499 customers              |
| `STUDENT`      | $30 off beta | $69         | 1 each    | Student discount (from $99 beta) |

### Student Discount Workflow

1. Student emails `team@frame.dev` from `.edu` address
2. Subject line should include: "Student Discount"
3. Admin verifies email is legitimate .edu domain
4. Admin creates coupon in Stripe:
   - Go to [Coupons → Create](https://dashboard.stripe.com/coupons/create)
   - Type: Fixed amount
   - Amount: $30 off
   - Duration: Once
   - Max redemptions: 1
5. Send coupon code to student (applies to $99 beta = $69 final)

### Webhook Configuration

Configure webhook at `https://quarry.space/api/billing/webhook` for these events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

### Code Reference

The Stripe service reads price IDs from environment variables:

```typescript
// apps/frame.dev/lib/api/services/stripeService.ts
const STRIPE_PRICES = {
  monthly: process.env.STRIPE_QUARRY_PRO_MONTHLY || process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_QUARRY_PRO_ANNUAL || process.env.STRIPE_PRICE_ANNUAL,
  lifetime: process.env.STRIPE_QUARRY_PRO_LIFETIME || process.env.STRIPE_PRICE_LIFETIME,
};
```
