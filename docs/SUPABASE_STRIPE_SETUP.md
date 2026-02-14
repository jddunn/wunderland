---
title: "Supabase & Stripe Setup"
last_updated: 2025-10-24
owner: engineering
---

# Overview

The Voice Chat Assistant registration journey is a three-step flow driven by:

1. **Supabase Auth** for credential storage and social sign-ins.
2. **Stripe Checkout** for plan purchase.
3. **Pinia registration store + backend API** to bridge the two.

This document explains how to configure the services, required environment variables, and where the logic lives in the codebase.

---

# 1. Supabase Configuration

1. Create a Supabase project (or use an existing one).  
2. In **Authentication → Providers**, enable Email/Password and any OAuth providers you intend to surface later.  
3. Configure **Redirect URLs** to include your production domain and development URLs, e.g.:
   - `https://voice-chat-assistant.local/en/login`
   - `http://localhost:4173/en/login`
4. Ensure the `app_users` table contains a `supabase_user_id` column. See `docs/SAAS_STARTER_SETUP.md` for the migration snippet.

## 1.1 Environment variables

Populate these in the backend `.env` (server runtime):

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE=eyJ...   # required for server-side management
```

Populate these in the frontend `.env` / `.env.local` (Vite runtime):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

If you still run the legacy Next.js build, keep `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in sync.

## 1.2 Where it is used

| Component / Service | Purpose |
|---------------------|---------|
| `frontend/src/composables/useAuth.ts` | Wraps Supabase client, listens for auth state changes, exposes `supabaseEnabled`. |
| `frontend/src/views/Login.vue` | Renders Supabase tab when the service is enabled. |
| `backend/src/features/auth/supabaseAuth.service.ts` | Validates Supabase JWT, mirrors users into `app_users`. |
| `backend/middleware/auth.ts` & `optionalAuth.ts` | Accept Supabase tokens when `supabaseAuthEnabled` evaluates to true. |

Restart both frontend and backend after editing the env files so the values are injected.

---

# 2. Stripe Configuration

Stripe is the primary billing provider for the reference app. Each catalog plan in `shared/planCatalog.ts` has entries for Stripe product and price IDs. AgentOS core does not talk to Stripe directly – the backend handles all checkout and webhook flows.

1. In the Stripe dashboard (test mode is fine for dev), create Products & Prices for each plan you expose (`free` has no Checkout).  
2. Copy the Product ID (`prod_...`) and Price ID (`price_...`) for each plan tier.  
3. Set the following env vars:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...         # from stripe listen --forward-to

STRIPE_BASIC_PRODUCT_ID=prod_...
STRIPE_BASIC_PRICE_ID=price_...
STRIPE_CREATOR_PRODUCT_ID=prod_...
STRIPE_CREATOR_PRICE_ID=price_...
STRIPE_ORG_PRODUCT_ID=prod_...
STRIPE_ORG_PRICE_ID=price_...
```

4. Run `stripe login` and `stripe listen --forward-to http://localhost:3001/api/billing/webhook` during development so the webhook handler receives events.

## 2.1 Where it is used

| Location | Responsibility |
|----------|----------------|
| `backend/src/features/billing/stripe.service.ts` (or equivalent) | Creates checkout sessions, verifies webhook signatures, updates `checkout_sessions`. |
| `backend/src/routes/billing.routes.ts` | Exposes `/api/billing/checkout`, `/api/billing/status/:checkoutId`, `/api/billing/webhook`. |
| `frontend/src/views/register/RegisterPayment.vue` | Calls `billingAPI.createCheckoutSession`, opens the Stripe checkout URL, and polls `/api/billing/status`. |
| `frontend/src/store/registration.store.ts` | Persists the checkout session ID, status, and auth token across steps. |

If both Lemon Squeezy and Stripe variables are present, the billing service prioritises Stripe. Clearing `LEMONSQUEEZY_*` entries is enough to force Stripe-only behavior.

---

# 3. Registration Flow Wiring

1. **Step 1: Account (`RegisterAccount.vue`)**  
   - Calls `authAPI.register` (backend `/api/auth/register`).  
   - Stores email/password + temp JWT in `registration.store`.

2. **Step 2: Plan (`RegisterPlan.vue`)**  
   - Uses `usePlans()` (which reads `shared/planCatalog.ts`) to display available plans.  
   - Sets the chosen `planId` in the store and routes to payment.

3. **Step 3: Payment (`RegisterPayment.vue`)**  
   - Builds success/cancel URLs.  
   - Calls `billingAPI.createCheckoutSession`.  
   - Opens the Stripe Checkout link in a new tab and starts polling `/api/billing/status/:checkoutId`.  
   - When the webhook marks the session `paid`/`complete`, it logs in the user via `auth.login(...)` and redirects to success.

4. **Step 4: Success (`RegisterSuccess.vue`)**  
   - Reads the account email from the store and presents post-purchase actions.

All steps share styling through `RegisterLayout.vue`.

---

# 4. Verification Checklist

- [ ] Env vars above are set and processes restarted.  
- [ ] `npm run dev` in `/backend` and `/frontend` start without missing-variable warnings.  
- [ ] Hitting `/register` allows progressing through all steps.  
- [ ] Stripe Checkout opens and test payments succeed (use `4242 4242 4242 4242`).  
- [ ] Stripe webhook updates the backend (`checkout_sessions` status becomes `complete`, `app_users.subscription_plan_id` reflects the plan).  
- [ ] Supabase console shows the new user with matching email, and the `app_users.supabase_user_id` column is populated.

---

# 5. Troubleshooting

- **`Either NEXT_PUBLIC_SUPABASE_URL... are required`**  
  The frontend build is missing Supabase env vars. Ensure `VITE_SUPABASE_*` (or `NEXT_PUBLIC_SUPABASE_*` if using Next.js) are defined before `npm run dev`.

- **`Invalid linked format` from `vue-i18n`**  
  Stick to ASCII characters in locale files (straight apostrophes and `->`). A normalization script is available; run `npm run lint:i18n` once added.

- **Stripe checkout opens but status never updates**  
  Confirm the webhook secret matches the value in `.env`, and that the webhook route logs events. During dev, keep `stripe listen` running.

- **Supabase login tab hidden**  
  `useAuth()` only exposes the Supabase tab when `supabaseEnabled` detects both URL and key. Double-check the frontend env vars.

---

By completing the steps above, `/register` is fully wired to Supabase for auth and Stripe for billing, with UI and backend logic already in place.
