#!/usr/bin/env bash
# install-be.sh — provision/update the BACKEND. Idempotent. Does NOT start the API.
#
#   • create/update the conda env (Python runtime)
#   • pip install backend/requirements.txt
#   • ensure the root .env exists (seed from .env.example; never clobber)
#   • seed the two gitignored, site-specific files: auth_service.py and data/admin.txt
#   • sanity-check the required settings
#
# There is NO database step and NO migrations: jobs are JSON files under backend/data,
# the original PDFs sit beside them, and extraction is delegated to the internal OCR API.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

# Air-gapped hosts resolve packages through the internal mirror. These are WARNINGS, not
# refusals: an operator may be injecting config another way, and a check that guesses at
# file paths gets it wrong. Ask the tool — `conda config --show-sources` lists every file
# conda really reads (/etc/conda/condarc, $CONDA_PREFIX/.condarc, ~/.condarc, $CONDARC),
# which is the actual question. The old check tested ~/.condarc alone and refused hosts
# that were configured correctly somewhere else.
if ! "$CONDA_EXE" config --show-sources 2>/dev/null | grep -q '^==>' \
   && [ -z "${CONDA_CHANNELS:-}" ]; then
  echo "    ⚠ conda reports no configuration at all. On an air-gapped host it cannot"
  echo "      resolve packages — point it at the internal mirror if the step below hangs:"
  echo "        conda config --add channels https://nexus.internal/repository/conda"
  echo "      Verify with: conda config --show-sources"
fi
_pip_configured=""
for pip_conf in "${PIP_CONFIG_FILE:-}" "$HOME/.pip/pip.conf" "$HOME/.config/pip/pip.conf" \
                /etc/pip.conf /etc/xdg/pip/pip.conf; do
  if [ -n "$pip_conf" ] && [ -f "$pip_conf" ]; then
    _pip_configured="$pip_conf"
    break
  fi
done
if [ -z "$_pip_configured" ] && [ -z "${PIP_INDEX_URL:-}" ]; then
  echo "    ⚠ no pip index configuration found (/etc/pip.conf, ~/.config/pip/pip.conf,"
  echo "      \$PIP_INDEX_URL). Point pip at the internal mirror if the step below hangs:"
  echo "        pip config set global.index-url https://nexus.internal/repository/pypi/simple"
fi

echo "==> [be] conda env: $BE_ENV"
if "$CONDA_EXE" env list | awk '{print $1}' | grep -qx "$BE_ENV"; then
  "$CONDA_EXE" env update -n "$BE_ENV" -f "$_CONV_DIR/environment-be.yml"
else
  "$CONDA_EXE" env create -n "$BE_ENV" -f "$_CONV_DIR/environment-be.yml"
fi

echo "==> [be] pip install backend/requirements.txt"
"$CONDA_EXE" run --no-capture-output -n "$BE_ENV" \
  python -m pip install -r "$BACKEND_DIR/requirements.txt"

echo "==> [be] ensure .env (single config file at repo root)"
ENV_FILE="$REPO_ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_ROOT/.env.example" "$ENV_FILE"
  echo "    created $ENV_FILE from .env.example — FILL IN AKTA_OCR_API_URL + AKTA_OCR_API_KEY."
  # .env.example ships this blank, and the server REFUSES TO START without it — so a
  # host that copies the example and changes nothing else fails at import with an error
  # about a value nobody chose. It is an arbitrary random string, so generate one.
  if [ -z "$(_grep_env AKTA_SESSION_SECRET "$ENV_FILE" || true)" ]; then
    _secret="$("$CONDA_EXE" run --no-capture-output -n "$BE_ENV" \
               python -c 'import secrets; print(secrets.token_urlsafe(32))' 2>/dev/null \
               || head -c 32 /dev/urandom | base64 | tr -d '=+/' )"
    set_env_var AKTA_SESSION_SECRET "$_secret" "$ENV_FILE"
    echo "    generated AKTA_SESSION_SECRET (signs admin dashboard tokens)."
    echo "    Behind a load balancer, every instance must carry the SAME value."
  fi
fi

# ── Site-specific files, gitignored so a pull never overwrites what a deployment set.
#    Both are seeded rather than left missing: an operator should edit a file that already
#    exists instead of discovering they had to create one.
echo "==> [be] seed site-specific files"
if [ ! -f "$BACKEND_DIR/auth_service.py" ]; then
  cp "$BACKEND_DIR/auth_service.py.example" "$BACKEND_DIR/auth_service.py"
  echo "    created $BACKEND_DIR/auth_service.py from the template."
  echo "    It decides what signing in MEANS here. Replace it with the bank's own module"
  echo "    (same contract as osg-prod's), or set the AKTA_LDAP_* block in .env. Without"
  echo "    either, logins are identity capture only — sound behind the bank's access"
  echo "    controls, and nothing more. The server REFUSES TO START if this file is gone."
fi
mkdir -p "$BACKEND_DIR/data"
ADMIN_FILE="$BACKEND_DIR/data/admin.txt"
if [ ! -f "$ADMIN_FILE" ]; then
  cp "$BACKEND_DIR/admin.txt.example" "$ADMIN_FILE"
  echo "    created $ADMIN_FILE — edit it to list the real admin usernames."
fi
if ! grep -qE '^[[:space:]]*[^#[:space:]]' "$ADMIN_FILE"; then
  echo "    ⚠ $ADMIN_FILE lists nobody — the admin dashboard is closed to everyone until"
  echo "      you add usernames to it (one per line)."
fi

# Required-setting check. Warn rather than fail: an operator may inject these through the
# environment instead of the file.
_need() {  # _need VAR "hint"
  local v; v="$(_grep_env "$1" "$ENV_FILE" || true)"
  if [ -z "${v}" ] && [ -z "${!1:-}" ]; then
    echo "    ⚠ $1 is empty in $ENV_FILE and unset in the environment — $2"
  fi
}
_need AKTA_OCR_API_URL     "extraction cannot run — this is the app's only outbound call."
_need AKTA_OCR_API_KEY     "the OCR API will reject every request as unauthenticated."
_need AKTA_SESSION_SECRET  "the backend WILL NOT START — see the hint it prints."
echo "    All config (OCR API, auth, limits, branding, deploy vars) lives in this one"
echo "    $ENV_FILE — see .env.example. No config.yaml."

# Make the run script executable so `./deploy/baremetal/run-be.sh` works even if the
# checkout tracked it as non-executable (e.g. cloned over a Windows/WSL mount).
chmod +x "$_CONV_DIR/run-be.sh" 2>/dev/null || true

echo "==> [be] done. Start with:  ./deploy/baremetal/run-be.sh"
