#!/usr/bin/env bash
# Idempotent backend install — creates/updates the conda env, installs pip deps,
# seeds config files. Does NOT start anything (run-be.sh does).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/conventions.sh"

# Air-gapped hosts resolve packages through the internal mirror. Without that
# config these commands hang on a network timeout instead of saying why.
if [ ! -f "$HOME/.condarc" ] && [ -z "${CONDA_CHANNELS:-}" ]; then
  echo "ERROR: no ~/.condarc found. On an air-gapped host, point conda at the" >&2
  echo "       internal mirror first (channels + default_channels)." >&2
  exit 1
fi
if [ ! -f "$HOME/.pip/pip.conf" ] && [ ! -f "$HOME/.config/pip/pip.conf" ] \
   && [ -z "${PIP_INDEX_URL:-}" ]; then
  echo "ERROR: no pip index configured. Set PIP_INDEX_URL to the internal" >&2
  echo "       PyPI mirror (or create ~/.config/pip/pip.conf)." >&2
  exit 1
fi

if "$CONDA_EXE" env list | awk '{print $1}' | grep -qx "$BE_ENV"; then
  "$CONDA_EXE" env update -n "$BE_ENV" -f "$REPO_ROOT/deploy/baremetal/environment-be.yml"
else
  "$CONDA_EXE" env create -f "$REPO_ROOT/deploy/baremetal/environment-be.yml"
fi
"$CONDA_EXE" run -n "$BE_ENV" pip install -r "$REPO_ROOT/backend/requirements.txt"

# Seed config — never clobber an existing one.
[ -f "$REPO_ROOT/.env" ] || cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
mkdir -p "$REPO_ROOT/backend/data"
if [ ! -f "$REPO_ROOT/backend/data/admin.txt" ]; then
  cp "$REPO_ROOT/backend/admin.txt.example" "$REPO_ROOT/backend/data/admin.txt"
  echo "seeded backend/data/admin.txt — edit it to list the real admin usernames"
fi

_need() {
  local val
  val="$(grep -E "^$1=" "$REPO_ROOT/.env" | head -1 | cut -d= -f2- || true)"
  [ -n "$val" ] || echo "WARNING: $1 is empty in .env — $2"
}
_need AKTA_OCR_API_URL "the internal OCR API URL (the app's only outbound call)"
_need AKTA_OCR_API_KEY "the internal OCR API x-api-key"
_need AKTA_SESSION_SECRET "set it so restarts don't log admins out"

chmod +x "$REPO_ROOT/deploy/baremetal/run-be.sh"
echo "backend install done — start with deploy/baremetal/run-be.sh"
