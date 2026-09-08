
## v14.5.0 — Simple Admin / Business Owner model

Zetiora now uses only two application roles:
- **System Admin** — full management of all businesses and users.
- **Business Owner** — full control of exactly one business.

Rules:
- One owner account can own only one business.
- One business can have only one owner.
- One business can have only one WhatsApp account/number.
- One WhatsApp number cannot be registered twice.
- No manager/staff/team roles.
- Admin can create businesses and assign an existing unassigned user as owner.
- Business owners can manage their own WhatsApp, inbox, products, orders, customers, AI and business settings, but cannot access another business.
- Product image uploads remain available through Supabase Storage.

After upgrading an existing database, run `supabase/schema.sql` in Supabase SQL Editor. The V15 migration removes legacy manager/staff memberships and enforces the new uniqueness rules.

# ZETIORA WhatsApp Gemini Bot — V14.4.1 PRO

V14 hardens the V13 commerce agent with safer IDs, stronger checkout tokens, checkout expiry, security headers, rate limiting, improved Supabase synchronization, startup sync for customers/carts, business-profile conflict handling, and clearer health reporting.

## Production deployment

Recommended baseline:

1. Use Node 22+ or the included Dockerfile.
2. Set `NODE_ENV=production`, `REQUIRE_SUPABASE=true`, and a real HTTPS `PUBLIC_BASE_URL`.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only. Never put it in `public/` or browser code.
4. Persist both `/app/data` and `/app/auth_info_baileys` when using Docker; losing the Baileys directory will require WhatsApp re-pairing.
5. Put the service behind HTTPS/reverse proxy and set `TRUST_PROXY=1` only when the proxy is trusted.
6. Monitor `/healthz` for liveness and `/readyz` for readiness.
7. For more than one application replica, move local JSON state and Baileys session handling to durable shared infrastructure and use a queue/Redis layer; the current runtime is intentionally single-instance safe.

### Build
```bash
npm ci
npm run typecheck
npm run build
NODE_ENV=production npm start
```

### Docker
```bash
docker build -t zetiora-whatsapp-ai .
docker run --env-file .env -p 3000:3000 -v zetiora-data:/app/data -v zetiora-wa:/app/auth_info_baileys zetiora-whatsapp-ai
```

## Important deployment note
The project still keeps local JSON state for WhatsApp session/runtime compatibility. For true horizontal SaaS scaling, the next architecture phase should move operational state to PostgreSQL/Supabase and Baileys sessions to durable encrypted storage, with Redis/queue workers.

## Run
```bash
npm ci
npm run typecheck
npm start
```

Set the required environment variables from `.env.example`. Do not expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.
# WhatsApp Gemini Business Bot V12 — AI Commerce Agent

V12 turns the WhatsApp bot into a tool-driven AI sales agent.

## Included
- Baileys WhatsApp connection with QR/pairing code
- Gemini tool calling for live commerce actions
- Product search and authoritative product details
- Native WhatsApp product images/documents
- Persistent per-customer cart
- Add/update/remove cart items
- Secure checkout token and branded delivery form
- Cart revalidation before checkout/order creation
- Customer profile persistence
- Automatic order creation from the submitted cart
- WhatsApp order confirmation
- Recent order status lookup
- Human handoff tool
- Multi-business authorization/security from V10/V11
- Duplicate message protection and exponential reconnect
- Supabase schema for businesses, customers and carts

## Setup
1. Copy `.env.example` to `.env`.
2. Set `GEMINI_API_KEY`, and optionally Supabase variables.
3. Set `PUBLIC_BASE_URL` to the public HTTPS URL used for checkout links.
4. Run `npm install`.
5. Apply `supabase/schema.sql` in Supabase.
6. Run `npm run typecheck`.
7. Run `npm start`.

## Commerce flow
Customer -> Gemini -> tool call -> backend validation -> catalog/cart/order -> WhatsApp response.

Gemini is not the source of truth for price, stock, order IDs or delivery data. The backend/database is.

Checkout links are token-based and do not expose dashboard authentication. A checkout token becomes unusable after its cart is cleared by successful order creation.

## v14.2 PRO production hardening

This release adds:
- Supabase request timeout + retry handling.
- Shared Redis-compatible rate limiting through Upstash REST when configured, with bounded local fallback.
- Strict role authority from the Supabase profile (`profiles.role`); no email-based admin escalation.
- Checkout idempotency to prevent duplicate submissions during retries.
- Checkout bearer-token rotation after successful checkout.
- HTTPS URL validation for knowledge/product media fields.
- Stronger request field length limits and order quantity validation.
- Database uniqueness protection for checkout idempotency keys.
- Readiness checks that verify Supabase connectivity, not only configuration.

### Multi-instance deployment

For more than one application instance, configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for shared rate limiting. WhatsApp account sessions must still use a durable shared/persistent filesystem or a dedicated single owner worker per WhatsApp account; do not run the same account session on multiple workers.

### Supabase

