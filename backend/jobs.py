"""Extraction job store — JSON file per job under data/jobs/ (no database).

A job is created at upload, updated as the pipeline progresses, and read back by
the frontend poll and the admin dashboard. Writes are atomic (tmp + os.replace)
so a poll never reads a half-written file.
"""
import json
import os
import secrets
import threading
from datetime import datetime, timezone

import config

JOBS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "jobs")
UPLOADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "uploads")
# Lock striping: writes to DIFFERENT jobs need not serialize — only writes to the
# same job do. One global lock made every progress update of every in-flight
# extraction contend on the same mutex.
_STRIPES = 64
_stripes = [threading.RLock() for _ in range(_STRIPES)]


def job_lock(job_id: str) -> threading.RLock:
    """The lock guarding one job. Reentrant so a caller can hold it across a
    load+save (the reviewer-edit path) without deadlocking on save()."""
    return _stripes[hash(job_id) % _STRIPES]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path(job_id: str) -> str:
    # job ids are token_urlsafe — reject anything path-like defensively
    safe = "".join(c for c in job_id if c.isalnum() or c in "-_")
    return os.path.join(JOBS_DIR, f"{safe}.json")


def create(username: str, filename: str, model: str) -> dict:
    job = {
        "id": secrets.token_urlsafe(12),
        "username": (username or "").strip().lower(),
        "filename": (filename or "document.pdf")[:300],
        "model": model,
        "status": "queued",          # queued | ocr | extract | done | error
        "stage_done": 0,
        "stage_total": 0,
        "pages": 0,
        "created": _now(),
        "finished": "",
        "duration_s": 0.0,
        "error": "",
        "result": None,              # the 15-field record once status == done
    }
    save(job)
    return job


def save(job: dict, _locked: bool = False) -> None:
    os.makedirs(JOBS_DIR, exist_ok=True)
    path = _path(job["id"])
    # unique tmp name: two writers of the same job must never share a temp file
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    lock = job_lock(job["id"])
    if _locked:  # caller already holds it (reentrant, but avoid the re-acquire)
        _write(job, tmp, path)
        return
    with lock:
        _write(job, tmp, path)


def _write(job: dict, tmp: str, path: str) -> None:
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)  # results hold NIK/birthdates — owner-only
        except OSError:
            pass
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def count_active(username: str) -> int:
    """How many of this user's jobs are still queued or running."""
    u = (username or "").strip().lower()
    return sum(1 for j in _iter_summaries()
               if j.get("username") == u
               and j.get("status") in ("queued", "ocr", "extract"))


def save_pdf(job_id: str, pdf_bytes: bytes) -> None:
    """Keep the original upload so the UI can show it next to the extraction."""
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    path = pdf_path(job_id)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(pdf_bytes)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def read_pdf(job_id: str) -> bytes | None:
    """The stored upload, or None if it is gone (pruned, or swept after a failure). Read
    at extraction time rather than held from upload, so a job waiting for a run slot costs
    a file on disk instead of its bytes in memory."""
    try:
        with open(pdf_path(job_id), "rb") as f:
            return f.read()
    except OSError:
        return None


def pdf_path(job_id: str) -> str:
    safe = "".join(c for c in job_id if c.isalnum() or c in "-_")
    return os.path.join(UPLOADS_DIR, f"{safe}.pdf")


def load(job_id: str) -> dict | None:
    try:
        with open(_path(job_id), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def list_for_user(username: str, limit: int = 200, offset: int = 0) -> tuple:
    """Newest-first job summaries for one user (result bodies stripped — they can
    be large and hold PII; the client fetches a single job for the full record)."""
    u = (username or "").strip().lower()
    out = [j for j in _iter_summaries()
           if (config.SHARED_HISTORY or j.get("username") == u)
           and j.get("status") != "error"]  # failures never enter history
    out.sort(key=lambda j: j.get("created", ""), reverse=True)
    return out[offset:offset + limit], len(out)


# Summary cache: job listings are polled every few seconds by every open tab, and
# re-parsing every file each time made list cost O(jobs) disk reads per request.
# scandir gives name+mtime in one pass; a file is only re-read when its mtime or
# size changes, so steady-state listing is CPU-only. Values are SUMMARIES (no
# result body) — bounded by JOBS_KEEP and free of PII.
_SUMMARY_KEYS = ("id", "username", "filename", "company", "status", "stage_done",
                 "stage_total", "pages", "created", "finished", "duration_s",
                 "error", "edited", "edited_fields")
_cache: dict = {}          # job_id -> (mtime_ns, size, summary)
_cache_lock = threading.Lock()


def _summary(job: dict) -> dict:
    return {k: job.get(k) for k in _SUMMARY_KEYS}


def _iter_summaries():
    """Every job's summary, re-reading only the files that changed.

    The whole scan runs under one lock (single-flight): without it, N simultaneous
    pollers each re-scan the directory and re-parse the same files, which is
    exactly the load this cache exists to remove. Contending callers wait once and
    then hit the warm cache."""
    with _cache_lock:
        return _scan_locked()


def _scan_locked():
    try:
        entries = [e for e in os.scandir(JOBS_DIR) if e.name.endswith(".json")]
    except OSError:
        return []
    fresh = {}
    for e in entries:
        job_id = e.name[:-len(".json")]
        try:
            st = e.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            continue
        cached = _cache.get(job_id)
        if cached and cached[0] == stamp[0] and cached[1] == stamp[1]:
            fresh[job_id] = cached
            continue
        try:
            with open(e.path, encoding="utf-8") as f:
                job = json.load(f)
        except (OSError, ValueError):
            continue  # half-written or corrupt: skip this round, retry next poll
        fresh[job_id] = (stamp[0], stamp[1], _summary(job))
    _cache.clear()
    _cache.update(fresh)
    return [v[2] for v in fresh.values()]


def fail_interrupted(reason: str) -> int:
    """Flip jobs left mid-flight by a dead process to a terminal error state.
    Called once at startup — otherwise the UI polls them as 'queued' forever."""
    stuck = [j["id"] for j in _iter_summaries()
             if j.get("status") in ("queued", "ocr", "extract")]
    for job_id in stuck:
        with job_lock(job_id):
            job = load(job_id)
            if not job or job.get("status") not in ("queued", "ocr", "extract"):
                continue
            job.update(status="error", error=reason, finished=_now())
            save(job, _locked=True)
    return len(stuck)


_ERROR_KEEP_S = 3600  # failed jobs stay addressable briefly (the open view polls them)


def prune() -> None:
    """Drop the oldest job files past JOBS_KEEP, and failed jobs after an hour.
    Called after each job completes."""
    import time
    now = time.time()
    for job in _iter_summaries():
        if job.get("status") != "error":
            continue
        path = _path(job.get("id", ""))
        try:
            if now - os.path.getmtime(path) > _ERROR_KEEP_S:
                os.remove(path)
                try:
                    os.remove(pdf_path(job.get("id", "")))
                except OSError:
                    pass
        except OSError:
            continue
    try:
        names = [n for n in os.listdir(JOBS_DIR) if n.endswith(".json")]
        if len(names) <= config.JOBS_KEEP:
            return
        full = sorted((os.path.getmtime(os.path.join(JOBS_DIR, n)), n) for n in names)
        for _, name in full[: len(names) - config.JOBS_KEEP]:
            os.remove(os.path.join(JOBS_DIR, name))
            try:  # the stored upload goes with its job record
                os.remove(pdf_path(name[:-len(".json")]))
            except OSError:
                pass
    except OSError:
        pass
