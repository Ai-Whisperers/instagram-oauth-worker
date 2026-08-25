/**
 * instagram-oauth — Cloudflare Worker implementing the OAuth 2.0 authorization
 * code flow for the Hermes Instagram integration (Instagram Login, NOT Facebook
 * Login — see references/auth-flow-choice.md).
 *
 * Endpoints:
 *   GET  /auth/ig/start         → 302 to Instagram authorize URL (with state cookie)
 *   GET  /auth/ig/callback      → exchanges code for token, writes long-lived token to BWS
 *   POST /auth/ig/refresh       → exchanges refresh_token for a new long-lived token
 *   GET  /healthz               → liveness probe
 *
 * Two-token dance (Meta-specific):
 *   Step 1: short-lived token from /oauth/access_token (1h TTL)
 *   Step 2: long-lived token from /access_token (60d TTL, requires public_content +
 *           instagram_business_basic permissions AND a Meta Business account linked
 *           to a Facebook Page in the same app)
 *
 * For long-lived refresh (additional 60d):
 *   POST /refresh_access_token with grant_type=ig_refresh_token
 *
 * Secrets required (set with `wrangler secret put`):
 *   META_APP_ID
 *   META_APP_SECRET
 *   META_REDIRECT_URI              e.g. https://auth.hermes.paragu-ai.com/auth/ig/callback
 *   META_SCOPES                    space-separated, default "instagram_business_basic instagram_business_content_publish instagram_business_manage_comments instagram_business_manage_messages"
 *   BWS_ACCESS_TOKEN               Bitwarden Secrets Manager service-account token
 *   BWS_BASE_URL                   default https://vault.bitwarden.com/api
 *   BWS_SECRET_ID_ACCESS_TOKEN     UUID of the META_ACCESS_TOKEN secret (the short-lived one we overwrite)
 *   BWS_SECRET_ID_LONG_LIVED_TOKEN UUID of a NEW secret META_IG_LONG_LIVED_TOKEN (60d)
 *   BWS_SECRET_ID_ISSUED_AT        UUID of META_TOKEN_ISSUED_AT
 *   BWS_SECRET_ID_SCOPES           UUID of META_TOKEN_SCOPES
 *   BWS_SECRET_ID_REFRESH_TOKEN    UUID of a NEW secret META_IG_REFRESH_TOKEN (optional, comes from refresh)
 *
 * Trademark note: this Worker is `instagram-oauth` per the org banlist
 * carve-outs. The internal class names / API endpoints use the upstream
 * "instagram_*" naming because that's what Meta calls them — those are
 * internal references only and not exposed in any user-facing string.
 */

// ----- BWS client (minimal REST wrapper) -----
async function bwsPutSecret(baseUrl, bwsToken, secretId, value) {
  const r = await fetch(`${baseUrl}/secrets/${secretId}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${bwsToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`BWS PUT failed ${r.status}: ${t.slice(0, 200)}`);
  }
  return await r.json();
}

// ----- State store (10-min TTL via KV) -----
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
  // Step 1: short-lived (1h) token via Instagram Login
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
  // Step 2: short → long (60d). Requires app secret in URL.
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
  // Step 3: refresh long → new long (60d more, one-shot per token).
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

  // Write all BWS secrets
  const baseUrl = env.BWS_BASE_URL || "https://vault.bitwarden.com/api";
  const writes = [
    // Overwrite the META_ACCESS_TOKEN with the long-lived one (same slot, what MCP reads)
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ACCESS_TOKEN, longToken.access_token),
    // Mirror the long-lived into its own slot for clarity
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_LONG_LIVED_TOKEN, longToken.access_token),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ISSUED_AT, issuedAt),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_SCOPES, env.META_SCOPES || ""),
  ];
  if (longToken.user_id && env.BWS_SECRET_ID_USER_ID) {
    writes.push(bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_USER_ID, String(longToken.user_id)));
  }

  let writeErrors = [];
  await Promise.all(writes.map((p) => p.catch((e) => writeErrors.push(String(e).slice(0, 200)))));

  if (writeErrors.length === writes.length) {
    return htmlResponse(502, `<h1>Instagram authorized but BWS writes failed</h1><pre>${writeErrors.join("\n")}</pre>`);
  }

  return htmlResponse(
    200,
    `<!doctype html><html><head><title>Instagram connected</title></head><body>
     <h1>Instagram connected ✓</h1>
     <p>Long-lived token expires in <b>${expiresInDays} days</b>. Issued at ${issuedAt}.</p>
     <p>User ID: ${longToken.user_id ?? "(unknown)"}</p>
     <p>Scopes: <code>${env.META_SCOPES || "(unknown)"}</code></p>
     ${writeErrors.length ? `<p style="color:#c80">⚠️ ${writeErrors.length} of ${writes.length} secret writes failed — check logs.</p>` : ""}
     <p>You can close this tab. Restart Hermes to pick up the new token.</p>
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
  const baseUrl = env.BWS_BASE_URL || "https://vault.bitwarden.com/api";
  await Promise.all([
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ACCESS_TOKEN, refreshed.access_token),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_LONG_LIVED_TOKEN, refreshed.access_token),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ISSUED_AT, issuedAt),
  ]);

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