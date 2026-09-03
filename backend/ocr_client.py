"""Akta extraction — a thin client for the bank's INTERNAL OCR API.

The heavy lifting (OCR, extraction, post-processing) happens inside that API; this
backend hands it the PDF and stores the record that comes back. AKTA_OCR_MODE=mock
keeps the app fully usable with realistic dummy data when the API is not reachable
(local dev, demos).

The wire contract, exactly as production speaks it:

    POST <AKTA_OCR_API_URL>
    accept: application/json
    X-Api-Token: <AKTA_OCR_API_KEY>          (header name is configurable)
    Content-Type: application/json
    {"channelId": "", "cif": "", "pdf": "data:application/pdf;base64,…",
     "referenceNo": "…", "transactionDate": "2024-03-14 12:18:40.703"}

    → {"success": true, "result": {…}, "latency_data": {…}, "message": "…"}

The PDF travels as a base64 data URI inside JSON, not as multipart — which costs a
third more bytes on the wire than the file itself, so the upload cap and the API
timeout are both sized with that in mind.
"""
from __future__ import annotations

import asyncio
import base64
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

import fitz  # PyMuPDF — page counting and upload sanity only, no rendering
import httpx

import config

# The record contract — the 16 keys production returns under "result", and the 9 keys
# each board member carries. Anything outside these lists is dropped by sanitize_record,
# so an API that grows a field cannot quietly reshape stored jobs.
RECORD_KEYS = [
    "nama_perusahaan", "nama_perusahaan_cleaned", "nomor_akta", "tanggal_akta",
    "tanggal_perusahaan_berdiri", "tempat_perusahaan_berdiri", "jangka_waktu_perseroan",
    "bidang_industri_perusahaan",
    "masa_berlaku_direksi_dalam_tahun", "masa_berlaku_komisaris_dalam_tahun",
    "tanggal_berlaku_direksi", "tanggal_berlaku_komisaris",
    "board_of_directors", "board_of_commissioners",
    "pengurus_dan_pemegang_saham_tertinggi",
    "original_filename",
]
PERSON_KEYS = [
    "nama", "jabatan", "no_ktp_passport", "tempat_lahir",
    "tanggal_lahir", "warga_negara", "alamat", "jumlah_lembar_saham", "persentase_saham",
]
ARRAY_STR = {"bidang_industri_perusahaan"}
BOARD = {"board_of_directors", "board_of_commissioners"}


class OcrError(RuntimeError):
    """Raised when the record cannot be produced (broken PDF, API failure, ...)."""


# One pooled client for the whole process. Building an AsyncClient per request
# forces a fresh TCP (+TLS) handshake every upload, which is the dominant cost
# under load; httpx's own docs call the per-request pattern out as the thing to
# avoid for anything but one-off scripts.
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()
# Bounds concurrent calls to the internal OCR API so a burst of users queues
# here instead of overwhelming that service (backpressure, not a rate limit).
_sem: asyncio.Semaphore | None = None


async def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        async with _client_lock:
            if _client is None:  # re-check: another task may have built it
                _client = httpx.AsyncClient(
                    timeout=httpx.Timeout(config.OCR_API_TIMEOUT, connect=10.0),
                    limits=httpx.Limits(
                        max_connections=config.OCR_API_CONCURRENCY,
                        max_keepalive_connections=config.OCR_API_CONCURRENCY,
                        keepalive_expiry=30.0),
                )
    return _client


