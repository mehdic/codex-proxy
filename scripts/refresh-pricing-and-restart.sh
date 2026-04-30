#!/usr/bin/env bash
# Refresh Codex Proxy public pricing cache and restart the local proxy LaunchAgent.
# Safe: fetches public pricing only; no Codex OAuth tokens or secrets are handled here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="${CODEX_PROXY_LOG_DIR:-$HOME/.openclaw/logs}"
mkdir -p "$LOG_DIR"

cd "$PROJECT_DIR"

if [[ ! -f dist/server/standalone.js ]]; then
  npm run build
fi

node scripts/update-pricing.mjs

UID_VALUE="$(id -u)"
# Prefer the reusable codex-proxy LaunchAgent label, but also support the
# existing TradingAgents-managed label used on Mehdi's Mac mini.
for label in com.mehdic.codex-proxy fr.chaouachi.tradingagents.codex-proxy; do
  if launchctl print "gui/${UID_VALUE}/${label}" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/${UID_VALUE}/${label}"
    echo "restarted ${label}"
    exit 0
  fi
done

echo "warning: no known Codex Proxy LaunchAgent label is currently loaded" >&2
