"""OCR Akta — FastAPI backend.

Endpoints (the frontend proxies /api/* here with the prefix stripped):
  GET  /app                    branding (name/tagline) — env-driven, no rebuild
  POST /auth/login             identity capture -> role (+ admin token)
  POST /extract                multipart PDF upload -> job record (runs in background)
  GET  /jobs                   caller's job list (token-scoped)
  GET  /jobs/{job_id}          one job incl. the extracted 17-key record
  GET  /admin/analytics        usage events for the dashboard (admin token)
  GET  /admin/analytics/stamp  cheap change fingerprint for the dashboard poll
  GET  /health                 liveness
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from starlette.datastructures import UploadFile as StarletteUploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import config
import jobs
import ocr_client
import usage

try:
    import auth_service
except ImportError as exc:                                    # noqa: BLE001
    # Refusing to start is the safe direction. An absent auth module could otherwise be
    # papered over with a permissive default, and nobody would notice until the audit.
    raise SystemExit(
        "backend/auth_service.py is missing — it is gitignored so each deployment keeps "
        "its own. Copy the template to create it:\n"
        "    cp backend/auth_service.py.example backend/auth_service.py"
    ) from exc

app = FastAPI(title="OCR Akta", version="1.0.0")


class BodySizeLimitMiddleware:
    """Reject oversize bodies while they stream, BEFORE Starlette's multipart
    parser spools them to a temp file. Checks inside the endpoint cannot do this:
    FastAPI resolves `File(...)` (i.e. parses the whole body) before the handler
    runs, so the app's own size check only ever sees an already-buffered upload.
    Raw ASGI on purpose — BaseHTTPMiddleware buffers the body itself."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return

        declared = dict(scope.get("headers") or {}).get(b"content-length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            await _send_413(send)
            return

        seen = 0
        too_big = False
        responded = False

        async def limited_receive():
            nonlocal seen, too_big
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    too_big = True
                    # stop feeding the parser; the handler never runs
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message):
            """Once the body is over the limit WE own the response: the app
            downstream would otherwise answer 400 'error parsing the body',
            which tells the user nothing about the real cause."""
            nonlocal responded
            if not too_big:
                await send(message)
                return
            if not responded and message["type"] == "http.response.start":
                responded = True
                await _send_413(send)
            # anything else the app produced is discarded

        await self.app(scope, limited_receive, guarded_send)
        if too_big:
            if not responded:
                responded = True
                await _send_413(send)
            print(f"  upload refused: body exceeded {self.max_bytes} bytes", flush=True)