async def close_client() -> None:
    """Called on app shutdown so sockets are released deterministically."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def reset_for_tests() -> None:
    """Drop the loop-bound singletons. The client/semaphore bind to the first
    event loop that touches them, so a test using a second asyncio.run() must
    reset them first."""
    global _client, _sem
    _client = None
    _sem = None


def _get_sem() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(config.OCR_API_CONCURRENCY)
    return _sem


def sanitize_record(payload: dict) -> dict:
    """Schema-fit any record — the API's response or a reviewer's edit: known keys
    only, strings trimmed, boards as person dicts, every key present."""
    def s(v):
        return str(v).strip() if v is not None else ""

    clean: dict = {}
    for k in RECORD_KEYS:
        if k in ARRAY_STR:
            clean[k] = [s(x) for x in (payload.get(k) or []) if s(x)]
        elif k in BOARD:
            people = []
            for p in (payload.get(k) or []):
                if isinstance(p, dict):
                    people.append({pk: s(p.get(pk)) for pk in PERSON_KEYS})
            clean[k] = people
        else:
            clean[k] = s(payload.get(k))
    return clean


# the edit endpoint uses the same schema fit
sanitize_edited_record = sanitize_record


def diff_fields(old: dict, new: dict) -> list:
    """The field paths that differ between two records — drives both the
    'edited N fields' remark and the per-field highlight in the UI."""
    def s(v):
        return str(v or "").strip()

    changed = []
    for k in RECORD_KEYS:
        if k in ARRAY_STR:
            if [s(x) for x in (old.get(k) or [])] != [s(x) for x in (new.get(k) or [])]:
                changed.append(k)
        elif k in BOARD:
            a, b = (old.get(k) or []), (new.get(k) or [])
            for i in range(max(len(a), len(b))):
                pa = a[i] if i < len(a) else None
                pb = b[i] if i < len(b) else None
                if pa is None or pb is None:
                    changed.append(f"{k}[{i}]")  # member added or removed
                elif isinstance(pa, dict) and isinstance(pb, dict):
                    changed.extend(f"{k}[{i}].{pk}" for pk in PERSON_KEYS
                                   if s(pa.get(pk)) != s(pb.get(pk)))
        else:
            if s(old.get(k)) != s(new.get(k)):
                changed.append(k)
    return changed


def _page_count(pdf_bytes: bytes) -> int:
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            return doc.page_count
        finally:
            doc.close()
    except Exception as e:
        raise OcrError(f"cannot open PDF: {e}") from e


ProgressCb = Callable[[str, int, int], Awaitable[None]]  # (stage, done, total)


# ---------------------------------------------------------------------------
# Live mode: the internal OCR API
# ---------------------------------------------------------------------------
# Jakarta time: transactionDate is read by the API's operators alongside the rest of the
# bank's logs, which are all WIB. A UTC stamp would be seven hours out in every report.
WIB = timezone(timedelta(hours=7))


def _transaction_date() -> str:
    """"2024-03-14 12:18:40.703" — the format the API's own example uses, to the
    millisecond (Python gives microseconds, so the last three digits come off)."""
    return datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _reference_no(label: str) -> str:
    """A per-call id the API echoes into its logs, so one upload here can be found on
    that side. Prefix is configurable; the tail is random rather than sequential, since
    two hosts behind a load balancer must not mint the same reference."""
    return f"{config.OCR_REFERENCE_PREFIX}{uuid.uuid4().hex[:16]}"


def build_request(pdf_bytes: bytes, label: str) -> dict:
    """The JSON body production expects. Split out from the call so a test can assert
    the shape without a network, and so the encoding cost is visible in one place."""
    return {
        "channelId": config.OCR_CHANNEL_ID,
        "cif": config.OCR_CIF,
        "pdf": "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode("ascii"),
        "referenceNo": _reference_no(label),
        "transactionDate": _transaction_date(),
    }


def _unwrap(data: dict) -> tuple[dict, dict]:
    """(record, latency) out of the response envelope.

    `success: false` is a failure even at HTTP 200 — the API answers that way for a PDF
    it could not read, and treating it as a result would store an empty record as if the
    extraction had worked. The API's own message is passed through, capped: it explains
    what went wrong, and an operator has no other way to see it."""
    if data.get("success") is False:
        message = str(data.get("message") or "").strip()
        raise OcrError(f"OCR API refused the document: {message[:300]}" if message
                       else "OCR API reported success=false with no message")
    result = data.get("result")
    if not isinstance(result, dict):
        # Tolerated on purpose: an older deployment of the API returns the bare record.
        result = data if data.get("nama_perusahaan") is not None else None
    if not isinstance(result, dict):
        raise OcrError("OCR API response carried no result object")
    latency = data.get("latency_data")
    return result, latency if isinstance(latency, dict) else {}


async def _api_extract(pdf_bytes: bytes, label: str,
                       progress: ProgressCb | None) -> tuple[dict, int, dict]:
    if not config.OCR_API_URL:
        raise OcrError("AKTA_OCR_API_URL is not set — configure the internal "
                       "OCR API in .env (or use AKTA_OCR_MODE=mock)")
    # Every phase is measured. Wall clock minus the API's own total_time used to be one
    # unattributable number, and in production it reached two minutes — which of these
    # four it was is not something anyone should have to guess at.
    phases = {"page_count_s": 0.0, "encode_s": 0.0, "api_wait_s": 0.0,
              "http_s": 0.0, "retry_wait_s": 0.0}

    mark = time.perf_counter()
    n_pages = await asyncio.to_thread(_page_count, pdf_bytes)
    phases["page_count_s"] = round(time.perf_counter() - mark, 2)
    if progress:
        await progress("extract", 0, 1)

    headers = {"accept": "application/json", "Content-Type": "application/json"}
    if config.OCR_API_KEY:
        headers[config.OCR_API_KEY_HEADER] = config.OCR_API_KEY
    client, sem = await get_client(), _get_sem()
    # Encoding is CPU-bound and a 30 MB PDF is not free — off the event loop, or every
    # other request in this process stalls for the duration.
    mark = time.perf_counter()
    body = await asyncio.to_thread(build_request, pdf_bytes, label)
    phases["encode_s"] = round(time.perf_counter() - mark, 2)
    phases["body_mb"] = round(len(body["pdf"]) / (1024 * 1024), 2)

    resp = None
    last: Exception | None = None
    for attempt in range(config.OCR_API_RETRIES):
        try:
            # The permit covers the call ONLY — holding it across the backoff sleep would
            # let one bad spell drain every slot and stall everyone. Acquire is timed on
            # its own: a queue behind AKTA_OCR_CONCURRENCY looks exactly like a slow API
            # from the outside, and the two want opposite fixes.
            mark = time.perf_counter()
            await sem.acquire()
            phases["api_wait_s"] += round(time.perf_counter() - mark, 2)
            try:
                mark = time.perf_counter()
                resp = await client.post(config.OCR_API_URL, headers=headers, json=body)
                phases["http_s"] += round(time.perf_counter() - mark, 2)
            finally:
                sem.release()
            if resp.status_code < 500:
                break  # 2xx/4xx are final answers; only 5xx is worth retrying
            last = OcrError(f"OCR API returned HTTP {resp.status_code}")
        except httpx.HTTPError as e:
            last = e
        if attempt < config.OCR_API_RETRIES - 1:
            mark = time.perf_counter()
            await asyncio.sleep(2 * (attempt + 1))
            phases["retry_wait_s"] += round(time.perf_counter() - mark, 2)
    if resp is None:
        raise OcrError(f"OCR API unreachable: {last}")
    if resp.status_code != 200:
        # never echo the upstream body verbatim — it can carry akta PII
        raise OcrError(f"OCR API returned HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as e:
        raise OcrError("OCR API returned a non-JSON response") from e
    if not isinstance(data, dict):
        raise OcrError("OCR API response is not a JSON object")
    record, latency = _unwrap(data)
    # Carried inside latency_data so the return shape stays a 3-tuple. `http_s` minus the
    # API's own total_time is the part neither side measures: sending the base64 body up
    # and the API's queue before it starts its clock.
    latency["client_phases"] = phases

    if progress:
        await progress("extract", 1, 1)
    return sanitize_record(record), n_pages, latency


# ---------------------------------------------------------------------------
# Mock mode — schema-correct dummy data, no network. All people are fictional;
# the NIKs are synthetic but consistent with the birthdates shown.
# ---------------------------------------------------------------------------
def _mock_record(label: str) -> dict:
    stem = re.sub(r"\.pdf$", "", label or "contoh", flags=re.I)
    company = "PT " + (re.sub(r"[_\-]+", " ", stem).strip().upper() or "CONTOH SEJAHTERA")
    return sanitize_record({
        "nama_perusahaan": company,
        "nama_perusahaan_cleaned": company.removeprefix("PT "),
        "nomor_akta": "15",
        "tanggal_akta": "2023-03-30",
        "tanggal_perusahaan_berdiri": "2023-03-30",
        "tempat_perusahaan_berdiri": "KOTA BEKASI",
        "jangka_waktu_perseroan": "TIDAK TERBATAS",
        "bidang_industri_perusahaan": [
            "70209-AKTIVITAS KONSULTASI MANAJEMEN LAINNYA",
            "46100-PERDAGANGAN BESAR ATAS DASAR BALAS JASA",
        ],
        "masa_berlaku_direksi_dalam_tahun": "5",
        "masa_berlaku_komisaris_dalam_tahun": "5",
        "board_of_directors": [{
            "nama": "TUAN BUDI SANTOSO",
            "jabatan": "DIREKTUR UTAMA", "no_ktp_passport": "3173022106850003",
            "tempat_lahir": "SURABAYA", "tanggal_lahir": "1985-06-21",
            "warga_negara": "INDONESIA",
            "alamat": "JALAN KENANGA NOMOR 21, RT 004, RW 006, JAKARTA BARAT",
            "jumlah_lembar_saham": "400", "persentase_saham": "40%",
        }, {
            "nama": "NONA SARDA HANIRA",
            "jabatan": "DIREKTUR", "no_ktp_passport": "3275014502950002",
            "tempat_lahir": "JAKARTA", "tanggal_lahir": "1995-02-05",
            "warga_negara": "INDONESIA",
            "alamat": "KAMPUNG BAHARI V NOMOR 12, RT 003, RW 005, KOTA BEKASI",
            "jumlah_lembar_saham": "250", "persentase_saham": "25%",
        }],
        "board_of_commissioners": [{
            "nama": "NYONYA RATNA DEWI",
            "jabatan": "KOMISARIS UTAMA", "no_ktp_passport": "3174045203800004",
            "tempat_lahir": "BANDUNG", "tanggal_lahir": "1980-03-12",
            "warga_negara": "INDONESIA",
            "alamat": "JALAN ANGGREK NOMOR 3, RT 002, RW 001, JAKARTA SELATAN",
            "jumlah_lembar_saham": "200", "persentase_saham": "20%",
        }, {
            "nama": "TUAN NASRI",
            "jabatan": "KOMISARIS", "no_ktp_passport": "3275011511900001",
            "tempat_lahir": "PADANG", "tanggal_lahir": "1990-11-15",
            "warga_negara": "INDONESIA",
            "alamat": "JALAN MELATI NOMOR 8, RT 001, RW 002, KOTA BEKASI",
            "jumlah_lembar_saham": "150", "persentase_saham": "15%",
        }],
        "pengurus_dan_pemegang_saham_tertinggi": "BUDI SANTOSO",
        "original_filename": label or "contoh.pdf",
    })


async def _mock_extract(pdf_bytes: bytes, label: str,
                        progress: ProgressCb | None) -> tuple[dict, int, dict]:
    """Walks the real progress stages with short delays so the UI flow is exercised."""
    async def report(stage: str, done: int, total: int) -> None:
        if progress:
            await progress(stage, done, total)

    n_pages = await asyncio.to_thread(_page_count, pdf_bytes)
    for i in range(n_pages + 1):
        await report("ocr", i, n_pages)
        await asyncio.sleep(0.4)
    await report("extract", 0, 1)
    await asyncio.sleep(1.0)
    await report("extract", 1, 1)
    # Shaped like the real latency_data, and with the stages actually populated: zeros
    # would make the UI's timing breakdown render empty, so mock mode would not exercise
    # the thing it exists to exercise. Split roughly the way real runs do — rendering is
    # per-page and cheap, the prompts dominate.
    ocr_s = round(0.4 * (n_pages + 1), 2)
    latency = {
        "file_name": label,
        "pdf_to_images_time": round(ocr_s * 0.25, 2),
        "images_to_md_time": round(ocr_s * 0.75, 2),
        "parallel_prompt_time": 1.0,
        "total_time": round(ocr_s + 1.0, 2),
    }
    return _mock_record(label), n_pages, latency


async def extract_akta(pdf_bytes: bytes, label: str = "doc",
                       progress: ProgressCb | None = None) -> tuple[dict, int, dict]:
    """One PDF in, (record, page_count, latency_data) out. The third value is the API's
    own timing breakdown — operational metadata, no person data — and is {} when the API
    does not send one. Raises OcrError on any failure."""
    if config.AKTA_OCR_MODE == "mock":
        return await _mock_extract(pdf_bytes, label, progress)
    return await _api_extract(pdf_bytes, label, progress)
