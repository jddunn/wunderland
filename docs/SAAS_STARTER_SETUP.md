---
title: 'Voice Chat Assistant – SaaS Starter Configuration Guide'
status: draft
last_updated: 2025-10-16
owner: manicinc/product
---

# 1. Overview

This guide explains how to turn Voice Chat Assistant into a reusable SaaS starter kit. It covers:

1. Creating a Supabase project (auth + persistent data).
2. Configuring Lemon Squeezy products, plans, and webhooks.
3. Mapping plan metadata into the codebase (`shared/planCatalog.ts`).
4. Populating environment variables for local, staging, and production.
5. How the registration flow, billing webhooks, and access control fit together.

Use this document alongside:

- [`docs/SIGNUP_BILLING_IMPLEMENTATION_PLAN.md`](SIGNUP_BILLING_IMPLEMENTATION_PLAN.md) – technical breakdown of routes and components.
- [`docs/PLANS_AND_BILLING.md`](PLANS_AND_BILLING.md) – pricing math and calculator inputs.

> Tip: keep this file in sync when expanding the starter or offering new plans.

---

# 2. Prerequisites

| Tool / Service              | Purpose                                                         | Notes                                               |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| Supabase                    | Primary auth (email/password + optional OAuth) and persistence. | Free tier is enough for development.                |
| Lemon Squeezy               | Billing + subscriptions.                                        | Requires a verified seller account.                 |
| GitHub Actions              | CI/CD pipeline (optional but recommended).                      | Update secrets before deployment.                   |
| Vercel / Netlify / Your VPS | Frontend hosting.                                               | Repo ships with scripts for a Node/Vite deployment. |

You will need:

- A domain for production (e.g., `app.your-saas.com`).
- TLS certificates (Let’s Encrypt via reverse proxy or managed platform).
- Ability to run Node.js ≥ 20 in both dev and prod.

---

# 3. Supabase Setup

## 3.1 Create Project

1. Visit [supabase.com](https://supabase.com) and create an organisation/project.
2. Enable email/password auth (`Authentication → Providers`).
3. (Optional) Enable OAuth providers (Google, GitHub) if you want social sign-in.
4. Add **Allowed Redirect URLs**:
   - `http://localhost:3000`
   - `https://app.your-saas.com`

## 3.2 Database Schema

The application maintains its own tables in addition to Supabase’s auth schema.

### 3.2.1 `app_users`

```sql
create table if not exists app_users (
  id text primary key,
  email text unique not null,
  password_hash text not null,
  supabase_user_id text,
  subscription_status text default 'none',
  subscription_plan_id text,
  lemon_customer_id text,
  lemon_subscription_id text,
  subscription_renews_at bigint,
  subscription_expires_at bigint,
  created_at bigint not null,
  updated_at bigint not null,
  metadata jsonb default '{}'::jsonb
);

create index if not exists idx_app_users_supabase on app_users(supabase_user_id);
create index if not exists idx_app_users_subscription on app_users(subscription_status);
```

> The backend automatically populates this table. Do not manually insert into it unless performing migrations.

### 3.2.2 `checkout_sessions`

```sql
create table if not exists checkout_sessions (
  id text primary key,
  user_id text not null references app_users(id) on delete cascade,
  plan_id text not null,
  status text not null default 'created', -- created | paid | failed | expired
  lemon_checkout_id text,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists idx_checkout_sessions_user on checkout_sessions(user_id);
create index if not exists idx_checkout_sessions_status on checkout_sessions(status);
```

This table tracks pending checkouts so the webhook knows which user/plan to update.

## 3.3 Supabase Keys

Collect the following from the dashboard (`Project Settings → API`):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side usage only!)
- `VITE_SUPABASE_URL` (frontend)
- `VITE_SUPABASE_ANON_KEY` (frontend)

> Never expose the service-role key to the browser. Only the backend uses it.

---

# 4. Lemon Squeezy Setup

## 4.1 Create Products & Variants

