# instagram-oauth — Cloudflare Worker

OAuth 2.0 authorization-code callback for the Hermes Instagram integration. Handles the **two-token dance** Meta requires: short-lived (1h) → long-lived (60d), plus refresh (60d more).

## Routes

| Method | Path | Purpose |
 |
|---|
| GET  | `/auth/ig/start` | Generate state, 302 to Instagram authorize URL |
| GET  | `/auth/ig/callback` | Exchange code → short → long token, write to BWS |
| POST | `/auth/ig/refresh` | Exchange long-lived for a new long-lived (60d more) |
| GET  | `/healthz` | Liveness probe |

## Required secrets (set with `wrangler secret put`)

```
META_APP_ID
META_APP_SECRET
META_REDIRECT_URI              # https://auth.hermes.paragu-ai.com/auth/ig/callback
META_SCOPES                    # "instagram_business_basic instagram_business_content_publish instagram_business_manage_comments"
BWS_ACCESS_TOKEN
BWS_BASE_URL
BWS_SECRET_ID_ACCESS_TOKEN     # UUID of the META_ACCESS_TOKEN secret (we overwrite this with the long-lived token)
BWS_SECRET_ID_LONG_LIVED_TOKEN # UUID of META_IG_LONG_LIVED_TOKEN (separate mirror slot)
BWS_SECRET_ID_ISSUED_AT        # UUID of META_TOKEN_ISSUED_AT
BWS_SECRET_ID_SCOPES           # UUID of META_TOKEN_SCOPES
BWS_SECRET_ID_USER_ID          # optional, UUID of META_IG_USER_ID
```

## Why the two-token dance?

Meta returns a 1-hour token after the OAuth dance. That token is too short to be useful for anything except exchanging it for a 60-day long-lived token. The long-lived exchange is a separate `/access_token` call that requires `app_secret` in the URL — that's why the Worker needs both `META_APP_ID` and `META_APP_SECRET`.

Long-lived tokens can be refreshed once each (60 more days), then you need to re-do the OAuth dance.

## Trademark

This Worker is `instagram-oauth`. Per the org banlist, upstream product names are restricted from public-facing surfaces; the only place `instagram_*` appears is in Meta's own API scope names (`instagram_business_basic` etc.) and the `/auth/ig/*` URL prefix, which mirrors the OAuth path Meta requires.

## DNS / hostname

Route `auth.hermes.paragu-ai.com` to this Worker (same hostname as linkedin-oauth). On Meta App settings, set the redirect URL to:
`https://auth.hermes.paragu-ai.com/auth/ig/callback`

## KV namespace

```bash
wrangler kv:namespace create OAUTH_STATE
# paste returned id into wrangler.toml under [[kv_namespaces]]
```

## Deploy

```bash
cd /opt/data/integrations/instagram-oauth-worker
wrangler kv:namespace create OAUTH_STATE   # one-time
# Set all secrets:
  wrangler secret put META_APP_ID
  wrangler secret put META_APP_SECRET
  wrangler secret put META_REDIRECT_URI
  wrangler secret put META_SCOPES
  wrangler secret put BWS_ACCESS_TOKEN
  wrangler secret put BWS_BASE_URL
  wrangler secret put BWS_SECRET_ID_ACCESS_TOKEN
  wrangler secret put BWS_SECRET_ID_LONG_LIVED_TOKEN
  wrangler secret put BWS_SECRET_ID_ISSUED_AT
  wrangler secret put BWS_SECRET_ID_SCOPES
  wrangler secret put BWS_SECRET_ID_USER_ID        # optional
# Deploy:
wrangler deploy
```