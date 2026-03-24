#!/usr/bin/env bats

# CLI smoke tests — exercises the real `qvac` binary.
# Requires: npm run build (tests run against dist/index.js)

QVAC="node $BATS_TEST_DIRNAME/../dist/index.js"

setup() {
  TEST_DIR="$(mktemp -d)"
}

teardown() {
  # Kill any server we started
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_DIR"
}

wait_for_server() {
  local port=$1 max_wait=${2:-10}
  for i in $(seq 1 "$max_wait"); do
    if curl -sf "http://127.0.0.1:${port}/v1/models" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# ── Version & help ────────────────────────────────────────────────────

@test "qvac --version prints semver" {
  run $QVAC --version
  [[ "$status" -eq 0 ]]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "qvac --help lists commands" {
  run $QVAC --help
  [[ "$status" -eq 0 ]]
  [[ "$output" =~ "bundle" ]]
  [[ "$output" =~ "serve" ]]
}

@test "qvac serve openai --help shows options" {
  run $QVAC serve openai --help
  [[ "$status" -eq 0 ]]
  [[ "$output" =~ "--port" ]]
  [[ "$output" =~ "--api-key" ]]
  [[ "$output" =~ "--cors" ]]
  [[ "$output" =~ "OpenAI-compatible" ]]
}

@test "qvac bundle sdk --help shows options" {
  run $QVAC bundle sdk --help
  [[ "$status" -eq 0 ]]
  [[ "$output" =~ "--config" ]]
  [[ "$output" =~ "--sdk-path" ]]
}

# ── Error handling ────────────────────────────────────────────────────

@test "qvac serve openai with missing config file exits 1" {
  run $QVAC serve openai -c nonexistent.json
  [[ "$status" -eq 1 ]]
  [[ "$output" =~ "Config file not found" ]]
}

@test "qvac serve openai with invalid config exits 1" {
  echo "not json" > "$TEST_DIR/qvac.config.json"
  cd "$TEST_DIR"
  run $QVAC serve openai
  [[ "$status" -eq 1 ]]
}

# ── Serve startup (no models) ────────────────────────────────────────

@test "serve starts and responds to /v1/models" {
  local port=19910

  cat > "$TEST_DIR/qvac.config.json" <<'EOF'
{ "serve": { "models": {} } }
EOF

  cd "$TEST_DIR"
  $QVAC serve openai -p "$port" &
  SERVER_PID=$!

  wait_for_server "$port"
  run curl -sf "http://127.0.0.1:${port}/v1/models"
  [[ "$status" -eq 0 ]]
  [[ "$output" =~ '"object":"list"' ]]
}

@test "serve with --cors includes CORS headers" {
  local port=19911

  cat > "$TEST_DIR/qvac.config.json" <<'EOF'
{ "serve": { "models": {} } }
EOF

  cd "$TEST_DIR"
  $QVAC serve openai -p "$port" --cors &
  SERVER_PID=$!

  wait_for_server "$port"
  local headers
  headers="$(curl -sf -D- -o /dev/null "http://127.0.0.1:${port}/v1/models")"
  [[ "$headers" =~ [Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin ]]
}

@test "serve with --api-key rejects unauthenticated requests" {
  local port=19912

  cat > "$TEST_DIR/qvac.config.json" <<'EOF'
{ "serve": { "models": {} } }
EOF

  cd "$TEST_DIR"
  $QVAC serve openai -p "$port" --api-key "test-secret" &
  SERVER_PID=$!

  # Wait for server (auth endpoint still returns 401, so check differently)
  for i in $(seq 1 10); do
    if curl -sf -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/v1/models" 2>/dev/null | grep -q "401"; then
      break
    fi
    sleep 0.5
  done

  # Without key → 401
  run curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/v1/models"
  [[ "$output" == "401" ]]

  # With key → 200
  run curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer test-secret" "http://127.0.0.1:${port}/v1/models"
  [[ "$output" == "200" ]]
}

@test "serve returns 404 for unknown endpoints" {
  local port=19913

  cat > "$TEST_DIR/qvac.config.json" <<'EOF'
{ "serve": { "models": {} } }
EOF

  cd "$TEST_DIR"
  $QVAC serve openai -p "$port" &
  SERVER_PID=$!

  wait_for_server "$port"
  run curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/v1/nonexistent"
  [[ "$output" == "404" ]]
}

@test "serve rejects chat completion without model" {
  local port=19914

  cat > "$TEST_DIR/qvac.config.json" <<'EOF'
{ "serve": { "models": {} } }
EOF

  cd "$TEST_DIR"
  $QVAC serve openai -p "$port" &
  SERVER_PID=$!

  wait_for_server "$port"
  run curl -s "http://127.0.0.1:${port}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}]}'
  [[ "$status" -eq 0 ]]
  [[ "$output" =~ '"code":"missing_model"' ]]
}

@test "serve on custom port via -p flag" {
  local port=19915

  cat > "$TEST_DIR/qvac.config.json" <<'EOF'
{ "serve": { "models": {} } }
EOF

  cd "$TEST_DIR"
  $QVAC serve openai -p "$port" &
  SERVER_PID=$!

  wait_for_server "$port"
  run curl -sf "http://127.0.0.1:${port}/v1/models"
  [[ "$status" -eq 0 ]]
}
