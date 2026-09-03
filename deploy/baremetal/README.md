# Bare-metal deploy — OCR Akta

Four scripts and one shared file, following `osg-prod/deploy/baremetal`. Two conda envs
(Python for the API, Node + nginx for the UI), everything driven by the single root `.env`,
and every runtime artefact written **outside** the checkout so the repo stays clean.

There is no database step and no migrations: jobs are JSON files under `backend/data/`,
the uploaded PDFs sit beside them, and extraction is delegated to the internal OCR API.

```
conventions.sh    sourced by all four; paths, .env load, nginx renderer, helpers
install-be.sh     conda env + pip + seed .env / auth_service.py / admin.txt
install-fe.sh     conda env + npm build + render and VALIDATE nginx.conf
run-be.sh         exec backend/server.py in the foreground
run-fe.sh         exec nginx in the foreground
```

## First install

```bash
cp .env.example .env          # install-be.sh does this too if you forget
$EDITOR .env                  # AKTA_OCR_API_URL, AKTA_OCR_API_KEY, AKTA_SESSION_SECRET

./deploy/baremetal/install-be.sh
./deploy/baremetal/install-fe.sh
```

Then start each in its own terminal (or under a supervisor):

```bash
./deploy/baremetal/run-be.sh   # :8300 by default
./deploy/baremetal/run-fe.sh   # :8080 by default, proxies /api → the backend
```

Both installs are idempotent — re-run them after a `git pull`.

## Configuration

Everything lives in the root `.env`. `conventions.sh` sources it with `set -a`, so plain
`KEY=VALUE` lines reach the child processes without `export`. Anything already in the
environment wins, so a one-off run can override without editing the file:

```bash
BACKEND_ORIGIN=https://akta-api.internal ./deploy/baremetal/install-fe.sh
```

| Variable | What it does |
|---|---|
| `BE_PORT` / `FE_PORT` | API port, nginx port |
| `FE_BIND` | interface nginx listens on (`0.0.0.0` for all) |
| `BACKEND_ORIGIN` | what nginx proxies `/api/` to — the seam for a two-VM layout |
| `RUN_DIR` | where nginx.conf, logs, pid and temp dirs go (default `~/akta-run`) |
| `SSL_CERT_FILE` | corporate CA bundle; see TLS below |
| `AKTA_MAX_UPLOAD_MB` | upload cap; also sizes nginx's `client_max_body_size` |

### Two VMs

Put the API on one host and the UI on another: install the backend on the first, then on
the second set `BACKEND_ORIGIN` to the API's URL before running `install-fe.sh`. The
rendered config sends the upstream `Host` header derived from that URL (`BACKEND_HOST`),
which is what a name-routing proxy in front of the API needs in order to route at all.

## Air-gapped hosts

conda, pip and npm must point at the internal mirrors, or the install steps hang on a
network timeout. The scripts **warn** rather than refuse — they cannot reliably tell a
configured host from an unconfigured one, and a wrong guess blocks a working deploy:

```bash
conda config --add channels https://nexus.internal/repository/conda
pip config set global.index-url https://nexus.internal/repository/pypi/simple
npm config set registry https://nexus.internal/repository/npm/
```

Any location those tools read is fine — `/etc/conda/condarc`, `$CONDA_PREFIX/.condarc`,
`~/.condarc`, `$CONDARC`; `/etc/pip.conf`, `~/.config/pip/pip.conf`, `$PIP_INDEX_URL`;
`/etc/npmrc`, `~/.npmrc`, `frontend/.npmrc`. Check with `conda config --show-sources`.

### TLS

If outbound HTTPS to the OCR API goes through an SSL-inspecting proxy, set `SSL_CERT_FILE`
in `.env` to the corporate CA bundle (PEM). `run-be.sh` mirrors it into `REQUESTS_CA_BUNDLE`
and `CURL_CA_BUNDLE`, and warns if the path does not exist — a pointer to a missing file is
worse than none, because the failure it causes reads as an unreachable API.

## Site-specific files (gitignored, seeded by install-be.sh)

| File | Why it is not in git |
|---|---|
| `.env` | holds the OCR API token and the session secret |
| `backend/auth_service.py` | each deployment decides what signing in means |
| `backend/data/admin.txt` | who may open the admin dashboard |
| `backend/data/` | job records hold PII (NIK, addresses, birthdates) |

`auth_service.py` matters most: the server **refuses to start** without it, deliberately —
an absent auth module must not be papered over with a permissive default. `install-be.sh`
seeds it from `auth_service.py.example`; replace it with the bank's own module (same
contract as osg-prod's: `is_configured`, `ldap_login_sync`, `ldap_login`) or set the
`AKTA_LDAP_*` block in `.env`.

## Scaling

**One process per host, on purpose.** The login-failure limiter, the OCR concurrency bound
and the job-summary cache are module globals, so `--workers N` would multiply all three:
the 5-attempt lockout becomes 5×N attempts, the OCR bound becomes N×`AKTA_OCR_CONCURRENCY`.
To go wider, run one instance per host behind a load balancer with a shared
`AKTA_SESSION_SECRET`, or move that state to a shared store first.

## Troubleshooting

**`nginx: [emerg] open() "…/mime.types" failed`** — nginx could not find its MIME table.
`install-fe.sh` looks in `$CONDA_PREFIX/etc/nginx/`, `/conf/` and `/etc/`, and prints which
it used; if none exist it leaves the bare name for nginx to resolve. Without a MIME table
`.js` is served as `application/octet-stream` and the page loads blank.

**`nginx: configuration file … test failed`** — the rendered file is left at
`$RUN_DIR/nginx.conf`. Read the `[emerg]` line, then that file's matching line.

**413 on upload** — a PDF reaches the OCR API base64-encoded inside JSON, ~4/3 the file
size. `CLIENT_MAX_BODY_SIZE` is derived from `AKTA_MAX_UPLOAD_MB` with that overhead
included; if a gateway sits in front of nginx, raise its limit too.

**Nobody can log in** — either `backend/auth_service.py` is missing (the API will not have
started), `AKTA_DEV_LOGIN` is off with no `AKTA_LDAP_SERVER` set, or the username is not in
`backend/data/admin.txt` (that one gates the dashboard only, not sign-in).
