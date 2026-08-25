#!/usr/bin/env bash
# instagram-token-refresh.sh — wrapper invoked by the instagram-token-refresh cron job (daily).
set -euo pipefail
exec /opt/data/.venv/bin/python /opt/data/scripts/instagram_token_refresh.py