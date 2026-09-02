#!/usr/bin/env bash
# Shared conventions for the baremetal deploy — SOURCED by every script, never executed.
# Mirrors osg-prod: repo-relative paths, single root .env auto-exported, conda envs,
# nginx rendered from a heredoc with all runtime paths under $RUN_DIR.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Auto-export plain KEY=VALUE lines so child processes (python, nginx render) see them.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

: "${BE_ENV:=akta-be}"
: "${FE_ENV:=akta-fe}"
: "${RUN_DIR:=$HOME/akta-run}"
: "${CONDA_EXE:=conda}"

: "${BE_PORT:?not set — put it in .env (see .env.example)}"
: "${FE_PORT:?not set — put it in .env (see .env.example)}"
: "${FE_BIND:?not set — put it in .env (see .env.example)}"
: "${BACKEND_ORIGIN:?not set — put it in .env (see .env.example)}"

FRONTEND_DIST="$REPO_ROOT/frontend/dist"
NGINX_CONF="$RUN_DIR/nginx.conf"
BACKEND_HOST="$(printf '%s' "$BACKEND_ORIGIN" | sed -E 's#^[a-z]+://##; s#/.*$##')"

render_nginx_conf() {
  cat <<NGINX
worker_processes  auto;
error_log  $RUN_DIR/logs/error.log;
pid        $RUN_DIR/nginx.pid;
events { worker_connections 4096; }
http {
  include            \$MIME_TYPES_FILE;
  default_type       application/octet-stream;
  access_log         $RUN_DIR/logs/access.log;
  client_body_temp_path $RUN_DIR/tmp/client_body;
  proxy_temp_path       $RUN_DIR/tmp/proxy;
  fastcgi_temp_path     $RUN_DIR/tmp/fastcgi;
  uwsgi_temp_path       $RUN_DIR/tmp/uwsgi;
  scgi_temp_path        $RUN_DIR/tmp/scgi;
  client_max_body_size 40m;
  sendfile on;

  server {
    listen $FE_BIND:$FE_PORT;
    root   $FRONTEND_DIST;

    location /api/ {
      proxy_pass $BACKEND_ORIGIN/;
      proxy_set_header Host $BACKEND_HOST;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_ssl_server_name on;
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 600s;
    }

    location /assets/ {
      add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location = /index.html {
      add_header Cache-Control "no-cache";
    }
    location / {
      try_files \$uri \$uri/ /index.html;
    }
  }
}
NGINX
}
