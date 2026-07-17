#!/usr/bin/env bash
# Kharcha mini daily digest formatter for Hermes cron.
# Reads today's summary from the local API and prints a Telegram-ready message
# to stdout. Hermes delivers stdout verbatim when no_agent=true.
set -euo pipefail

API_URL="http://127.0.0.1:8300/digest/today"
TOKEN=$(security find-generic-password -s kharcha-mini-api-token -a mini -w 2>/dev/null) || {
  echo "kharcha digest: missing bearer token in Keychain" >&2
  exit 1
}

PAYLOAD=$(curl -fsS -m 10 -H "Authorization: Bearer ${TOKEN}" "${API_URL}" 2>/dev/null) || {
  echo "kharcha digest: API call failed" >&2
  exit 1
}

COUNT=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("transactionCount",0))')
SPEND=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("totalSpend",0))')
REVIEW=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("reviewCount",0))')

if [ "$COUNT" -eq 0 ] && [ "$REVIEW" -eq 0 ]; then
  # Silent when there's nothing to report (watchdog pattern).
  exit 0
fi

printf '**kharcha digest**\n\n'
printf 'transactions today: %s\n' "$COUNT"
printf 'total spend: ₹%s\n' "$SPEND"
printf 'need review: %s\n' "$REVIEW"
