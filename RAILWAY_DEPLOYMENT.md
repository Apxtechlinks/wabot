# Railway deployment — Zetiora v15.1.0

This project is deployed as one long-running Railway service using the included Dockerfile.

## Required Railway variables

Set these in the service Variables tab. Do not upload `.env` or put secrets in GitHub.

```env
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=gemini-2.5-flash

SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=product-images

ADMIN_EMAIL=your-admin-email
NODE_ENV=production
PUBLIC_BASE_URL=https://YOUR-RAILWAY-DOMAIN
REQUIRE_SUPABASE=true

WA_AUTH_DIR=/app/data/auth_info_baileys

TRUST_PROXY=1
CHECKOUT_TOKEN_TTL_MINUTES=60
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
AUTH_RATE_LIMIT_MAX=30
CHECKOUT_RATE_LIMIT_MAX=20

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Railway supplies `PORT` automatically; do not hard-code a Railway port.

## Persistent WhatsApp session

Attach one Railway Volume to this service with mount path:

`/app/data`

Because the application stores its JSON state in `./data`, this preserves the data and the Baileys session directory configured by `WA_AUTH_DIR`.

Set:

`RAILWAY_RUN_UID=0`

Railway volumes are mounted at runtime. The service must remain a single instance because the current Baileys session/state is designed for a single owner process.

## Deploy

1. Create a Railway project.
2. Add a service from this repository (or deploy this folder with the Railway CLI).
3. Railway detects the root `Dockerfile` automatically.
4. Add the variables above.
5. Attach the `/app/data` volume.
6. Generate a public domain.
7. Set `PUBLIC_BASE_URL` to that HTTPS domain.
8. Set the Railway Healthcheck Path to `/healthz`.
9. Deploy.

The app listens on Railway's injected `PORT`.

## Important

Do not commit or upload `.env`; use Railway Variables for all secrets.
Do not run more than one replica for this WhatsApp service.
