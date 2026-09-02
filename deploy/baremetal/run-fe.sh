#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

mkdir -p "$RUN_DIR"/tmp/{client_body,proxy,fastcgi,uwsgi,scgi} "$RUN_DIR/logs"
exec "$CONDA_EXE" run -n "$FE_ENV" nginx -c "$NGINX_CONF" -g 'daemon off;'
