# Meta App Creation Walkthrough — for Hermes Instagram integration

## What we need

The current Meta app in BWS (`META_APP_ID = 918212115513499`, name "test") is a **Facebook Gaming app**. Instagram Graph API requires a **Business-type app** with the Instagram product enabled.

This walkthrough creates a new Business app and replaces the credentials.

## Step-by-step

### 1. Create the app

1. Go to https://developers.facebook.com/apps
2. Click **Create App** (top right)
3. Choose use case: **Other** (or "Manage business assets" if available)
4. App type: **Business** ← important
5. Fill in:
   - App name: `Hermes Social Agent` (or anything you want)
   - Contact email: your email
6. Click **Create App** (may require business verification)

### 2. Add Instagram product

1. In your new app dashboard, scroll to **Add a Product**
2. Find **Instagram** → click **Set Up**
3. Choose **Instagram Login** (NOT Facebook Login for Instagram)
4. Follow the setup wizard

### 3. Configure OAuth redirect URIs

1. In the Instagram product → **Instagram API setup** → **Basic Display** (or similar)
2. Find **Valid OAuth Redirect URIs** (or "Deauthorize Callback URL" / "Valid Redirect URIs")
3. Add EXACTLY:
   ```
   https://instagram-oauth.weissvanderpol-ivan.workers.dev/auth/ig/callback
   ```
   (No trailing slash, no whitespace)
4. Save changes

### 4. Request permissions

1. **App Review** → **Permissions and Features**
2. Request these permissions (Standard Access for own accounts is usually instant):
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments`
   - (optional) `instagram_business_manage_messages` for DMs
3. For testing on your own account, no App Review needed — these are auto-approved for the app's admin
4. For client work (other people's accounts), needs App Review: 1-2 weeks

### 5. Configure Instagram Business account connection

1. **Instagram** → **API setup** with Instagram Login
2. Click **Add Account** → log in to your IG Business account
3. Note the **Instagram User ID** (numeric, in the URL after linking)
4. Note your **Facebook Page ID** (Settings → Page → About → Page ID)

### 6. Get credentials

1. **Settings** → **Basic**:
   - Copy **App ID** → paste to BWS as `META_APP_ID` (replace `918212115513499`)
   - Copy **App Secret** → paste to BWS as `META_APP_SECRET` (replace `2032b7965ec68214f378...`)
2. **Instagram** → **Basic Display**:
   - Note **Instagram App ID** (often same as App ID, but verify)
   - Note **Instagram User ID** (your business account's numeric ID)

### 7. Update BWS with new credentials

You have two options:

**Option A — Paste via web UI:**
1. Go to vault.bitwarden.com → Secrets Manager → hermes project
2. Edit `META_APP_ID`, replace value
3. Edit `META_APP_SECRET`, replace value
4. Edit `META_IG_USER_ID`, replace value (currently placeholder)
5. Edit `META_IG_PAGE_ID`, replace value (currently placeholder)
6. Save

**Option B — Paste via the populate script:**
```bash
/opt/data/.venv/bin/python /opt/data/scripts/populate_social_secrets.py instagram
# Will prompt for any missing/placeholder values
```

### 8. Update Worker env vars

After BWS is updated, tell me to refresh the Worker env vars. I'll re-run `wrangler secret bulk` with the new values from BWS.

### 9. Test the OAuth flow

Once the new Meta app is connected:
1. Open `https://instagram-oauth.weissvanderpol-ivan.workers.dev/auth/ig/start`
2. Should redirect to Instagram's consent screen (with proper IG Business scopes)
3. Click **Allow**
4. Should land on the Worker's "Instagram connected ✓" page
5. Worker writes token to CF KV → kv-bws-sync cron moves to BWS within 5 min
6. Verify with `mcp_social_graph_mcp_sanity_ping`

## FAQ

**Q: Why do we need Business app and not Gaming or Consumer?**
A: Instagram Graph API is restricted to Business apps. Gaming apps can't request Instagram products.

**Q: Will the OAuth flow work without App Review?**
A: Yes, for YOUR OWN accounts (admin/developer/tester). For posting on behalf of OTHER users, you need App Review (1-2 weeks).

**Q: How does this differ from the old "test" app?**
A: Old app was Gaming-type and wasn't a real business app. Instagram OAuth requests fail because the app type doesn't support it.

**Q: Do I need to delete the old "test" app?**
A: No — leave it for now. The new app will replace it functionally. Once everything works, you can delete the old app from Meta dashboard.

## What if you don't want to create a new app?

**Option C — Use the old test app via Facebook Login instead:**
- Requires adding Facebook Login product (different OAuth flow)
- Different Worker code path
- 2-3 hours of additional work
- Not recommended — Business app is the right path

**Option D — Skip Meta for now, focus on LinkedIn:**
- LinkedIn OAuth with `hermes 2` app is already working (after the CF KV refactor)
- linkedin-mcp + social-graph-mcp wait for tokens to be written
- Meta can be addressed later

## Time estimate

- New Meta app creation: 10 min
- Permissions request (own account): instant
- Permissions request (other accounts): 1-2 weeks
- Total to working Instagram MCP: 10 min (for own account)