1. Log in to [Lemon Squeezy](https://www.lemonsqueezy.com/).
2. Create a **Store** if you don’t already have one.
3. For each pricing tier (Free, Basic, Creator, Org), create a **Product**:
   - `Product Name`: e.g., “Voice Chat Assistant – Basic”
   - `Product Type`: Subscription
   - `Billing Interval`: Monthly (choose yearly variants if you plan to offer Yearly/Annual tiers).
4. For each product, note down:
   - `Product ID`
   - `Variant ID`
   - `Price (cents or with currency, depending on API call)`

These IDs map to entries in `shared/planCatalog.ts`. Example excerpt:

```ts
export const PLAN_CATALOG: Record<PlanId, PlanCatalogEntry> = {
  basic: {
    id: 'basic',
    name: 'Basic',
    price: '$9 / month',
    slug: 'basic',
    lemonProductId: '12345',
    lemonVariantId: '67890',
    metadata: {
      displayPrice: '$9/mo',
      featured: true,
    },
    highlights: ['9.5K GPT-4o tokens / day', 'Mermaid diagram support', 'Priority email support'],
  },
  // ...
};
```

## 4.2 Webhooks

1. In Lemon Squeezy, go to “Settings → Webhooks”.
2. Create a webhook pointing to your backend:
   - Development: `http://localhost:3001/api/billing/webhook`
   - Production: `https://app.your-saas.com/api/billing/webhook`
3. Select events to receive:
   - `Subscription Created`
   - `Subscription Updated`
   - `Subscription Cancelled`
   - (Optional) `Subscription Payment Failed`
4. Generate a webhook secret and store it as `LEMONSQUEEZY_WEBHOOK_SECRET`.

## 4.3 API Key

Generate an API key (`Settings → API`) and use it for server-side checkout creation.

- `LEMONSQUEEZY_API_KEY`: used by backend billing service.
- `LEMONSQUEEZY_STORE_ID`: numeric store id (found on the same page).

---

# 5. Environment Variables

Use `.env.example` (repo root) and `frontend/.env.example` as references. Required values for production:

```bash
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://app.your-saas.com
APP_URL=https://app.your-saas.com

AUTH_JWT_SECRET=<long_random_string>
GLOBAL_ACCESS_PASSWORD=<optional shared password>

SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role>
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>

LEMONSQUEEZY_API_KEY=<api-key>
LEMONSQUEEZY_STORE_ID=<store-id>
LEMONSQUEEZY_WEBHOOK_SECRET=<webhook-secret>

VITE_LEMONSQUEEZY_PRODUCT_ID=<default-product-id>
VITE_LEMONSQUEEZY_VARIANT_ID=<default-variant-id>
```

Optional toggles:

- `SERVE_FRONTEND=true` if the backend should serve the production build.
- `DISABLE_COST_LIMITS=false` in production.
- `ENABLE_SQLITE_MEMORY=false` unless you intentionally want local persistence.

For CI/CD (GitHub Actions), set a multi-line secret called `ENV` containing the entire `.env` payload.

---

# 6. Registration Flow Summary

1. **Account form (`/register`)**
   - POST `/api/auth/register` with email + password.
   - Backend creates Supabase user + local `app_users` entry + returns a temp JWT.

2. **Plan selection (`/register/plan`)**
   - User chooses plan.
   - Frontend hits `/api/billing/checkout` which creates `checkout_sessions` record and returns `checkoutUrl`.

3. **Payment (`/register/payment`)**
   - Frontend redirects user to Lemon Squeezy checkout.
   - After payment completes, Lemon Squeezy sends webhook to `/api/billing/webhook`.

4. **Webhook**
   - Backend verifies signature, updates `checkout_sessions` to `paid`, updates `app_users.subscription_*` columns, and issues a long-lived JWT.

5. **Success Screen (`/register/success`)**
   - Poll `/api/billing/status/:checkoutId` until status is `paid`.
   - Once active, show success screen + direct user to `/login`.

> The current implementation includes view scaffolding and state store (`useRegistrationStore`). Hook the components up to the live API endpoints from the implementation plan.

---

# 7. Pricing & Plan Tweaks

### 7.1 Adjust Plan Catalog

`shared/planCatalog.ts` defines plan logic used by both frontend and backend. When you add or rename plans:

1. Update `PLAN_CATALOG` entries.
2. Update `PLAN_ORDER` if you want a custom display order.
3. Provide translations for plan names/descriptions in `frontend/src/i18n/locales/*`.

### 7.2 Usage Limits

Token allowances and conversions live in [`docs/PLANS_AND_BILLING.md`](PLANS_AND_BILLING.md) and `shared/planCatalog.ts`. Adjust there when pricing changes.

---

# 8. Testing Checklist

1. **Local**
   - Run `npm run dev` (root).
   - Create a test Supabase user with email/password.
   - Hit `/register`, ensure state persists after refresh.
   - Create checkout in Lemon Squeezy sandbox and confirm webhook logs.

2. **Staging**
   - Deploy preview environment.
   - Use Lemon Squeezy test mode (`Settings → Switch to test`).
   - Validate emails are sent (if you integrated transactional mail).

3. **Production**
   - Switch Lemon Squeezy to live mode (`Settings → Switch to live`).
   - Confirm webhook secret, store id, product ids correspond to live values.
   - Create a $0.01 “silent” plan for smoke tests (optional).
   - Monitor server logs during first few signups.

---

# 9. Frequently Asked Questions

**Q: Can I keep the Free tier without billing?**  
A: Yes. The Free tier is tracked without Lemon Squeezy. You can gate features in the backend based on `subscription_plan_id`.

**Q: How do I handle cancellations?**  
A: Lemon Squeezy sends a `subscription_cancelled` webhook. Update `app_users.subscription_status = 'cancelled'` and prompt users to resubscribe when they login.

**Q: What about annual billing?**  
A: Add annual variants in Lemon Squeezy and extend `PLAN_CATALOG` with `metadata.billingInterval`. Update the frontend plan selector to display monthly vs yearly.

**Q: Where do I send invoices?**  
A: Lemon Squeezy takes care of invoicing. You can link to the customer portal from Settings → Billing.

---

# 10. Next Steps

- Implement the remaining backend endpoints (`/api/auth/register`, `POST /api/billing/checkout`, `/api/billing/status/:checkoutId`).
- Wire the frontend registration components to call these endpoints (see implementation plan).
- Expand translations for the new pages (only English strings are currently defined).
- Configure email onboarding or product tours after successful signup (optional).

With the steps above, you can clone the repository, follow this guide, and have a production-grade SaaS foundation with authentication, billing, and plan management ready to go.
