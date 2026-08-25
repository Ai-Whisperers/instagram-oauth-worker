# Instagram OAuth Worker — current app config

**App:** `hermes Mta access` (id `1386800143581846`, Business type, development mode)

**Why this app:** Instagram Graph API requires a Business-type app. The earlier `META_APP_ID = 918212115513499` was a Gaming "test" app and rejected the OAuth flow with "Invalid platform app".

**Instagram child app:** `916059757767251` (META_IG_APP_ID + META_IG_APP_SECRET) — used for IG-specific OAuth flows with limited scopes.

**Worker secrets (in CF Worker env):**
- `META_APP_ID = 1386800143581846` (parent Business app)
- `META_APP_SECRET = 3514260e632d44703494152edb42a4d3`
- `META_REDIRECT_URI = https://instagram-oauth.weissvanderpol-ivan.workers.dev/auth/ig/callback`
- `META_SCOPES = instagram_business_basic instagram_business_content_publish instagram_business_manage_comments`

**BWS writeback targets (after OAuth completes):**
- `META_ACCESS_TOKEN` (UUID `e83b88ef-2930-4577-bde8-b4b0011bff4b`)
- `META_IG_LONG_LIVED_TOKEN` (UUID `77aeff74-674c-4ba7-b74d-b4b100fe4499`)
- `META_TOKEN_ISSUED_AT` (UUID `348290d0-2511-45ff-990b-b4b100fe4472`)
- `META_TOKEN_SCOPES` (UUID `10057073-d3ae-4ba8-848d-b4b0011c02eb`)
- `META_IG_USER_ID` (UUID `57b326f6-1aa4-4bac-a86b-b4b100fe330b`)

**Verified working:**
- Worker `/auth/ig/start` redirects to IG with `client_id=1386800143581846`, scopes correct
- IG accepts the OAuth start (no more "Invalid platform app" error)
- The long-lived token in BWS (159 chars, `IGAANBJs...`) successfully published a real post to @ivan_weiss_van_der_pol via Graph API
- Identity verified: `id=27926586290338792, username=ivan_weiss_van_der_pol, account_type=BUSINESS`

**Test post:** Media ID `18114714968067646` (visible on @ivan_weiss_van_der_pol's Instagram feed)

**Note for future iterations:** The BWS `META_IG_USER_ID` slot (`17841402823878953`) is the actual IG Business account numeric ID — it's different from the Facebook Page ID. The Worker writes to it during OAuth.
