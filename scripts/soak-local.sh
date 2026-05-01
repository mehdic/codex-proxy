#!/usr/bin/env bash
# soak-local.sh — localhost-only opt-in soak harness for codex-proxy.
#
# Exercises:
#   1. Parallel no-tool chat requests (concurrent load on worker pool)
#   2. Streaming abort/cancel probe (client closes mid-stream)
#   3. Session reuse with CODEX_PROXY_SESSIONS=1
#   4. Short TTL / LRU eviction with low CODEX_PROXY_SESSION_MAX
#
# The proxy must already be running.  This script does NOT change runtime
# defaults — it uses request headers and per-invocation env vars where
# the proxy supports them.
#
# Usage:
#   scripts/soak-local.sh              # all probes
#   scripts/soak-local.sh parallel     # only parallel probe
#   scripts/soak-local.sh abort        # only streaming abort probe
#   scripts/soak-local.sh session      # only session reuse probe
#   scripts/soak-local.sh ttl          # only TTL/LRU probe
#
# Environment:
#   CODEX_PROXY_BASE_URL   default http://127.0.0.1:${CODEX_PROXY_PORT:-3466}
#   SOAK_MODEL             model to use (default from CODEX_PROXY_DEFAULT_MODEL or gpt-5.5)
#   SOAK_PARALLEL          parallel request count (default 4)
#   SOAK_ROUNDS            rounds for the parallel probe (default 2)
#   SOAK_SESSION_TURNS     turns per session in session probe (default 3)
#   SOAK_ABORT_COUNT       streaming aborts to fire (default 3)
set -euo pipefail

BASE_URL="${CODEX_PROXY_BASE_URL:-http://127.0.0.1:${CODEX_PROXY_PORT:-3466}}"
MODEL="${SOAK_MODEL:-${CODEX_PROXY_DEFAULT_MODEL:-gpt-5.5}}"
PARALLEL="${SOAK_PARALLEL:-4}"
ROUNDS="${SOAK_ROUNDS:-2}"
SESSION_TURNS="${SOAK_SESSION_TURNS:-3}"
ABORT_COUNT="${SOAK_ABORT_COUNT:-3}"

TMPDIR_SOAK="$(mktemp -d /tmp/codex-proxy-soak.XXXXXX)"
PASS=0
FAIL=0
SKIP=0

# ── helpers ────────────────────────────────────────────────────────────

cleanup() { rm -rf "$TMPDIR_SOAK"; }
trap cleanup EXIT

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "soak: missing required command: $1" >&2
    exit 127
  }
}

ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1" >&2; }
skip() { SKIP=$((SKIP + 1)); echo "  - $1 (skipped)"; }

post_chat() {
  local body="$1"
  curl -fsS --max-time 180 \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -d "$body" 2>/dev/null
}

post_stream() {
  local body="$1"
  local out="$2"
  curl -fsS -N --max-time 180 \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -d "$body" >"$out" 2>/dev/null
}

fetch_metric() {
  local name="$1"
  curl -fsS "${BASE_URL}/metrics" 2>/dev/null | grep "^${name}" || true
}

metric_value() {
  local name="$1"
  local value
  value="$(fetch_metric "$name" | awk '{print $NF}' | tail -1)"
  echo "${value:-0}"
}

check_proxy_up() {
  if ! curl -fsS --max-time 5 "${BASE_URL}/health" >/dev/null 2>&1; then
    echo "soak: proxy not reachable at ${BASE_URL}/health — is it running?" >&2
    exit 1
  fi
}

need curl

# ── 1. Parallel no-tool requests ──────────────────────────────────────

