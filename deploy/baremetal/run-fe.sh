#!/usr/bin/env bash
# run-fe.sh — serve frontend/dist through nginx in the FOREGROUND.
#
# install-fe.sh renders and validates $NGINX_CONF; this only starts it. `daemon off;`
# keeps nginx in the foreground so a process supervisor (or Ctrl-C) owns its lifetime.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

if [ ! -f "$NGINX_CONF" ]; then
  echo "ERROR: $NGINX_CONF does not exist — run ./deploy/baremetal/install-fe.sh first." >&2
  exit 1
fi
if [ ! -f "$FRONTEND_DIST/index.html" ]; then
  echo "ERROR: no build at $FRONTEND_DIST — run ./deploy/baremetal/install-fe.sh first." >&2
  exit 1
fi

# The temp dirs live outside the repo and can be swept between runs, so recreate them
# rather than assuming install-fe.sh ran on this boot.
mkdir -p "$RUN_DIR"/tmp/{client_body,proxy,fastcgi,uwsgi,scgi} "$RUN_DIR"/logs

echo "==> [fe] serving $FRONTEND_DIST on $FE_BIND:$FE_PORT  (/api → $BACKEND_ORIGIN)"
echo "    logs: $RUN_DIR/logs/{access,error}.log"
exec "$CONDA_EXE" run --no-capture-output -n "$FE_ENV" nginx -c "$NGINX_CONF" -g 'daemon off;'
