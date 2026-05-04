"""
URL Health Checker Lambda

Checks every playback URL in the system every hour:
  - h264_master_m3u8_url  (from chai_q_lab.video_episodes)
  - h265_master_m3u8_url  (from chai_q_lab.video_episodes)
  - combined signed_playback_url  (from master.showcache episodes)
  - trailer gcpUrl  (from master.showcache trailers_playback_urls)

For each URL, does an HTTP HEAD (falling back to GET) and records HTTP status,
latency, and whether the URL is a valid HLS manifest (starts with #EXTM3U).

Results are written to chai_q_lab.url_health_runs:
  {
    run_id, started_at, finished_at,
    results: [ { episode_id, url_type, url, status, ok, latency_ms, error, checked_at } ]
    summary: { total, ok, failed }
  }
"""

import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import boto3
import pymongo

from media_cdn_signer import sign_url_prefix, append_signing_params, strip_existing_signing_params

CDN_BASE = os.environ.get("CDN_BASE", "https://cdn.chaishots.in")
SIGNED_URL_TTL_SECONDS = int(os.environ.get("SIGNED_URL_TTL_SECONDS", "3600"))
MAX_WORKERS = int(os.environ.get("URL_HEALTH_WORKERS", "20"))
REQUEST_TIMEOUT = 8  # seconds

_signing_key_cache = None


def _get_signing_key():
    global _signing_key_cache
    if _signing_key_cache is None:
        secret_id = os.environ["SIGNING_KEY_SECRET_ID"]
        sm = boto3.client("secretsmanager")
        secret = sm.get_secret_value(SecretId=secret_id)
        data = json.loads(secret["SecretString"])
        _signing_key_cache = (data["key_name"], data["private_key_b64url"])
    return _signing_key_cache


def _signing_enabled() -> bool:
    return os.environ.get("SIGNING_ENABLED", "false").lower() == "true"


def _sign_url(url: str) -> str:
    """Sign a CDN URL if signing is enabled and URL starts with CDN_BASE.

    Strips any existing signing params first so already-signed combined/trailer
    URLs from showcache don't get double-signed.
    Returns the URL unchanged if signing is disabled or URL is off-CDN.
    """
    if not url or not url.startswith(CDN_BASE + "/") or not _signing_enabled():
        return url
    clean = strip_existing_signing_params(url)
    rest = clean[len(CDN_BASE) + 1:]
    first_seg = rest.split("/", 1)[0]
    if not first_seg:
        return url
    url_prefix = f"{CDN_BASE}/{first_seg}/"
    expires_unix = int(time.time()) + SIGNED_URL_TTL_SECONDS
    key_name, priv = _get_signing_key()
    qs = sign_url_prefix(url_prefix, expires_unix, key_name, priv)
    return append_signing_params(clean, qs)


def _check_url(episode_id: str, url_type: str, raw_url: str,
               show_title: str = None, episode_name: str = None, episode_number=None) -> dict:
    """HEAD (or GET) one URL and return a result dict."""
    checked_at = datetime.now(timezone.utc).isoformat()
    meta = {
        "episode_id": episode_id,
        "url_type": url_type,
        "show_title": show_title,
        "episode_name": episode_name,
        "episode_number": episode_number,
        "url": raw_url,
        "checked_at": checked_at,
    }
    if not raw_url:
        return {**meta, "status": None, "ok": False, "latency_ms": None, "error": "empty url"}

    try:
        signed = _sign_url(raw_url)
    except Exception as e:
        return {**meta, "status": None, "ok": False, "latency_ms": None, "error": f"signing failed: {e}"}

    t0 = time.monotonic()
    try:
        req = urllib.request.Request(signed, method="HEAD")
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            latency_ms = round((time.monotonic() - t0) * 1000)
            status = resp.status
            ok = 200 <= status < 300
            return {**meta, "status": status, "ok": ok, "latency_ms": latency_ms, "error": None}
    except urllib.error.HTTPError as e:
        latency_ms = round((time.monotonic() - t0) * 1000)
        # 405 Method Not Allowed → server doesn't support HEAD, try GET with range
        if e.code == 405:
            try:
                req2 = urllib.request.Request(
                    signed,
                    method="GET",
                    headers={"Range": "bytes=0-511"},
                )
                with urllib.request.urlopen(req2, timeout=REQUEST_TIMEOUT) as resp2:
                    latency_ms = round((time.monotonic() - t0) * 1000)
                    body = resp2.read(512).decode("utf-8-sig", errors="replace")
                    ok = body.lstrip().startswith("#EXTM3U")
                    return {**meta, "status": resp2.status, "ok": ok, "latency_ms": latency_ms,
                            "error": None if ok else "not a valid HLS manifest"}
            except Exception as e2:
                latency_ms = round((time.monotonic() - t0) * 1000)
                return {**meta, "status": None, "ok": False, "latency_ms": latency_ms, "error": str(e2)[:300]}
        return {**meta, "status": e.code, "ok": False, "latency_ms": latency_ms, "error": str(e)[:300]}
    except Exception as e:
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {**meta, "status": None, "ok": False, "latency_ms": latency_ms, "error": str(e)[:300]}


