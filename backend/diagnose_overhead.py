"""Where does the time outside the OCR API go? Answers it from jobs already on disk.

The result panel breaks this down per document, but only for jobs run since that landed.
This reads every job record you already have and tests the one hypothesis that can be
checked retrospectively: that the overhead is TIME SPENT QUEUING behind
AKTA_OCR_CONCURRENCY, not upload or network.

The test is simple. For each finished job, count how many other extractions were in
flight while it ran. If overhead rises with that overlap, the queue is the cause and the
fix is a config change. If overhead is flat regardless of overlap, it is the body upload
or the API's own front door, and no setting here will help.

    python backend/diagnose_overhead.py
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
import jobs as jobs_mod  # noqa: E402


def _parse(stamp: str):
    try:
        return datetime.fromisoformat((stamp or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def load_finished() -> list:
    """Every completed job that recorded both an elapsed time and an API total."""
    out = []
    try:
        names = os.listdir(jobs_mod.JOBS_DIR)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(jobs_mod.JOBS_DIR, name), encoding="utf-8") as f:
                job = json.load(f)
        except (OSError, ValueError):
            continue
        if job.get("status") != "done":
            continue
        finished, duration = _parse(job.get("finished")), job.get("duration_s")
        api_total = (job.get("latency_data") or {}).get("total_time")
        if not finished or not duration or not api_total:
            continue
        out.append({
            "file": job.get("filename", "?"),
            "pages": job.get("pages") or 0,
            "duration": float(duration),
            "api": float(api_total),
            "overhead": max(0.0, float(duration) - float(api_total)),
            "end": finished.timestamp(),
            "start": finished.timestamp() - float(duration),
            "phases": (job.get("latency_data") or {}).get("client_phases"),
        })
    return sorted(out, key=lambda j: j["start"])


def overlap_of(job: dict, all_jobs: list) -> int:
    """How many other extractions were running at the same time as this one."""
    return sum(1 for other in all_jobs
               if other is not job
               and other["start"] < job["end"] and other["end"] > job["start"])


def main() -> None:
    finished = load_finished()
    if not finished:
        print("No finished jobs with timing data yet — nothing to analyse.")
        return

    for job in finished:
        job["overlap"] = overlap_of(job, finished)

    print(f"{len(finished)} finished job(s) in {jobs_mod.JOBS_DIR}")
    print(f"AKTA_OCR_CONCURRENCY={config.OCR_API_CONCURRENCY}   "
          f"AKTA_CONCURRENT_PER_USER={config.CONCURRENT_PER_USER}\n")

    worst = sorted(finished, key=lambda j: j["overhead"], reverse=True)[:10]
    print("Slowest by time outside the API:")
    print("  elapsed = real time start to finish; in API = what the API reports for itself;")
    print("  outside = the difference; overlap = other extractions running at the same time")
    print(f"  {'document':<32}{'pages':>6}{'elapsed':>9}{'in API':>9}{'outside':>9}{'overlap':>9}")
    for job in worst:
        print(f"  {job['file'][:31]:<32}{job['pages']:>6}{job['duration']:>8.1f}s"
              f"{job['api']:>8.1f}s{job['overhead']:>8.1f}s{job['overlap']:>9}")
        if job["phases"]:
            detail = "  ".join(f"{k}={v}" for k, v in job["phases"].items() if v)
            print(f"      phases: {detail}")

    # The correlation that decides it: alone vs. contended.
    alone = [j["overhead"] for j in finished if j["overlap"] == 0]
    busy = [j["overhead"] for j in finished if j["overlap"] >= config.OCR_API_CONCURRENCY]
    print("\nOverhead by how busy the service was:")
    if alone:
        print(f"  ran alone              n={len(alone):<4} median {sorted(alone)[len(alone) // 2]:.1f}s")
    if busy:
        print(f"  ran with {config.OCR_API_CONCURRENCY}+ others      "
              f"n={len(busy):<4} median {sorted(busy)[len(busy) // 2]:.1f}s")

    print("\nWhat this means:")
    if alone and busy:
        quiet, loaded = sorted(alone)[len(alone) // 2], sorted(busy)[len(busy) // 2]
        if loaded > quiet * 2 + 1:
            print(f"  Overhead is {loaded / max(quiet, 0.1):.1f}x worse under load. That is QUEUING behind")
            print(f"  AKTA_OCR_CONCURRENCY={config.OCR_API_CONCURRENCY}. Raise it to what the OCR API can")
            print("  genuinely handle at once — if the API is the bottleneck, raising it only")
            print("  moves the queue to their side, so ask them what concurrency they support.")
        else:
            print("  Overhead does not grow under load, so it is NOT the local queue. It is the")
            print("  body upload or the API's own front door: a PDF travels as base64 (~4/3 the")
            print("  file size) and the API's total_time starts only once it has the whole body.")
            print("  Check the network between this host and the API, and the size of the PDFs.")
    else:
        print("  Not enough contrast in the data yet — needs jobs that ran alone AND jobs that")
        print("  ran under load. Re-run after the next busy period.")
    if not any(j["phases"] for j in finished):
        print("\n  None of these jobs carry per-phase detail (they predate it). Jobs run from")
        print("  now on break the overhead down directly, in the result panel and above.")


if __name__ == "__main__":
    main()