async def _send_413(send) -> None:
    body = b'{"detail":"file too large"}'
    await send({"type": "http.response.start", "status": 413,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


# No CORS middleware, deliberately. The browser only ever talks to its own origin: vite
# proxies /api in dev, nginx proxies /api/ in prod. An Access-Control-Allow-Origin header
# would buy nothing and cost something — /jobs/{id} returns NIK, addresses and birthdates,
# and "*" would let any page a signed-in user visits read them.
# Added LAST so it is OUTERMOST: add_middleware prepends, so the last one added
# wraps the rest. 16 KB of slack for the multipart envelope around the PDF.
app.add_middleware(BodySizeLimitMiddleware, max_bytes=config.MAX_UPLOAD_BYTES + 16384)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
ADMIN_USERS_FILE = os.path.join(DATA_DIR, "admin.txt")
# A per-process random secret would make admin tokens invalid across restarts,
# so it is required rather than generated.
if not config.SESSION_SECRET:
    raise RuntimeError(
        "AKTA_SESSION_SECRET is empty. It signs admin dashboard session tokens, and is "
        "required rather than generated per boot because a fresh key would invalidate "
        "every admin session on every restart. Any long random string will do:\n"
        "    python3 -c \"import secrets; print(secrets.token_urlsafe(32))\"\n"
        "Put it in .env as AKTA_SESSION_SECRET=<value>. Behind a load balancer, every "
        "instance must carry the SAME value or sessions break as requests move between "
        "them. (deploy/baremetal/install-be.sh generates one when it creates .env.)")
_SESSION_SECRET = config.SESSION_SECRET

# Process-wide admission control: bounds how many uploads are resident at once,
# independent of the per-user cap (which a caller can multiply by varying username).
_admission = asyncio.Semaphore(config.MAX_CONCURRENT_UPLOADS)

# Per-user run slots. A user may have MAX_ACTIVE_PER_USER documents in flight but only
# CONCURRENT_PER_USER of them extracting at any moment; the others hold "queued" until a
# slot frees. One semaphore per user, created on first use and dropped when that user has
# nothing left running, so the dict cannot grow without bound.
_user_slots: dict = {}
_user_slots_lock = asyncio.Lock()


async def _acquire_slot(user: str):
    async with _user_slots_lock:
        slot = _user_slots.get(user)
        if slot is None:
            slot = asyncio.Semaphore(config.CONCURRENT_PER_USER)
            _user_slots[user] = slot
    await slot.acquire()
    return slot


async def _release_slot(user: str, slot) -> None:
    slot.release()
    async with _user_slots_lock:
        # Fully idle again: forget this user rather than keeping a semaphore per person
        # who has ever uploaded. `_value` is the count of free permits.
        if _user_slots.get(user) is slot and slot._value >= config.CONCURRENT_PER_USER:
            _user_slots.pop(user, None)

# asyncio.Task objects must stay strongly referenced or GC can drop them mid-run
_background_tasks: set = set()


# ---------------------------------------------------------------------------
# Admin gate — data/admin.txt IS the gate, re-read on every request
# ---------------------------------------------------------------------------
def _load_admin_usernames() -> set:
    users = set()
    try:
        with open(ADMIN_USERS_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    users.add(line.lower())
    except FileNotFoundError:
        pass
    return users


def _is_admin_user(username: str, verbose: bool = False) -> bool:
    u = (username or "").strip().lower()
    if u in _load_admin_usernames():
        return True
    if verbose:
        # never print the roster itself — it would copy admin.txt into every log
        print(f"  admin check failed for {u!r}: not listed in "
              f"{os.path.abspath(ADMIN_USERS_FILE)}", flush=True)
    return False


# ---------------------------------------------------------------------------
# Signed sessions (HMAC) + per-user tokens, persisted across restarts
# ---------------------------------------------------------------------------
def _sign_session(username: str, scope: str) -> str:
    payload = f"{scope}:{(username or '').strip().lower()}:{int(time.time()) + config.SESSION_TTL_S}"
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    mac = hmac.new(_SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{mac}"


def _open_session(token: str, scope: str) -> str:
    try:
        body, mac = (token or "").split(".", 1)
        payload = base64.urlsafe_b64decode((body + "=" * (-len(body) % 4)).encode()).decode()
        expected = hmac.new(_SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(mac, expected):
            return ""
        got_scope, username, expires = payload.split(":", 2)
        if got_scope != scope or int(expires) < time.time():
            return ""
        return username
    except Exception:
        return ""


def _require_user(username: str) -> str:
    """Identity is the logged-in username, per deployment decision — NO per-user
    token check (the app sits behind the bank's own access controls; the admin
    dashboard still requires its signed X-Akta-Admin-Token). Returns lowercased."""
    u = (username or "").strip().lower()
    if not u:
        raise HTTPException(status_code=401, detail="login required")
    return u


def require_admin(x_akta_admin_token: str = Header(default="")):
    """A valid signature is not enough: the username it names must still be listed
    in admin.txt, read fresh from disk on every call."""
    username = _open_session(x_akta_admin_token, "admin")
    if not username or not _is_admin_user(username, verbose=True):
        raise HTTPException(status_code=401, detail="admin login required")


# ---------------------------------------------------------------------------
# Login rate limiting — in-process, no extra dependency (air-gap constraint).
# Sliding window of failed attempts per (client IP, username).
# ---------------------------------------------------------------------------
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_S = 300
_login_failures: dict = {}  # key -> [fail_ts, ...]


def _login_blocked(key: str) -> bool:
    now = time.time()
    fails = [t for t in _login_failures.get(key, []) if now - t < LOGIN_WINDOW_S]
    _login_failures[key] = fails
    return len(fails) >= LOGIN_MAX_FAILURES


def _record_login_failure(key: str) -> None:
    if len(_login_failures) > 10000:  # bound memory under a spray attack
        _login_failures.clear()
    _login_failures.setdefault(key, []).append(time.time())


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""


class LoginResponse(BaseModel):
    success: bool
    username: str = ""
    name: str = ""
    role: str = ""
    token: str = ""           # admin session token — sent back as X-Akta-Admin-Token
    session_token: str = ""   # unused (kept for client compatibility): no user tokens by design


async def _authenticate(username: str, password: str) -> dict | None:
    """The ONLY credential check in the app — delegated to backend/auth_service.py, which
    is the file a deployment swaps for the bank's own (same contract as osg-prod). The
    password is passed through to the directory and is never stored, compared or defined
    anywhere in this codebase. Admin rights are a separate gate either way: data/admin.txt
    plus a signed token.

    DEV MODE (AKTA_DEV_LOGIN=1, honoured only when the service reports no directory):
    accept any username with any non-empty password, which is how this app has always
    behaved and is sound only behind the bank's own access controls."""
    if getattr(auth_service, "is_configured", lambda: True)():
        try:
            return await auth_service.ldap_login(username, password)
        except Exception as e:                                # noqa: BLE001
            print(f"  login error: {e}")                      # never the password
            return None
    if config.DEV_LOGIN:
        username = (username or "").strip()
        if not username or not password:
            return None
        return {"username": username, "display_name": username.title(), "roles": []}
    print("  login refused: no directory configured and AKTA_DEV_LOGIN is off", flush=True)
    return None


@app.post("/auth/login", response_model=LoginResponse)
async def auth_login(req: LoginRequest, request: Request):
    username = (req.username or "").strip()
    password = req.password or ""
    client_ip = request.client.host if request.client else "?"
    limit_key = f"{client_ip}|{username.lower()}"
    if _login_blocked(limit_key):
        raise HTTPException(status_code=429,
                            detail="too many failed logins — try again in a few minutes")
    if not username or not password:
        _record_login_failure(limit_key)
        return LoginResponse(success=False)
    info = await _authenticate(username, password)
    if not info:
        _record_login_failure(limit_key)
        return LoginResponse(success=False)
    username = info.get("username") or username
    name = info.get("display_name") or username
    is_admin = await run_in_threadpool(_is_admin_user, username)
    role = "admin" if is_admin else "employee"
    token = _sign_session(username, "admin") if is_admin else ""
    return LoginResponse(success=True, username=username, name=name, role=role,
                         token=token)


# ---------------------------------------------------------------------------
# Extraction jobs
# ---------------------------------------------------------------------------
async def _run_job(job: dict) -> None:
    """Wait for one of this user's run slots, then extract. The job sits at "queued" for
    the whole wait, which is what the UI already shows as "Waiting in the queue…".

    The PDF is re-read from disk here rather than carried in from the upload: a queued job
    would otherwise pin its bytes in memory for as long as it waits, and ten 30 MB akta
    per user is 300 MB of nothing happening."""
    user = job.get("username") or ""
    queued_at = time.time()
    slot = await _acquire_slot(user)
    slot_wait_s = round(time.time() - queued_at, 2)
    t0 = time.time()

    async def progress(stage: str, done: int, total: int) -> None:
        job.update(status=stage, stage_done=done, stage_total=total)
        if stage == "ocr":
            job["pages"] = total
        await run_in_threadpool(jobs.save, job)

    try:
        read_at = time.time()
        pdf_bytes = await run_in_threadpool(jobs.read_pdf, job["id"])
        if pdf_bytes is None:
            raise ocr_client.OcrError("the uploaded PDF is no longer on disk")
        read_s = round(time.time() - read_at, 2)
        record, n_pages, latency = await ocr_client.extract_akta(
            pdf_bytes, label=job["filename"], progress=progress)
        if isinstance(latency.get("client_phases"), dict):
            latency["client_phases"]["read_s"] = read_s
            # How long this job sat waiting for one of its user's run slots. Measured but
            # deliberately OUTSIDE duration_s: a queue is not the document being slow, and
            # folding it in would make every batch look like a performance problem.
            latency["client_phases"]["slot_wait_s"] = slot_wait_s
        company = record.get("nama_perusahaan", "")
        job.update(status="done", result=record, pages=n_pages,
                   company=company,
                   # The API's own timing breakdown, kept beside our wall-clock figure:
                   # when a document is slow, this says whether the time went on the API
                   # or on the queue in front of it. Operational only, no person data.
                   latency_data=latency,
                   duration_s=round(time.time() - t0, 2),
                   finished=jobs._now())
        error = ""
    except ocr_client.OcrError as e:
        job.update(status="error", error=str(e),
                   duration_s=round(time.time() - t0, 2), finished=jobs._now())
        company, error = "", str(e)
    except Exception as e:  # unexpected — still recorded, never a silent hang
        job.update(status="error", error=f"internal error: {e}",
                   duration_s=round(time.time() - t0, 2), finished=jobs._now())
        company, error = "", f"internal error: {e}"
    # log BEFORE the final save: once a client sees the job finished, its usage
    # event is guaranteed to be in the log (the dashboard poll relies on this)
    await run_in_threadpool(
        usage.log_event, job["username"], job["filename"],
        job_id=job["id"], pages=job.get("pages", 0), duration_s=job["duration_s"],
        status=job["status"], model=job["model"], company=company, error=error)
    await run_in_threadpool(jobs.save, job)
    await run_in_threadpool(jobs.prune)
    await _release_slot(user, slot)


@app.post("/extract")
async def extract(request: Request, username: str = ""):
    """NOTE the signature: this takes the raw Request, NOT `file: UploadFile =
    File(...)`. FastAPI resolves File() parameters by awaiting request.form()
    BEFORE the handler body runs, which receives and spools the whole upload to
    disk — so a permit taken inside the body would bound only the work after
    parsing. Parsing here, under the permit, is what actually bounds how many
    uploads are resident at once. Body size is capped independently, mid-stream,
    by BodySizeLimitMiddleware."""
    user = _require_user(username)
    if _admission.locked():
        raise HTTPException(status_code=429,
                            detail="The service is at capacity. Please retry shortly.")
    await _admission.acquire()
    form = None
    try:
        try:
            form = await request.form(max_files=1, max_fields=10)
        except Exception:
            raise HTTPException(status_code=400, detail="could not read the upload")
        file = form.get("file")
        if not isinstance(file, StarletteUploadFile):
            raise HTTPException(status_code=400, detail="no PDF file in the request")
        name = file.filename or "document.pdf"
        if not name.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="only PDF files are accepted")
        return await _accept_upload(file, name, user)
    finally:
        if form is not None:
            await form.close()  # release the spooled temp file promptly
        _admission.release()


# count_active() and create() are two steps, and a batch arriving together can run all of
# its checks before any of its creates — so every request sees room and the cap is passed.
# Serialising just those two steps costs nothing (they are microseconds) and makes the
# limit mean what it says.
_accept_lock = asyncio.Lock()


async def _accept_upload(file, name: str, user: str):
    active = await run_in_threadpool(jobs.count_active, user)
    if active >= config.MAX_ACTIVE_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=f"You already have {active} document(s) queued or processing — the "
                   f"limit is {config.MAX_ACTIVE_PER_USER}. Wait for some to finish, then "
                   "upload again.")
    pdf_bytes = await file.read(config.MAX_UPLOAD_BYTES + 1)
    if len(pdf_bytes) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"file exceeds {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    if not pdf_bytes.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="not a valid PDF file")
    model = "mock" if config.AKTA_OCR_MODE == "mock" else "internal-ocr-api"
    async with _accept_lock:
        # Re-checked under the lock: the count above was taken before the PDF was read,
        # and a concurrent batch may have filled the remaining room in the meantime.
        active = await run_in_threadpool(jobs.count_active, user)
        if active >= config.MAX_ACTIVE_PER_USER:
            raise HTTPException(
                status_code=429,
                detail=f"You already have {active} document(s) queued or processing — the "
                       f"limit is {config.MAX_ACTIVE_PER_USER}. Wait for some to finish, "
                       "then upload again.")
        job = await run_in_threadpool(jobs.create, user, name, model)
    await run_in_threadpool(jobs.save_pdf, job["id"], pdf_bytes)
    task = asyncio.get_running_loop().create_task(_run_job(job))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"job_id": job["id"], "status": job["status"]}


def _can_access(job: dict, user: str) -> bool:
    """Shared-history mode opens every job to any signed-in user; otherwise owner-only."""
    return config.SHARED_HISTORY or job.get("username") == user


@app.get("/jobs")
async def list_jobs(username: str = "", limit: int = 200, offset: int = 0):
    """Paginated so a long history is not re-sent in full on every 3s poll."""
    user = _require_user(username)
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)
    page, total = await run_in_threadpool(jobs.list_for_user, user, limit, offset)
    return {"jobs": page, "total": total, "limit": limit, "offset": offset}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, username: str = ""):
    user = _require_user(username)
    job = await run_in_threadpool(jobs.load, job_id)
    if not job or not _can_access(job, user):
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.put("/jobs/{job_id}/result")
async def update_job_result(job_id: str, payload: dict, username: str = ""):
    """Reviewer corrections: replace the extracted record with an edited one.
    Only the owner can edit, only completed jobs, and the payload is schema-fitted."""
    user = _require_user(username)
    record = payload.get("result")
    if not isinstance(record, dict):
        raise HTTPException(status_code=400, detail="body must carry a 'result' object")
    clean = ocr_client.sanitize_edited_record(record)
    # load+save under one per-job lock: two reviewers saving at once would
    # otherwise each write a full snapshot and the later one would win silently
    return await run_in_threadpool(_commit_edit, job_id, user, clean)