def _pick_episode_number(ep, index):
    for key in ("episode_number", "episodeNumber", "number", "episode", "seq", "position", "index"):
        v = ep.get(key)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return index + 1


def _collect_urls(mongo_client) -> list[dict]:
    """
    Returns list of dicts with episode_id, url_type, url, show_title, episode_name, episode_number.
    Sources: chai_q_lab.video_episodes (per-codec URLs) + master.showcache (combined + trailers).
    """
    entries = []

    # Build episode_id → (show_title, episode_name, episode_number) lookup from showcache
    showcache = mongo_client["master"]["showcache"]
    ep_meta = {}   # episode_id → {show_title, episode_name, episode_number}

    for show in showcache.find(
        {},
        {"title": 1,
         "episodes.id": 1, "episodes.title": 1,
         "episodes.episode_number": 1, "episodes.episodeNumber": 1,
         "episodes.number": 1, "episodes.episode": 1, "episodes.seq": 1,
         "episodes.signed_playback_url": 1,
         "trailers_playback_urls._key": 1, "trailers_playback_urls.gcpUrl": 1},
    ):
        show_title = show.get("title") or "Unknown Show"
        for i, ep in enumerate(show.get("episodes") or []):
            eid = str(ep.get("id") or ep.get("_id") or "")
            if not eid:
                continue
            ep_meta[eid] = {
                "show_title": show_title,
                "episode_name": ep.get("title"),
                "episode_number": _pick_episode_number(ep, i),
            }
            # combined signed URL
            url = ep.get("signed_playback_url")
            if url:
                entries.append({
                    "episode_id": eid,
                    "url_type": "combined",
                    "url": url,
                    "show_title": show_title,
                    "episode_name": ep.get("title"),
                    "episode_number": _pick_episode_number(ep, i),
                })
        for t in show.get("trailers_playback_urls") or []:
            url = t.get("gcpUrl")
            if url:
                key = t.get("_key", "unknown")
                entries.append({
                    "episode_id": f"trailer_{key}",
                    "url_type": "trailer",
                    "url": url,
                    "show_title": show_title,
                    "episode_name": "Trailer",
                    "episode_number": None,
                })

    # Per-codec master manifests from chai_q_lab.video_episodes
    q_lab = mongo_client["chai_q_lab"]
    for ep in q_lab.video_episodes.find(
        {"$or": [
            {"h264_master_m3u8_url": {"$exists": True, "$ne": None}},
            {"h265_master_m3u8_url": {"$exists": True, "$ne": None}},
        ]},
        {"episode_id": 1, "h264_master_m3u8_url": 1, "h265_master_m3u8_url": 1},
    ):
        eid = ep.get("episode_id", str(ep["_id"]))
        meta = ep_meta.get(eid, {"show_title": None, "episode_name": None, "episode_number": None})
        if ep.get("h264_master_m3u8_url"):
            entries.append({"episode_id": eid, "url_type": "master",
                            "url": ep["h264_master_m3u8_url"], **meta})
        if ep.get("h265_master_m3u8_url"):
            entries.append({"episode_id": eid, "url_type": "master",
                            "url": ep["h265_master_m3u8_url"], **meta})

    return entries


def handler(event, context):
    mongo_uri = os.environ["MONGO_URI"]
    mongo_client = pymongo.MongoClient(mongo_uri)

    started_at = datetime.now(timezone.utc).isoformat()
    print(f"[URL-HEALTH] Starting run at {started_at}")

    try:
        # Pre-warm signing key cache before threads start to avoid concurrent Secrets Manager calls.
        if _signing_enabled():
            _get_signing_key()

        entries = _collect_urls(mongo_client)
        print(f"[URL-HEALTH] Found {len(entries)} URLs to check")

        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {
                pool.submit(
                    _check_url,
                    e["episode_id"], e["url_type"], e["url"],
                    e.get("show_title"), e.get("episode_name"), e.get("episode_number"),
                ): e["episode_id"]
                for e in entries
            }
            for future in concurrent.futures.as_completed(futures):
                results.append(future.result())

        ok_count = sum(1 for r in results if r["ok"])
        failed_count = len(results) - ok_count

        finished_at = datetime.now(timezone.utc).isoformat()
        run_doc = {
            "started_at": started_at,
            "finished_at": finished_at,
            "results": results,
            "summary": {
                "total": len(results),
                "ok": ok_count,
                "failed": failed_count,
            },
        }

        mongo_client["chai_q_lab"]["url_health_runs"].insert_one(run_doc)
        run_id = str(run_doc["_id"])

        print(f"[URL-HEALTH] Done. {ok_count} OK / {failed_count} FAILED — run_id={run_id}")
        return {
            "run_id": run_id,
            "summary": run_doc["summary"],
        }

    finally:
        mongo_client.close()
