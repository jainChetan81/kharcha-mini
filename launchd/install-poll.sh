#!/usr/bin/env bash
set -euo pipefail

LABEL="com.chetan.kharcha-mini-poll"
PLIST_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/com.chetan.kharcha-mini-poll.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"

echo "installing ${LABEL}..."

mkdir -p "${LOG_DIR}"
cp "${PLIST_SRC}" "${PLIST_DST}"

# Unload first so repeated installs are idempotent.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
# bootout can return before the job is gone; bootstrap then fails with error 5.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || break
  sleep 0.5
done

launchctl bootstrap "gui/$(id -u)" "${PLIST_DST}"
echo "installed and loaded ${LABEL}"

# Test the real launchd environment (not the shell).
echo "kickstarting job (this exercises the actual launchd path)..."
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
echo "done. logs: ${LOG_DIR}/kharcha-mini-poll.*.log"