def _commit_edit(job_id: str, user: str, clean: dict) -> dict:
    with jobs.job_lock(job_id):
        job = jobs.load(job_id)
        if not job or not _can_access(job, user):
            raise HTTPException(status_code=404, detail="job not found")
        if job.get("status") != "done":
            raise HTTPException(status_code=409,
                                detail="only completed extractions can be edited")
    # the remark counts changes against the ORIGINAL extraction, kept from the
    # first edit onward — so re-editing (or reverting) stays honest
        if "original_result" not in job:
            job["original_result"] = job.get("result")
        changed = ocr_client.diff_fields(job.get("original_result") or {}, clean)
        job.update(result=clean, edited=bool(changed), edited_fields=len(changed),
                   edited_keys=changed, company=clean.get("nama_perusahaan", ""))
        jobs.save(job, _locked=True)
        return job


@app.get("/jobs/{job_id}/pdf")
async def get_job_pdf(job_id: str, username: str = ""):
    """The original upload, for the in-app PDF viewer. Same ownership check as the job."""
    user = _require_user(username)
    job = await run_in_threadpool(jobs.load, job_id)
    if not job or not _can_access(job, user):
        raise HTTPException(status_code=404, detail="job not found")
    path = jobs.pdf_path(job_id)
    if not await run_in_threadpool(os.path.exists, path):
        raise HTTPException(status_code=404, detail="PDF no longer stored")
    from fastapi.responses import FileResponse
    return FileResponse(path, media_type="application/pdf", filename=job["filename"])


