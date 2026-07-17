#!/usr/bin/env bash
set -euo pipefail

LABEL="com.chetan.kharcha-mini-api"
PLIST_SRC="${BASH_SOURCE[0]%/*}/com.chetan.kharcha-mini-api.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"

echo "installing ${LABEL}..."

mkdir -p "${LOG_DIR}"
cp "${PLIST_SRC}" "${PLIST_DST}"

# Unload first so repeated installs are idempotent.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

launchctl bootstrap "gui/$(id -u)" "${PLIST_DST}"
echo "installed and loaded ${LABEL}"

# Test the real launchd environment (not the shell).
echo "kickstarting job (this exercises the actual launchd path)..."
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
echo "done. logs: ${LOG_DIR}/kharcha-mini-api.*.log"
