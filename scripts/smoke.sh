#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CODEX_PROXY_BASE_URL:-http://127.0.0.1:${CODEX_PROXY_PORT:-3466}}"
MODEL="${CODEX_PROXY_SMOKE_MODEL:-${CODEX_PROXY_DEFAULT_MODEL:-gpt-5.5}}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 127
  }
}

post_json() {
  local path="$1"
  local data="$2"
  curl -fsS \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}${path}" \
    -d "$data"
}

need curl

echo "smoke: health ${BASE_URL}/health"
curl -fsS "${BASE_URL}/health"
echo

echo "smoke: models ${BASE_URL}/v1/models"
curl -fsS "${BASE_URL}/v1/models" >/tmp/codex-proxy-smoke-models.json
echo "models response saved to /tmp/codex-proxy-smoke-models.json"

echo "smoke: non-streaming chat model=${MODEL}"
post_json "/v1/chat/completions" \
  "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK only.\"}]}" \
  >/tmp/codex-proxy-smoke-chat.json
echo "chat response saved to /tmp/codex-proxy-smoke-chat.json"

echo "smoke: streaming chat model=${MODEL}"
curl -fsS -N \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/v1/chat/completions" \
  -d "{\"model\":\"${MODEL}\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Reply HI only.\"}]}" \
  >/tmp/codex-proxy-smoke-chat-stream.txt

if ! grep -Fq 'data: [DONE]' /tmp/codex-proxy-smoke-chat-stream.txt; then
  echo "stream did not contain [DONE]" >&2
  exit 1
fi

echo "stream response saved to /tmp/codex-proxy-smoke-chat-stream.txt"
echo "smoke: ok"
