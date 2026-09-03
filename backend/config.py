"""Configuration — loads the SINGLE config file at the repo root.

One .env drives backend, frontend proxy targets and deploy scripts (same convention
as osg-prod). load_dotenv never overrides values already in the environment, so
deploy scripts that `set -a; source .env` still win.
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
except Exception:
    pass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


# --- OCR mode: "live" calls the internal OCR API; "mock" returns realistic dummy
# records (no network) so the app can be exercised without the API ---
AKTA_OCR_MODE = os.environ.get("AKTA_OCR_MODE", "live").strip().lower()

# --- Internal OCR API (the ONLY outbound call the app makes) ---
# The PDF goes up as base64 inside a JSON body; see ocr_client for the full contract.
OCR_API_URL = os.environ.get("AKTA_OCR_API_URL", "").strip()
OCR_API_KEY = os.environ.get("AKTA_OCR_API_KEY", "").strip()
# The header the token travels in. Production reads X-Api-Token; a gateway in front of it
# may want Authorization or x-api-key instead, and that should not need a code change.
OCR_API_KEY_HEADER = os.environ.get("AKTA_OCR_API_KEY_HEADER", "X-Api-Token").strip() \
    or "X-Api-Token"
# Request envelope fields the API expects on every call. channelId and cif identify the
# calling system to it; both are site values, and both may legitimately be empty.
OCR_CHANNEL_ID = os.environ.get("AKTA_OCR_CHANNEL_ID", "").strip()
OCR_CIF = os.environ.get("AKTA_OCR_CIF", "").strip()
# Prefix on the referenceNo this app mints per call, so a request can be traced from this
# app's logs into the API's.
OCR_REFERENCE_PREFIX = os.environ.get("AKTA_OCR_REFERENCE_PREFIX", "AKTA-")
OCR_API_TIMEOUT = _int("AKTA_OCR_TIMEOUT_S", 600)
# Concurrent calls to the OCR API across ALL users (pool size + backpressure):
OCR_API_CONCURRENCY = _int("AKTA_OCR_CONCURRENCY", 8)
OCR_API_RETRIES = _int("AKTA_OCR_RETRIES", 3)

# --- Server ---
HOST = os.environ.get("AKTA_HOST", "0.0.0.0")
PORT = _int("PORT", 0) or _int("BE_PORT", 8300)

# 1 = one shared worklist: every signed-in user sees and can open every job.
# 0 = each user sees only their own uploads (stricter for PII in production).
SHARED_HISTORY = os.environ.get("AKTA_SHARED_HISTORY", "").strip() == "1"

# --- Uploads / jobs ---
# A user may have at most this many documents processing at once; a batch that
# would exceed it is refused whole with a warning (client pre-checks too).
MAX_ACTIVE_PER_USER = _int("AKTA_MAX_ACTIVE_PER_USER", 5)
# Process-wide admission cap: every accepted job holds its PDF in memory until the
# OCR API answers, so this — not the per-user cap — is the real memory bound.
MAX_CONCURRENT_UPLOADS = _int("AKTA_MAX_CONCURRENT_UPLOADS", 40)
MAX_UPLOAD_BYTES = _int("AKTA_MAX_UPLOAD_MB", 30) * 1024 * 1024
# How long shutdown waits for in-flight extractions before cancelling them.
SHUTDOWN_GRACE_S = _int("AKTA_SHUTDOWN_GRACE_S", 30)
JOBS_KEEP = _int("AKTA_JOBS_KEEP", 2000)       # oldest job files pruned past this count

# --- Auth ---
# Accept any non-empty username/password when backend/auth_service.py reports no directory
# to check against. This is the app's original behaviour and is sound ONLY behind the
# bank's own access controls; with it off and no LDAP configured, every login is refused.
DEV_LOGIN = os.environ.get("AKTA_DEV_LOGIN", "1").strip() == "1"
SESSION_SECRET = os.environ.get("AKTA_SESSION_SECRET", "").strip()
SESSION_TTL_S = _int("AKTA_SESSION_TTL_HOURS", 12) * 3600

# --- Branding (served by GET /app so a rebrand needs no rebuild) ---
APP_NAME = os.environ.get("AKTA_APP_NAME", "OCR Akta")
APP_TAGLINE = os.environ.get("AKTA_APP_TAGLINE", "Ekstraksi Akta Pendirian PT")
# Empty hides the login helpdesk box — an address nobody maintains is worse than none.
HELPDESK_EMAIL = os.environ.get("AKTA_HELPDESK_EMAIL", "").strip()

# --- Usage analytics ---
MAX_DASHBOARD_EVENTS = _int("AKTA_MAX_DASHBOARD_EVENTS", 200000)
