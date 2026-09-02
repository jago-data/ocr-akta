# OCR Akta — Ekstraksi Akta Pendirian PT

Web app that extracts structured data from Indonesian notarial deeds (akta
pendirian / perubahan Perseroan Terbatas): upload a PDF, get back a fixed
17-field JSON record (company identity, Pasal 1–3 facts, Direksi, Dewan
Komisaris, shareholdings), with an admin dashboard tracking usage.

## Architecture

```
frontend (React/Vite/Tailwind, :5178 dev)
   └── /api/*  ──proxy──▶  backend (FastAPI, :8300)
                              ├── ocr_service.py   two-stage Qwen-VL pipeline
                              │     stage 1: PyMuPDF page render → vision OCR per page
                              │     stage 2: chunked extraction → merge → postprocess
                              ├── postprocess.py   deterministic schema guarantee
                              ├── jobs.py          JSON-file job store (data/jobs/)
                              └── usage.py         usage_log.jsonl + /admin/analytics
                                        │
                                        ▼ only outbound call
                              OPENAI_BASE_URL (OpenAI-compatible vLLM endpoint)
```

- **Auth**: LDAP in production (`AKTA_LDAP_*`), `AKTA_DEV_LOGIN=1` locally.
  Per-user tokens (`X-Akta-Token`) scope uploads/jobs; admins are usernames
  listed in `backend/data/admin.txt` and get a signed `X-Akta-Admin-Token`.
- **Admin dashboard** (`/admin`): totals, success rate, pages processed, average
  latency, per-user table, daily activity chart, recent activity, XLSX export.
- **Response format** follows `../ocr/ocr-akta` exactly — the system prompt
  (`backend/prompts/ocr-akta.md`) and post-processor are copied verbatim.

## Quick start

```bash
cp .env.example .env         # fill OPENAI_BASE_URL / OPENAI_API_KEY / AKTA_MODEL
                             # set AKTA_DEV_LOGIN=1 for local dev
cd backend && pip install -r requirements.txt && python server.py   # :8300
cd frontend && npm install && npm run dev                            # :5178
```

Login with any username/password (dev mode). The seeded admin user is `admin`
(edit `backend/data/admin.txt`). The extraction model must be **vision-capable**
(it receives page images); set `AKTA_OCR_MODEL` if OCR and extraction use
different models.

## Deploy

`deploy/baremetal/` mirrors osg-prod: `install-be.sh` / `install-fe.sh` create
conda envs (`akta-be`, `akta-fe`) and build; `run-be.sh` / `run-fe.sh` start
uvicorn and nginx. One root `.env` drives everything. Production is air-gapped:
no CDN/font/external-API dependencies; the LLM endpoint is the only outbound call.

## Tests

```bash
cd backend && python -m pytest tests/ -q   # 24 network-free tests
```
