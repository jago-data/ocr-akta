#!/usr/bin/env bash
# Frontend install — conda env (node + nginx), npm build, render + validate nginx.conf.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

if "$CONDA_EXE" env list | awk '{print $1}' | grep -qx "$FE_ENV"; then
  "$CONDA_EXE" env update -n "$FE_ENV" -f "$REPO_ROOT/deploy/baremetal/environment-fe.yml"
else
  "$CONDA_EXE" env create -f "$REPO_ROOT/deploy/baremetal/environment-fe.yml"
fi

if [ ! -f "$HOME/.npmrc" ] && [ -z "${NPM_CONFIG_REGISTRY:-}" ]; then
  echo "ERROR: no npm registry configured. Set NPM_CONFIG_REGISTRY to the" >&2
  echo "       internal registry (or create ~/.npmrc) before installing." >&2
  exit 1
fi

cd "$REPO_ROOT/frontend"
if [ -f package-lock.json ]; then
  "$CONDA_EXE" run -n "$FE_ENV" npm ci
else
  "$CONDA_EXE" run -n "$FE_ENV" npm install
fi
"$CONDA_EXE" run -n "$FE_ENV" npm run build

mkdir -p "$RUN_DIR"/tmp/{client_body,proxy,fastcgi,uwsgi,scgi} "$RUN_DIR/logs"
MIME_TYPES_FILE="$("$CONDA_EXE" run -n "$FE_ENV" sh -c 'dirname "$(command -v nginx)"')/../conf/mime.types"
export MIME_TYPES_FILE
render_nginx_conf | sed "s#\$MIME_TYPES_FILE#$MIME_TYPES_FILE#" > "$NGINX_CONF"
"$CONDA_EXE" run -n "$FE_ENV" nginx -t -c "$NGINX_CONF"

chmod +x "$REPO_ROOT/deploy/baremetal/run-fe.sh"
echo "frontend install done — start with deploy/baremetal/run-fe.sh"
