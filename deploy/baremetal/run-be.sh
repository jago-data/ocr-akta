#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

# Corporate SSL-inspecting proxies: mirror the CA bundle into every client lib.
if [ -n "${SSL_CERT_FILE:-}" ]; then
  export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE" CURL_CA_BUNDLE="$SSL_CERT_FILE"
fi

# SINGLE PROCESS ON PURPOSE. The backend keeps correctness-critical state in
# module globals: the login-failure limiter, the OCR API concurrency bound, and
# the job-summary cache. Running uvicorn/gunicorn with --workers N would give
# each worker its own copy — the 5-attempt lockout would become 5*N attempts and
# the OCR bound would become N*AKTA_OCR_CONCURRENCY. To scale beyond one box,
# run one instance per host behind a load balancer with sticky-free routing and
# a shared AKTA_SESSION_SECRET, or move that state to a shared store first.
export PORT="$BE_PORT"
exec "$CONDA_EXE" run --no-capture-output -n "$BE_ENV" python "$REPO_ROOT/backend/server.py"