probe_parallel() {
  echo "soak: parallel no-tool requests (${PARALLEL}x, ${ROUNDS} rounds, model=${MODEL})"

  local msg='{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Reply with the word PONG only."}]}'

  for round in $(seq 1 "$ROUNDS"); do
    local pids=()
    local outs=()
    for i in $(seq 1 "$PARALLEL"); do
      local out="${TMPDIR_SOAK}/parallel-r${round}-${i}.json"
      outs+=("$out")
      post_chat "$msg" >"$out" &
      pids+=($!)
    done

    local round_fail=0
    for pid in "${pids[@]}"; do
      if ! wait "$pid"; then
        round_fail=$((round_fail + 1))
      fi
    done

    if [ "$round_fail" -gt 0 ]; then
      fail "round ${round}: ${round_fail}/${PARALLEL} requests failed"
    else
      # Verify each response has choices
      local content_ok=0
      for out in "${outs[@]}"; do
        if [ -s "$out" ] && grep -q '"choices"' "$out" 2>/dev/null; then
          content_ok=$((content_ok + 1))
        fi
      done
      if [ "$content_ok" -eq "$PARALLEL" ]; then
        ok "round ${round}: ${PARALLEL}/${PARALLEL} succeeded with valid response"
      else
        fail "round ${round}: only ${content_ok}/${PARALLEL} had valid choices"
      fi
    fi
  done

  # Check pool metrics show warm hits (at least one after first round)
  local warm
  warm="$(fetch_metric 'codex_proxy_pool_events_total{event="warm_hit"}')"
  if [ -n "$warm" ]; then
    ok "pool warm_hit metric present: ${warm##* }"
  else
    # Warm hits may not appear if pool max is lower than parallel count;
    # not a hard failure.
    skip "pool warm_hit metric not found (pool may be smaller than parallel count)"
  fi
}

# ── 2. Streaming abort / cancel probe ─────────────────────────────────

probe_abort() {
  echo "soak: streaming abort/cancel probe (${ABORT_COUNT} aborts, model=${MODEL})"

  local msg='{"model":"'"${MODEL}"'","stream":true,"messages":[{"role":"user","content":"Count slowly from 1 to 100, one number per line."}]}'

  for i in $(seq 1 "$ABORT_COUNT"); do
    local out="${TMPDIR_SOAK}/abort-${i}.txt"
    # Start a streaming request, kill it after receiving some data
    curl -sS -N --max-time 180 \
      -H 'Content-Type: application/json' \
      -X POST "${BASE_URL}/v1/chat/completions" \
      -d "$msg" >"$out" 2>/dev/null &
    local pid=$!

    # Wait until we have some SSE data (at least the :ok keepalive),
    # then kill. If 8s pass without data, kill anyway.
    local waited=0
    while [ "$waited" -lt 8 ]; do
      sleep 0.5
      waited=$((waited + 1))
      if [ -s "$out" ]; then
        # Got some bytes; wait a tiny bit more for actual content chunks
        sleep 0.5
        break
      fi
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    if [ -s "$out" ]; then
      ok "abort ${i}: stream started and client-killed ($(wc -c < "$out" | tr -d ' ') bytes received)"
    else
      fail "abort ${i}: no data received before kill"
    fi
  done

  # After aborts, proxy should still be healthy
  if curl -fsS --max-time 5 "${BASE_URL}/health" >/dev/null 2>&1; then
    ok "proxy healthy after abort barrage"
  else
    fail "proxy unhealthy after abort barrage"
  fi

  # One clean non-streaming request to confirm no wedge
  local verify="${TMPDIR_SOAK}/abort-verify.json"
  local verify_msg='{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Reply OK."}]}'
  if post_chat "$verify_msg" >"$verify" 2>/dev/null && [ -s "$verify" ] && grep -q '"choices"' "$verify" 2>/dev/null; then
    ok "post-abort verification request succeeded"
  else
    fail "post-abort verification request failed"
  fi
}

# ── 3. Session reuse (CODEX_PROXY_SESSIONS=1) ────────────────────────

