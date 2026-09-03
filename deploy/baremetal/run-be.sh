#!/usr/bin/env bash
# run-be.sh — launch the OCR Akta API in the FOREGROUND via backend/server.py.
#
# No DB to start, no migrations to apply (jobs are JSON files under backend/data), so this
# is a thin wrapper: set the port, sort out corporate TLS, then exec the app.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

# ── Corporate TLS / SSL-inspecting proxy ──────────────────────────────────────
# On a locked-down host, the call to the internal OCR API (AKTA_OCR_API_URL) often goes
# through an SSL-inspecting proxy presenting a CORPORATE root CA — the default trust store
# (certifi) then rejects it, and every extraction fails with a TLS error. Set SSL_CERT_FILE
# in .env to your CA bundle (PEM): conventions.sh already exports it via the `set -a` source
# of .env, and httpx honours it. Here we mirror it to requests/curl so those trust it too,
# and validate the path — a pointer to a file that is not there is worse than none, because
# the failure it causes looks like an unreachable API.
if [ -n "${SSL_CERT_FILE:-}" ]; then
  if [ -f "$SSL_CERT_FILE" ]; then
    export SSL_CERT_FILE
    export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"
    export CURL_CA_BUNDLE="$SSL_CERT_FILE"
    echo "==> [be] TLS: trusting corporate CA $SSL_CERT_FILE for the outbound OCR API call"
  else
    echo "==> [be] ⚠ SSL_CERT_FILE set but file not found: $SSL_CERT_FILE — using the default trust store" >&2
  fi
fi

# SINGLE PROCESS ON PURPOSE. The backend keeps correctness-critical state in module
# globals: the login-failure limiter, the OCR API concurrency bound, and the job-summary
# cache. Running uvicorn/gunicorn with --workers N would give each worker its own copy —
# the 5-attempt lockout would become 5*N attempts and the OCR bound would become
# N*AKTA_OCR_CONCURRENCY. To scale beyond one box, run one instance per host behind a load
# balancer with sticky-free routing and a shared AKTA_SESSION_SECRET, or move that state to
# a shared store first.
export PORT="$BE_PORT"

echo "==> [be] starting API on port $BE_PORT  (env: $BE_ENV, mode: ${AKTA_OCR_MODE:-live})"
exec "$CONDA_EXE" run --no-capture-output -n "$BE_ENV" python "$BACKEND_DIR/server.py"
