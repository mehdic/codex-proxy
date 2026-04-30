#!/usr/bin/env bash
# Install the codex-proxy macOS LaunchAgent plist.
# Resolves nvm Node path and user home directory automatically.
# Safe: does not handle Codex OAuth tokens or secrets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$PROJECT_DIR/launchagents/com.mehdic.codex-proxy.plist"
REFRESH_TEMPLATE="$PROJECT_DIR/launchagents/com.mehdic.codex-proxy-pricing-refresh.plist"
TARGET="$HOME/Library/LaunchAgents/com.mehdic.codex-proxy.plist"
REFRESH_TARGET="$HOME/Library/LaunchAgents/com.mehdic.codex-proxy-pricing-refresh.plist"
LOG_DIR="$HOME/.openclaw/logs"

for template in "$TEMPLATE" "$REFRESH_TEMPLATE"; do
  if [[ ! -f "$template" ]]; then
    echo "error: plist template not found at $template" >&2
    exit 1
  fi
done

# Resolve Node path — prefer nvm current, fall back to which node
if command -v nvm >/dev/null 2>&1; then
  NODE_PATH="$(nvm which current 2>/dev/null || which node)"
elif [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # Source nvm if available but not loaded
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh" --no-use 2>/dev/null
  NODE_PATH="$(nvm which current 2>/dev/null || which node)"
else
  NODE_PATH="$(which node)"
fi

if [[ -z "$NODE_PATH" || ! -x "$NODE_PATH" ]]; then
  echo "error: could not find node binary" >&2
  exit 1
fi

NODE_BIN_DIR="$(dirname "$NODE_PATH")"

echo "node:       $NODE_PATH"
echo "home:       $HOME"
echo "project:    $PROJECT_DIR"
echo "log dir:    $LOG_DIR"
echo "target:     $TARGET"
echo "refresh:    $REFRESH_TARGET"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Ensure dist is built
if [[ ! -f "$PROJECT_DIR/dist/server/standalone.js" ]]; then
  echo "warning: dist/server/standalone.js not found — run 'npm run build' first" >&2
fi

# Generate plist from template
sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$TARGET"

sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$REFRESH_TEMPLATE" > "$REFRESH_TARGET"

echo "plist installed to $TARGET"
echo "pricing refresh plist installed to $REFRESH_TARGET"

# Bootout if already loaded (ignore errors if not loaded)
launchctl bootout "gui/$(id -u)/com.mehdic.codex-proxy" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.mehdic.codex-proxy-pricing-refresh" 2>/dev/null || true

# Bootstrap
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$REFRESH_TARGET"
echo "launchagent loaded"
echo "weekly pricing refresh loaded (Mondays 07:00 local time)"

# Quick liveness check
sleep 1
if curl -fsS "http://127.0.0.1:3466/health" >/dev/null 2>&1; then
  echo "health check: ok"
else
  echo "health check: proxy not responding yet (may still be starting)"
fi