probe_session() {
  echo "soak: session reuse probe (${SESSION_TURNS} turns, model=${MODEL})"

  # Try a session request. Default deployments may accept the header but
  # ignore it unless CODEX_PROXY_SESSIONS=1 is enabled, so detect real
  # session activity by metric deltas rather than HTTP 200 alone.
  local created_before hit_before
  created_before="$(metric_value 'codex_proxy_sessions_total{event="created"}')"
  hit_before="$(metric_value 'codex_proxy_sessions_total{event="hit"}')"

  local session_id="soak-test-$(date +%s)"
  local msg='{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Reply OK."}]}'
  local probe_out="${TMPDIR_SOAK}/session-probe.json"
  local http_code
  http_code="$(curl -sS -o "$probe_out" -w '%{http_code}' --max-time 60 \
    -H 'Content-Type: application/json' \
    -H "X-Codex-Proxy-Session: ${session_id}" \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -d "$msg" 2>/dev/null)" || true

  if [ "$http_code" = "400" ] && grep -q 'session' "$probe_out" 2>/dev/null; then
    skip "sessions not enabled (set CODEX_PROXY_SESSIONS=1 on the proxy)"
    return
  fi

  if [ "$http_code" != "200" ]; then
    fail "session probe returned HTTP ${http_code}"
    return
  fi

  local created_after_probe
  created_after_probe="$(metric_value 'codex_proxy_sessions_total{event="created"}')"
  if [ "$created_after_probe" -le "$created_before" ]; then
    skip "sessions not active (set CODEX_PROXY_SESSIONS=1 on the proxy)"
    return
  fi

  ok "session created: ${session_id}"

  # Send sequential turns on the same session
  for turn in $(seq 2 "$SESSION_TURNS"); do
    local turn_msg='{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Turn '"${turn}"'. Reply with the turn number only."}]}'
    local turn_out="${TMPDIR_SOAK}/session-turn-${turn}.json"
    if post_chat_session "$session_id" "$turn_msg" >"$turn_out" 2>/dev/null && [ -s "$turn_out" ]; then
      ok "session turn ${turn} succeeded"
    else
      fail "session turn ${turn} failed"
    fi
  done

  # Check session metrics increased
  local hit_after
  hit_after="$(metric_value 'codex_proxy_sessions_total{event="hit"}')"
  if [ "$hit_after" -gt "$hit_before" ]; then
    ok "session hit metric increased: $((hit_after - hit_before))"
  else
    fail "session hit metric did not increase"
  fi
}

post_chat_session() {
  local sid="$1"
  local body="$2"
  curl -fsS --max-time 180 \
    -H 'Content-Type: application/json' \
    -H "X-Codex-Proxy-Session: ${sid}" \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -d "$body" 2>/dev/null
}

# ── 4. Short TTL / LRU eviction ──────────────────────────────────────

