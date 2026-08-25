#!/usr/bin/env python3
"""instagram-token-refresh — checks META_ACCESS_TOKEN validity and refreshes if needed.

Runs as a cron (daily). When the token is within 14 days of expiry, calls the Worker's
/refresh endpoint with the stored long-lived token. The Worker handles the Meta
ig_refresh_token flow and writes the new token back to CF KV (which the kv-bws-sync
cron then moves to BWS).
"""
from __future__ import annotations
import os
import sys
import json
import urllib.request
from datetime import datetime, timezone, timedelta

INSTAGRAM_WORKER_URL = "https://instagram-oauth.weissvanderpol-ivan.workers.dev/auth/ig/refresh"
REFRESH_THRESHOLD_DAYS = 14


def fetch_bws_secret(key):
    """Read a BWS secret via the SDK."""
    sys.path.insert(0, "/opt/data")
    from bitwarden_sdk import BitwardenClient, ClientSettings, DeviceType
    import uuid as _uuid
    token = open("/opt/data/.hermes/inbox/bws-token.secret").read().strip()
    org_id = open("/opt/data/.hermes/inbox/org-id.txt").read().strip()
    s = ClientSettings(
        api_url="https://api.bitwarden.com",
        identity_url="https://identity.bitwarden.com",
        user_agent="instagram-token-refresh/1.0",
        device_type=DeviceType.SERVER,
    )
    c = BitwardenClient(s)
    c.auth().login_access_token(token, None)
    r = c.secrets().list(_uuid.UUID(org_id))
    for sec in r.to_dict()["data"]["data"]:
        if isinstance(sec, dict) and sec.get("key") == key:
            return c.secrets().get(sec["id"]).to_dict()["data"]["value"]
    return None


def main():
    print("Checking Instagram token validity...")
    issued_at = fetch_bws_secret("META_TOKEN_ISSUED_AT")
    access_token = fetch_bws_secret("META_ACCESS_TOKEN")

    if not issued_at or not access_token or access_token == "placeholder":
        print("  No Instagram token in BWS yet — skipping (OAuth not completed)")
        return 0

    try:
        issued = datetime.fromisoformat(issued_at.replace("Z", "+00:00"))
    except Exception:
        print(f"  Could not parse META_TOKEN_ISSUED_AT: {issued_at!r}")
        return 0

    expires_at = issued + timedelta(days=60)  # IG long-lived tokens are 60 days
    days_remaining = (expires_at - datetime.now(timezone.utc)).days

    print(f"  Token issued: {issued_at}")
    print(f"  Days remaining: {days_remaining}")

    if days_remaining > REFRESH_THRESHOLD_DAYS:
        print(f"  Token still valid (> {REFRESH_THRESHOLD_DAYS} days), no refresh needed")
        return 0

    print(f"  Refreshing token via Worker...")
    body = json.dumps({"access_token": access_token}).encode()
    req = urllib.request.Request(
        INSTAGRAM_WORKER_URL,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        if result.get("ok"):
            print(f"  ✓ Refresh succeeded. New expires_in: {result.get('expires_in')}s")
            print(f"  Worker wrote new token to CF KV. kv-bws-sync will move to BWS within 5 min.")
            return 0
        else:
            print(f"  ✗ Refresh failed: {result}")
            return 1
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")[:300]
        print(f"  ✗ Refresh HTTP {e.code}: {body}")
        print(f"  Alert: May need to re-walk OAuth at {INSTAGRAM_WORKER_URL.replace('/refresh', '/start')}")
        return 1
    except Exception as e:
        print(f"  ✗ Refresh error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())