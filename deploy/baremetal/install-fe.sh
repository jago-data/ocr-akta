#!/usr/bin/env bash
# install-fe.sh — provision/update the FRONTEND. Idempotent. Does NOT start nginx.
#
#   • create/update the conda env (Node + nginx)
#   • reproducible npm install (npm ci when a lockfile exists)
#   • build the production bundle → frontend/dist
#   • render nginx.conf into the run dir, then validate it (nginx -t)
#
# Point it at the backend FIRST for the two-VM layout:
#   export BACKEND_ORIGIN=https://example-api.com
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

# Air-gapped hosts resolve packages through the internal mirror. A WARNING, not a refusal:
# npm reads a system file, a project file and two env vars besides ~/.npmrc, and a check
# narrow enough to miss those turns a correctly configured host away for no reason.
_npm_configured=""
for npmrc in "${NPM_CONFIG_USERCONFIG:-}" "${NPM_CONFIG_GLOBALCONFIG:-}" "$HOME/.npmrc" \
             "$FRONTEND_DIR/.npmrc" "$REPO_ROOT/.npmrc" /etc/npmrc; do
  if [ -n "$npmrc" ] && [ -f "$npmrc" ]; then
    _npm_configured="$npmrc"
    break
  fi
done
if [ -z "$_npm_configured" ] && [ -z "${NPM_CONFIG_REGISTRY:-}" ]; then
  echo "    ⚠ no npm registry configuration found (/etc/npmrc, ~/.npmrc, frontend/.npmrc,"
  echo "      \$NPM_CONFIG_REGISTRY). On an air-gapped host npm cannot reach the public"
  echo "      registry — point it at the internal one if the install below hangs:"
  echo "        npm config set registry https://nexus.internal/repository/npm/"
fi

echo "==> [fe] conda env: $FE_ENV"
if "$CONDA_EXE" env list | awk '{print $1}' | grep -qx "$FE_ENV"; then
  "$CONDA_EXE" env update -n "$FE_ENV" -f "$_CONV_DIR/environment-fe.yml"
else
  "$CONDA_EXE" env create -n "$FE_ENV" -f "$_CONV_DIR/environment-fe.yml"
fi

echo "==> [fe] npm install + build (→ $FRONTEND_DIST)"
if [ -f "$FRONTEND_DIR/package-lock.json" ]; then
  ( cd "$FRONTEND_DIR" && "$CONDA_EXE" run --no-capture-output -n "$FE_ENV" npm ci )
else
  ( cd "$FRONTEND_DIR" && "$CONDA_EXE" run --no-capture-output -n "$FE_ENV" npm install )
fi
( cd "$FRONTEND_DIR" && "$CONDA_EXE" run --no-capture-output -n "$FE_ENV" npm run build )

echo "==> [fe] render nginx.conf (→ $NGINX_CONF)"
mkdir -p "$RUN_DIR"/tmp/{client_body,proxy,fastcgi,uwsgi,scgi} "$RUN_DIR"/logs
# Resolve nginx's packaged mime.types to an absolute path in the env so `include` works no
# matter what prefix nginx runs under. Only override when the file is really there — the
# conventions default is the bare name `mime.types`, which nginx resolves against its own
# prefix, so a miss here degrades to nginx's own lookup instead of a hard failure.
# (This used to hard-code <env>/bin/../conf/mime.types, which does not exist on conda-forge
# builds; the include then failed and `nginx -t` rejected the whole config.)
FE_PREFIX="$("$CONDA_EXE" run --no-capture-output -n "$FE_ENV" bash -lc 'printf "%s" "$CONDA_PREFIX"')"
for candidate in "$FE_PREFIX/etc/nginx/mime.types" "$FE_PREFIX/conf/mime.types" \
                 "$FE_PREFIX/etc/mime.types"; do
  if [ -f "$candidate" ]; then
    export MIME_TYPES="$candidate"
    break
  fi
done
echo "    mime.types: $MIME_TYPES"
render_nginx_conf > "$NGINX_CONF"

echo "==> [fe] validate (nginx -t)"
if ! "$CONDA_EXE" run --no-capture-output -n "$FE_ENV" nginx -t -c "$NGINX_CONF"; then
  echo "" >&2
  echo "    nginx rejected the rendered config. It is left in place at:" >&2
  echo "      $NGINX_CONF" >&2
  echo "    Read the [emerg] line above, then that file's matching line." >&2
  exit 1
fi

# Make the run script executable so `./deploy/baremetal/run-fe.sh` works even if the
# checkout tracked it as non-executable (e.g. cloned over a Windows/WSL mount).
chmod +x "$_CONV_DIR/run-fe.sh" 2>/dev/null || true

echo "==> [fe] done.  /api → $BACKEND_ORIGIN  (upstream Host: $BACKEND_HOST)"
echo "    Serving $FRONTEND_DIST on $FE_BIND:$FE_PORT, bodies up to $CLIENT_MAX_BODY_SIZE"
echo "    Start with:  ./deploy/baremetal/run-fe.sh"