Run `supabase/schema.sql` against the target project. The schema is additive and includes the V14 idempotency index. Keep the service-role key server-side only.


## v14.3 Commerce functionality upgrades

- Persistent cart data with checkout token TTL and duplicate-submit protection.
- Product stock and SKU support, including optional product variants with variant price/stock/SKU.
- Cart validation refreshes live catalog prices/availability before checkout.
- Stock is validated before order creation and decremented when an order is created.
- Order records now track payment status, fulfillment status, and structured delivery details.
- Order status transitions are validated to prevent invalid state jumps.
- WhatsApp AI processing is serialized per customer chat so rapid messages cannot race cart/order actions.
- AI receives live stock and variant information and is instructed not to invent transaction state.

### Important payment note
The checkout currently creates orders as `payment_status=pending` and supports Cash on Delivery. Mobile Money/online payment requires a real provider integration and credentials; the system does not fake payment success.

## V14.4 UI + Product Images

The dashboard is now mobile-first with a cleaner commerce layout, responsive product grid, compact mobile bottom navigation, improved cards, spacing, and alignment.

### Product image upload
Products can be created with a direct image upload (JPG, PNG, WEBP, GIF; max 5MB) instead of requiring an image URL. In production, configure:

```env
SUPABASE_STORAGE_BUCKET=product-images
```

Run the latest `supabase/schema.sql` so the public `product-images` bucket is created. The backend uploads through the service role; customers only receive the public image URL.

If Supabase is not configured in development, uploads fall back to `data/uploads/products` and are served from `/uploads/products/...`.


## V14.4.1 local-development configuration fix

The example environment now defaults to `NODE_ENV=development`, so a fresh local `.env` can use `PUBLIC_BASE_URL=http://localhost:3000`. HTTPS is enforced only when `NODE_ENV=production`.

For production, set:
```env
NODE_ENV=production
PUBLIC_BASE_URL=https://your-domain.com
```


## v14.4.2 hotfix
- Fixed multipart product-image parsing so uploaded files are not saved with trailing multipart bytes.
- Added image magic-byte validation.
- Product image uploads require manager/owner access.
- WhatsApp account management is now role-aware: owner/manager/admin can manage accounts; staff remains operational-only.
- Catalog writes require owner/manager/admin.
- Business profile writes require owner/manager/admin.
- Supabase remains the primary persistent database; local filesystem is used only for configured runtime/session/upload fallback.


## v14.6 Account & Commerce Architecture

- Two application roles only: `admin` and `owner`.
- Public signup creates an authenticated owner profile but **does not create a business automatically**.
- Only a system admin can create businesses and assign an existing unassigned owner.
- One owner can be assigned to only one business; one business can have only one owner.
- One business can have only one WhatsApp account; a WhatsApp number is globally unique.
- Suspended users cannot authenticate through the dashboard; suspended businesses are hidden from owner membership and their WhatsApp connections are disconnected.
- Admin Center includes business/owner overview plus suspend/activate controls.
- Supabase profile trigger + legacy backfill prevents `profiles.role` from being missing for new/existing Auth users.
- Runtime state hydrates from Supabase before startup sync so an empty local filesystem does not erase the visible account/catalog/order state.

### Recommended onboarding

1. Owner creates an account (or the admin has the owner create one).
2. Admin creates the business in Admin Center.
3. Admin assigns the unassigned owner to that business.
4. Owner logs in and sees the business dashboard.
5. Owner adds exactly one WhatsApp number and connects it.
6. Owner manages products, images, inbox, orders and AI for that business only.


## v15.0.0 Production Fixes
- Preserves Gemini tool-call thought signatures by replaying original response content parts.
- Hardens multipart product-image parsing and detects image type from file bytes rather than trusting client MIME headers.
- Returns JSON for oversized upload requests instead of an HTML Express error.
- Secures pairing-code generation with the same authenticated business/account access checks as other WhatsApp account actions.
- Keeps the two-role owner/admin model and one-business/one-WhatsApp constraints.


## Product image uploads

Product images are uploaded by the authenticated dashboard to `POST /api/accounts/:id/product-image`. In production the server stores them in the Supabase Storage bucket configured by `SUPABASE_STORAGE_BUCKET` (default: `product-images`) and saves the returned public HTTPS URL in the product knowledge record. The server does not silently fall back to local disk in production.

For Supabase, run the storage section in `supabase/schema.sql` so `product-images` exists and is public. Required production environment variables include `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_STORAGE_BUCKET=product-images`, and `PUBLIC_BASE_URL`.

For local development, if Supabase is not configured, the server can use `data/uploads/products`; its URL is built from `PUBLIC_BASE_URL` or the incoming public host rather than hard-coded `localhost`.


## Version 15.0.0

Improved cart quantity intent handling for relative and absolute quantity changes. The AI now receives the live cart snapshot and explicit rules for phrases such as `ongeza ziwe tano`, `ongeza mbili`, `punguza ziwe tatu`, and `punguza moja`.