# ---------------------------------------------------------------------------
# Admin dashboard
# ---------------------------------------------------------------------------
@app.get("/admin/analytics", dependencies=[Depends(require_admin)])
def admin_analytics():
    """Raw usage events; filtering/charting happens client-side (osg convention)."""
    return usage.get_analytics()


@app.post("/admin/usage/clear-failed", dependencies=[Depends(require_admin)])
async def admin_clear_failed():
    """Purge failed extractions from the usage log. The successes, and every job record
    on disk, are untouched — this only clears the failure noise from the dashboard."""
    removed = await run_in_threadpool(usage.clear_failed)
    print(f"  admin cleared {removed} failed usage event(s)", flush=True)
    return {"removed": removed}


@app.get("/admin/analytics/stamp", dependencies=[Depends(require_admin)])
def admin_analytics_stamp():
    return {"stamp": usage.log_stamp()}


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
@app.get("/app")
def app_info():
    return {"name": config.APP_NAME, "tagline": config.APP_TAGLINE,
            "model": config.AKTA_OCR_MODE, "helpdesk": config.HELPDESK_EMAIL,
            "max_active": config.MAX_ACTIVE_PER_USER,
            "concurrent_per_user": config.CONCURRENT_PER_USER}


@app.on_event("startup")
async def _startup() -> None:
    """Resolve jobs abandoned by a previous process: without this they poll as
    'queued'/'ocr' forever and never reach a terminal state."""
    # Run slots are asyncio primitives, so they belong to the loop that created them.
    # One loop per process in production makes this a no-op; under tests, where each
    # client spins a fresh loop, it stops a semaphore from a dead loop being awaited.
    _user_slots.clear()
    n = await run_in_threadpool(jobs.fail_interrupted, "interrupted by a server restart")
    if n:
        print(f"  marked {n} interrupted job(s) as failed", flush=True)


@app.on_event("shutdown")
async def _shutdown() -> None:
    """Drain in-flight extractions first — closing the HTTP client under a live
    POST strands the job in a non-terminal state."""
    if _background_tasks:
        done, pending = await asyncio.wait(set(_background_tasks),
                                           timeout=config.SHUTDOWN_GRACE_S)
        for task in pending:
            task.cancel()
        if pending:
            # let them finish unwinding BEFORE the shared client is closed, or a
            # straggler races aclose() and prints "Task was destroyed but it is
            # pending". Jobs still non-terminal are reconciled at next startup.
            await asyncio.gather(*pending, return_exceptions=True)
    await ocr_client.close_client()


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    print(f"OCR Akta backend on {config.HOST}:{config.PORT}  mode={config.AKTA_OCR_MODE}  "
          f"ocr_api={config.OCR_API_URL or '(unset — mock mode only)'}", flush=True)
    print("OCR Akta is ready!", flush=True)
    uvicorn.run(app, host=config.HOST, port=config.PORT)
