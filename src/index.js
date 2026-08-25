/**
 * instagram-oauth — CF Worker. Hermes Instagram MCP integration.
 *
 * OAuth 2.0 authorization code flow (Instagram Login, NOT Facebook Login).
 * Two-token dance: short-lived (1h) → long-lived (60d).
 *
 * Writes the access token to CF KV namespace `OAUTH_STATE` (key prefix `instagram:`).
 * A separate cron in the hermes container (kv_bws_sync.py) bridges CF KV → BWS via the SDK.
 *
 * Endpoints:
 *   GET  /auth/ig/start         → 302 to Instagram authorize URL
 *   GET  /auth/ig/callback      → exchanges code → short → long token → stores to CF KV
 *   POST /auth/ig/refresh       → exchanges long-lived for new long-lived (60d more)
 *   GET  /healthz                 → liveness probe
 *
 * Secrets (set via `wrangler secret put`):
 *   META_APP_ID
 *   META_APP_SECRET
 *   META_REDIRECT_URI
 *   META_SCOPES       (space-separated)
 */

// ----- CSRF state (CF KV) -----
async function saveState(kv, state) {
  await kv.put("state:" + state, "1", { expirationTtl: 600 });
}
async function consumeState(kv, state) {
  if (!state) return false;
  const v = await kv.get("state:" + state);
  if (!v) return false;
  await kv.delete("state:" + state);
  return true;
}

// ----- Writeback helper (CF KV) -----
async function kvPut(kv, key, value, ttlSeconds) {
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await kv.put(key, value, opts);
}

// ----- HTTP helpers -----
function htmlResponse(status, body) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}
function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ----- Meta token helpers -----
async function exchangeCodeForShortLivedToken(env, code) {
  const body = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: env.META_REDIRECT_URI,
    code,
  });
  const r = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Instagram short-lived exchange failed ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

async function exchangeForLongLivedToken(env, shortToken) {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.META_APP_SECRET,
    access_token: shortToken,
  });
  const r = await fetch(`https://graph.instagram.com/access_token?${params}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Instagram long-lived exchange failed ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

async function refreshLongLivedToken(env, longLivedToken) {
  const params = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: longLivedToken,
  });
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?${params}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Instagram refresh failed ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

// ----- Handlers -----
async function handleStart(env, request) {
  const state = randomState();
  await saveState(env.OAUTH_STATE, state);
  const scopes = env.META_SCOPES || "instagram_business_basic instagram_business_content_publish instagram_business_manage_comments";
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: env.META_REDIRECT_URI,
    scope: scopes,
    response_type: "code",
    state,
  });
  return redirect("https://www.instagram.com/oauth/authorize?" + params.toString());
}

async function handleCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(400, `<h1>Instagram denied</h1><p>${error}: ${url.searchParams.get("error_description") ?? ""}</p>`);
  }
  if (!code || !state) {
    return htmlResponse(400, "<h1>Missing code or state</h1>");
  }
  const ok = await consumeState(env.OAUTH_STATE, state);
  if (!ok) {
    return htmlResponse(400, "<h1>Invalid or expired state. Try <a href='/auth/ig/start'>connecting again</a>.</h1>");
  }

  let shortToken, longToken;
  try {
    shortToken = await exchangeCodeForShortLivedToken(env, code);
    if (!shortToken.access_token) {
      throw new Error("Short-lived token missing access_token field: " + JSON.stringify(shortToken));
    }
    longToken = await exchangeForLongLivedToken(env, shortToken.access_token);
    if (!longToken.access_token) {
      throw new Error("Long-lived token missing access_token field: " + JSON.stringify(longToken));
    }
  } catch (e) {
    return htmlResponse(502, `<h1>Token exchange failed</h1><pre>${String(e).slice(0, 500)}</pre>`);
  }

  const issuedAt = new Date().toISOString();
  const expiresInDays = longToken.expires_in ? Math.round(longToken.expires_in / 86400) : 60;

  // Write all token fields to CF KV (key prefix "instagram:") for the kv-bws-sync cron to pick up.
  // KV entries use 90-day TTL — covers the 60-day token lifetime with buffer.
  try {
    await kvPut(env.OAUTH_STATE, "instagram:access_token", longToken.access_token, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "instagram:long_lived_token", longToken.access_token, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "instagram:issued_at", issuedAt, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "instagram:scopes", env.META_SCOPES || "", 90 * 86400);
    if (longToken.user_id) {
      await kvPut(env.OAUTH_STATE, "instagram:user_id", String(longToken.user_id), 90 * 86400);
    }
  } catch (e) {
    return htmlResponse(502, `<h1>CF KV writeback failed</h1><pre>${String(e).slice(0, 500)}</pre>`);
  }

  return htmlResponse(
    200,
    `<!doctype html><html><head><title>Instagram connected</title></head><body>
     <h1>Instagram connected ✓</h1>
     <p>Long-lived token expires in <b>${expiresInDays} days</b>. Issued at ${issuedAt}.</p>
     <p>User ID: ${longToken.user_id ?? "(unknown)"}</p>
     <p>Scopes: <code>${env.META_SCOPES || "(unknown)"}</code></p>
     <p>Token written to CF KV (kv-bws-sync will move it to BWS within 5 min).</p>
     <p>You can close this tab.</p>
     </body></html>`
  );
}

async function handleRefresh(env, request) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  let longLivedToken;
  try {
    const body = await request.json();
    longLivedToken = body.access_token;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!longLivedToken) return new Response("missing access_token", { status: 400 });

  let refreshed;
  try {
    refreshed = await refreshLongLivedToken(env, longLivedToken);
  } catch (e) {
    return new Response(String(e).slice(0, 500), { status: 502 });
  }

  const issuedAt = new Date().toISOString();
  try {
    await kvPut(env.OAUTH_STATE, "instagram:access_token", refreshed.access_token, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "instagram:long_lived_token", refreshed.access_token, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "instagram:issued_at", issuedAt, 90 * 86400);
  } catch (e) {
    return new Response("CF KV writeback failed: " + String(e).slice(0, 300), { status: 502 });
  }

  return Response.json({
    ok: true,
    expires_in: refreshed.expires_in,
    issued_at: issuedAt,
  });
}

// ----- Router -----
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/auth/ig/start") return await handleStart(env, request);
      if (url.pathname === "/auth/ig/callback") return await handleCallback(env, request);
      if (url.pathname === "/auth/ig/refresh") return await handleRefresh(env, request);
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response("server error: " + String(e).slice(0, 500), { status: 500 });
    }
  },
};