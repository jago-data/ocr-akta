"""Usage logging + analytics for the admin dashboard.

Append-only JSONL, same pattern as osg-prod's usage.py:
- log_event never raises — logging must not break an extraction.
- the read path deliberately takes NO lock: the lock belongs to the append path;
  holding it during a full-file read would block live logging for its duration.
- log_stamp() is a two-stat fingerprint so the dashboard can poll cheaply.

PII note: akta records hold NIK/birthdate/addresses. Events log only operational
metadata (filename, page count, duration, status, company name) — never person data.
"""
import json
import os
import threading
from collections import deque
from datetime import datetime, timezone

import config

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "usage_log.jsonl")
_lock = threading.Lock()
MAX_EVENTS = config.MAX_DASHBOARD_EVENTS


def log_event(username: str, filename: str, *, job_id: str = "", pages: int = 0,
              duration_s: float = 0.0, status: str = "ok", model: str = "",
              company: str = "", error: str = "") -> None:
    """Append one usage record. Never raises."""
    try:
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "username": (username or "anonymous"),
            "job_id": job_id or "",
            "filename": (filename or "").strip()[:300],
            "pages": int(pages or 0),
            "duration_s": round(float(duration_s or 0.0), 2),
            "status": status or "ok",
            "model": model or "",
            "company": (company or "").strip()[:200],
            "error": (error or "").strip()[:500],
        }
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with _lock:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"  usage log skipped: {e}", flush=True)


# What the dashboard calls a success. Kept here beside the writer so the definition
# cannot drift from the one the UI uses to colour a row.
OK_STATUSES = ("done", "ok")


def clear_failed() -> int:
    """Drop every failed event from the log, keeping the successes. Returns how many
    lines were removed.

    IRREVERSIBLE: this log is the only record those extractions ever ran, so the caller
    is expected to have confirmed with a human first. Written to a temp file and moved
    into place under the append lock, so a crash mid-rewrite leaves the original intact
    and no concurrent log_event is lost."""
    if not os.path.exists(LOG_PATH):
        return 0
    with _lock:
        kept, removed = [], 0
        try:
            with open(LOG_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        kept.append(line)          # unparseable: not ours to throw away
                        continue
                    if rec.get("status") in OK_STATUSES:
                        kept.append(line)
                    else:
                        removed += 1
        except OSError:
            return 0
        if not removed:
            return 0
        tmp = LOG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.writelines(line if line.endswith("\n") else line + "\n" for line in kept)
        os.replace(tmp, LOG_PATH)
    return removed


def _read() -> list:
    """Most-recent MAX_EVENTS events; malformed lines are skipped, not fatal."""
    if not os.path.exists(LOG_PATH):
        return []
    out = deque(maxlen=MAX_EVENTS)
    try:
        with open(LOG_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except OSError:
        return []
    return list(out)


_analytics_cache: tuple = ("", None)  # (log_stamp, payload)
_analytics_lock = threading.Lock()


def get_analytics() -> dict:
    """Raw event list, oldest first. Aggregation happens client-side (osg
    convention). Cached against the log fingerprint so concurrent admin polls
    re-parse the file only when it actually changed."""
    global _analytics_cache
    stamp = log_stamp()
    cached_stamp, payload = _analytics_cache
    if payload is not None and cached_stamp == stamp:
        return payload
    with _analytics_lock:  # single-flight: concurrent polls share one parse
        cached_stamp, payload = _analytics_cache
        if payload is not None and cached_stamp == stamp:
            return payload
        events = sorted(_read(), key=lambda r: r.get("ts", ""))
        payload = {"events": events, "total": len(events)}
        _analytics_cache = (stamp, payload)
        return payload


def log_stamp() -> str:
    """Change fingerprint of the log — one stat() call, for the dashboard poll."""
    try:
        st = os.stat(LOG_PATH)
        return f"{int(st.st_mtime_ns)}-{st.st_size}"
    except OSError:
        return "0-0"