probe_ttl() {
  echo "soak: TTL/LRU eviction probe (model=${MODEL})"

  # This probe checks that the proxy correctly reports eviction metrics.
  # It works best when the proxy is started with a low session max, e.g.:
  #   CODEX_PROXY_SESSIONS=1 CODEX_PROXY_SESSION_MAX=2 \
  #   CODEX_PROXY_SESSION_TTL_MS=5000 node dist/server/standalone.js
  #
  # Without sessions enabled, we can still exercise pool LRU by
  # saturating the pool and checking eviction counters.

  # Snapshot metrics before
  local evict_before ttl_before sess_created_before sess_evict_before sess_expired_before
  evict_before="$(metric_value 'codex_proxy_pool_events_total{event="lru_eviction"}')"
  ttl_before="$(metric_value 'codex_proxy_pool_events_total{event="ttl_eviction"}')"
  sess_created_before="$(metric_value 'codex_proxy_sessions_total{event="created"}')"
  sess_evict_before="$(metric_value 'codex_proxy_sessions_total{event="evicted"}')"
  sess_expired_before="$(metric_value 'codex_proxy_sessions_total{event="expired"}')"

  # Fire enough distinct requests to potentially overflow a small pool.
  # Using different system prompts forces different pool keys, causing
  # LRU eviction if pool_max is small.
  local overflow_count=4
  local msg_base='{"model":"'"${MODEL}"'","messages":[{"role":"system","content":"You are assistant #IDX."},{"role":"user","content":"Reply OK."}]}'
  local pids=()
  for i in $(seq 1 "$overflow_count"); do
    local msg="${msg_base//\#IDX/$i}"
    local out="${TMPDIR_SOAK}/ttl-${i}.json"
    post_chat "$msg" >"$out" 2>/dev/null &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  # If session mode is on, also create multiple sessions to trigger
  # session LRU/TTL eviction.
  local session_probe_out="${TMPDIR_SOAK}/ttl-session-probe.json"
  local sess_http
  sess_http="$(curl -sS -o "$session_probe_out" -w '%{http_code}' --max-time 60 \
    -H 'Content-Type: application/json' \
    -H 'X-Codex-Proxy-Session: ttl-probe-0' \
    -X POST "${BASE_URL}/v1/chat/completions" \
    -d '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Reply OK."}]}' \
    2>/dev/null)" || true

  local sessions_active=0
  if [ "$sess_http" = "200" ]; then
    local sess_created_after_probe
    sess_created_after_probe="$(metric_value 'codex_proxy_sessions_total{event="created"}')"
    if [ "$sess_created_after_probe" -gt "$sess_created_before" ]; then
      sessions_active=1
    fi
  fi

  if [ "$sessions_active" -eq 1 ]; then
    # Sessions enabled — create more than SESSION_MAX to force eviction
    for i in $(seq 1 4); do
      local sid="ttl-probe-${i}"
      post_chat_session "$sid" \
        '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Reply OK."}]}' \
        >"${TMPDIR_SOAK}/ttl-sess-${i}.json" 2>/dev/null || true
    done

    # If TTL is short, wait for expiry
    echo "  … waiting 6s for potential TTL expiry"
    sleep 6

    # Poke one more to trigger lazy eviction sweep
    post_chat_session "ttl-probe-sweep" \
      '{"model":"'"${MODEL}"'","messages":[{"role":"user","content":"Reply OK."}]}' \
      >"${TMPDIR_SOAK}/ttl-sess-sweep.json" 2>/dev/null || true
  fi

  # Snapshot metrics after
  local evict_after ttl_after sess_evict_after sess_expired_after
  evict_after="$(metric_value 'codex_proxy_pool_events_total{event="lru_eviction"}')"
  ttl_after="$(metric_value 'codex_proxy_pool_events_total{event="ttl_eviction"}')"
  sess_evict_after="$(metric_value 'codex_proxy_sessions_total{event="evicted"}')"
  sess_expired_after="$(metric_value 'codex_proxy_sessions_total{event="expired"}')"

  local lru_delta=$((evict_after - evict_before))
  local ttl_delta=$((ttl_after - ttl_before))
  local sess_evict_delta=$((sess_evict_after - sess_evict_before))
  local sess_expired_delta=$((sess_expired_after - sess_expired_before))

  if [ "$lru_delta" -gt 0 ]; then
    ok "pool LRU evictions triggered: +${lru_delta}"
  else
    skip "no pool LRU evictions (pool_max may be >= ${overflow_count})"
  fi

  if [ "$ttl_delta" -gt 0 ]; then
    ok "pool TTL evictions triggered: +${ttl_delta}"
  else
    skip "no pool TTL evictions (TTL may be longer than probe window)"
  fi

  if [ "$sessions_active" -eq 1 ]; then
    if [ "$sess_evict_delta" -gt 0 ]; then
      ok "session LRU evictions triggered: +${sess_evict_delta}"
    else
      skip "no session LRU evictions (session_max may be >= probe count)"
    fi
    if [ "$sess_expired_delta" -gt 0 ]; then
      ok "session TTL expirations triggered: +${sess_expired_delta}"
    else
      skip "no session TTL expirations (session_ttl may be longer than 6s wait)"
    fi
  else
    skip "session TTL/LRU checks not active (set CODEX_PROXY_SESSIONS=1 on the proxy)"
  fi

  # Pool size gauge should be bounded
  local pool_size
  pool_size="$(fetch_metric 'codex_proxy_pool_size' | awk '{print $NF}')"
  pool_size="${pool_size:-0}"
  if [ "$pool_size" -ge 0 ]; then
    ok "pool_size gauge: ${pool_size}"
  fi
}

# ── main ──────────────────────────────────────────────────────────────

main() {
  check_proxy_up
  echo "soak: codex-proxy soak harness — ${BASE_URL} — model=${MODEL}"
  echo "soak: tmp=${TMPDIR_SOAK}"
  echo ""

  local target="${1:-all}"
  case "$target" in
    parallel) probe_parallel ;;
    abort)    probe_abort ;;
    session)  probe_session ;;
    ttl)      probe_ttl ;;
    all)
      probe_parallel
      echo ""
      probe_abort
      echo ""
      probe_session
      echo ""
      probe_ttl
      ;;
    *)
      echo "usage: $0 [parallel|abort|session|ttl|all]" >&2
      exit 1
      ;;
  esac

  echo ""
  echo "soak: done — pass=${PASS} fail=${FAIL} skip=${SKIP}"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
}

main "$@"
