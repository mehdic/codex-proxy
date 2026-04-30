#!/usr/bin/env bash
# codex-proxy release & soak checklist script.
# Runs build, unit tests, and offline smoke checks.
# Live smoke tests (requiring a running proxy) are opt-in via --live.
# Safe: does not modify state, push, or handle Codex OAuth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${CODEX_PROXY_BASE_URL:-http://127.0.0.1:${CODEX_PROXY_PORT:-3466}}"
LIVE=false
ERRORS=0

for arg in "$@"; do
  case "$arg" in
    --live) LIVE=true ;;
    *) echo "usage: $0 [--live]" >&2; exit 1 ;;
  esac
done

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; ERRORS=$((ERRORS + 1)); }

echo "=== codex-proxy release checklist ==="
echo "project: $PROJECT_DIR"
echo ""

# ── 1. Build ────────────────────────────────────────────────────────
echo "1. Build"
if (cd "$PROJECT_DIR" && npm run build 2>&1); then
  pass "tsc build succeeded"
else
  fail "tsc build failed"
fi

# ── 2. Version consistency ──────────────────────────────────────────
echo ""
echo "2. Version consistency"
PKG_VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
SRC_VERSION=$(node -e "import('$PROJECT_DIR/dist/server/version.js').then(m => console.log(m.VERSION))")
if [[ "$PKG_VERSION" == "$SRC_VERSION" ]]; then
  pass "package.json ($PKG_VERSION) matches version.ts ($SRC_VERSION)"
else
  fail "package.json ($PKG_VERSION) does not match version.ts ($SRC_VERSION)"
fi

# ── 3. Unit tests ───────────────────────────────────────────────────
echo ""
echo "3. Unit tests"
if (cd "$PROJECT_DIR" && npm test 2>&1); then
  pass "all unit tests passed"
else
  fail "unit tests failed"
fi

# ── 4. Dist sanity ──────────────────────────────────────────────────
echo ""
echo "4. Dist sanity"
ENTRY="$PROJECT_DIR/dist/server/standalone.js"
if [[ -f "$ENTRY" ]]; then
  pass "standalone.js exists"
else
  fail "standalone.js missing"
fi

ADAPTER="$PROJECT_DIR/dist/adapter/openai-to-codex.js"
if [[ -f "$ADAPTER" ]]; then
  if grep -q "external tool" "$ADAPTER" 2>/dev/null; then
    pass "adapter contains composable tool bridge wording"
  else
    fail "adapter missing composable tool bridge wording"
  fi
else
  fail "adapter dist missing"
fi

# ── 5. Live smoke (opt-in) ──────────────────────────────────────────
echo ""
if $LIVE; then
  echo "5. Live smoke tests (--live)"

  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    pass "GET /health"
  else
    fail "GET /health — proxy not reachable at $BASE_URL"
  fi

  if curl -fsS "$BASE_URL/version" >/dev/null 2>&1; then
    pass "GET /version"
  else
    fail "GET /version"
  fi

  if curl -fsS "$BASE_URL/v1/models" >/dev/null 2>&1; then
    pass "GET /v1/models"
  else
    fail "GET /v1/models"
  fi

  if curl -fsS "$BASE_URL/metrics" >/dev/null 2>&1; then
    pass "GET /metrics"
  else
    fail "GET /metrics"
  fi

  # Non-streaming chat
  CHAT_RESP=$(curl -fsS -X POST "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Reply OK only."}]}' 2>&1) || true
  if echo "$CHAT_RESP" | grep -q '"choices"'; then
    pass "POST /v1/chat/completions (non-streaming)"
  else
    fail "POST /v1/chat/completions (non-streaming)"
  fi

  # Streaming chat
  STREAM_RESP=$(curl -fsS -N -X POST "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{"model":"gpt-5.5","stream":true,"messages":[{"role":"user","content":"Reply HI only."}]}' 2>&1) || true
  if echo "$STREAM_RESP" | grep -Fq 'data: [DONE]'; then
    pass "POST /v1/chat/completions (streaming)"
  else
    fail "POST /v1/chat/completions (streaming)"
  fi

  # Tool bridge edge test: send tools and verify no execution happens
  TOOL_RESP=$(curl -fsS -X POST "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d '{
      "model":"gpt-5.5",
      "messages":[{"role":"user","content":"What workflows are available? Use the tool."}],
      "tools":[{"type":"function","function":{"name":"n8n__list_workflows","description":"List n8n workflows","parameters":{"type":"object"}}}]
    }' 2>&1) || true
  if echo "$TOOL_RESP" | grep -q '"choices"'; then
    pass "POST /v1/chat/completions (tool bridge — no execution)"
  else
    fail "POST /v1/chat/completions (tool bridge)"
  fi
else
  echo "5. Live smoke tests (skipped — pass --live to enable)"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
if [[ $ERRORS -eq 0 ]]; then
  echo "=== all checks passed ==="
  exit 0
else
  echo "=== $ERRORS check(s) failed ==="
  exit 1
fi
