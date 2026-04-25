"""Re-sign Media CDN combined-master URLs and rotate them in showcache.

Two invocation modes (one handler):
  event == {}                              → full sweep of master.showcache
  event == {"episode_id", "canonical_url"} → sign one episode/trailer (from sync route)

Per-episode work: generate Ed25519 signing params with TTL from
SIGNED_URL_TTL_SECONDS, rewrite the combined-master file on GCS so its absolute
child URLs carry the same signature, then write the top-level signed URL into
master.showcache (episodes[].signed_playback_url or trailers_playback_urls[].gcpUrl).
"""

import concurrent.futures
import json
import os
import re
import time
from datetime import datetime, timezone

import boto3
import pymongo
from bson import ObjectId
from google.cloud import storage as gcs
from google.oauth2 import service_account

from media_cdn_signer import sign_url_prefix, append_signing_params, strip_existing_signing_params


CDN_BASE = os.environ["CDN_BASE"]
CDN_BUCKET = "chai-shots-manifests"
CONTENT_TYPE_M3U8 = "application/x-mpegURL; charset=utf-8"
COMBINED_MARKER = "_combined.m3u8"
TRAILER_ID_RE = re.compile(r"^trailer_([a-f0-9]{24})_(.+)$")
MAX_WORKERS = 16


_signing_key_cache = None
_gcp_client_cache = None


def _get_signing_key():
    global _signing_key_cache
    if _signing_key_cache is None:
        secret_id = os.environ["SIGNING_KEY_SECRET_ID"]
        sm = boto3.client("secretsmanager")
        secret = sm.get_secret_value(SecretId=secret_id)
        data = json.loads(secret["SecretString"])
        _signing_key_cache = (data["key_name"], data["private_key_b64url"])
    return _signing_key_cache


def _get_gcp_client():
    global _gcp_client_cache
    if _gcp_client_cache is None:
        secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
        sm = boto3.client("secretsmanager")
        secret = sm.get_secret_value(SecretId=secret_arn)
        info = json.loads(secret["SecretString"])
        creds = service_account.Credentials.from_service_account_info(info)
        _gcp_client_cache = gcs.Client(credentials=creds)
    return _gcp_client_cache


def _ttl_seconds() -> int:
    return int(os.environ.get("SIGNED_URL_TTL_SECONDS", "7200"))


def _signing_enabled() -> bool:
    """Kill switch. When false, sync-route invocations write the canonical URL
    as-is (no signing, no GCS rewrite) and clear any stale signed_playback_expires_at.
    Full-sweep mode returns immediately with a no-op summary."""
    return os.environ.get("SIGNING_ENABLED", "false").lower() == "true"


def _is_trailer(episode_id: str) -> bool:
    return TRAILER_ID_RE.match(episode_id) is not None


def _episode_id_from_url(canonical: str) -> str:
    path = canonical[len(CDN_BASE):].lstrip("/")
    return path.split("/", 1)[0]


def _blob_path_from_url(canonical: str) -> str:
    return canonical[len(CDN_BASE):].lstrip("/")


def _upload_m3u8(bucket, blob_path: str, text: str) -> None:
    new_blob = bucket.blob(blob_path)
    new_blob.cache_control = "no-store"
    new_blob.upload_from_string(text, content_type=CONTENT_TYPE_M3U8)


def _sign_uri(uri: str, qs: str) -> str:
    """Strip any existing signing params from a URI, then append fresh ones."""
    clean = strip_existing_signing_params(uri.strip())
    sep = "&" if "?" in clean else "?"
    return f"{clean}{sep}{qs}"


def _collect_child_m3u8_paths(combined_text: str) -> list:
    """Every absolute cdn.chaishots.in m3u8 URL found in the combined master —
    returned as GCS blob paths (stripped of scheme/host and any query string)."""
    paths = set()
    for m in re.finditer(r"https://cdn\.chaishots\.in/[^\s\"']+\.m3u8", combined_text):
        paths.add(m.group(0)[len(CDN_BASE):].lstrip("/"))
    return sorted(paths)


def _rewrite_child_playlist(bucket, blob_path: str, qs: str) -> None:
    """Append signing params to every URI inside a per-codec/audio/subtitle m3u8.
    Players (iOS AVPlayer, ExoPlayer) follow RFC 3986 URI resolution, which does
    NOT propagate query strings from parent manifest requests to relative child
    URIs. So we bake the params directly into each segment + init URI. Idempotent
    via strip-then-append."""
    blob = bucket.blob(blob_path)
    text = blob.download_as_text(encoding="utf-8")

    def rewrite_line(line: str) -> str:
        stripped = line.strip()
        if not stripped:
            return line
        if stripped.startswith("#"):
            # Handle URI="..." inside a tag (e.g. #EXT-X-MAP:URI="init.m4s").
            if 'URI="' in line:
                return re.sub(
                    r'URI="([^"]+)"',
                    lambda m: f'URI="{_sign_uri(m.group(1), qs)}"',
                    line,
                )
            return line
        # Bare URI on its own line — a segment reference.
        return _sign_uri(stripped, qs)

    new_text = "\n".join(rewrite_line(l) for l in text.splitlines())
    if not new_text.endswith("\n"):
        new_text += "\n"
    _upload_m3u8(bucket, blob_path, new_text)


def _rewrite_combined_master(bucket, blob_path: str, qs: str) -> None:
    """Rewrite the combined master m3u8 AND every child playlist it references.
    The combined master uses absolute cdn.chaishots.in URIs for child playlists;
    those need signing params on them AND inside them so players can reach every
    segment without relying on query-string inheritance."""
    blob = bucket.blob(blob_path)
    text = blob.download_as_text(encoding="utf-8")

    # Capture child-playlist paths from the ORIGINAL text (stripped, no prior qs).
    child_paths = _collect_child_m3u8_paths(text)

    def rewrite_line(line: str) -> str:
        if CDN_BASE in line:
            return re.sub(
                r"https://cdn\.chaishots\.in/[^\s\"']+",
                lambda m: append_signing_params(m.group(0), qs),
                line,
            )
        return line

    new_text = "\n".join(rewrite_line(l) for l in text.splitlines())
    if not new_text.endswith("\n"):
        new_text += "\n"
    _upload_m3u8(bucket, blob_path, new_text)

    # Recurse into each child playlist (one level — children reference segments,
    # not further playlists). Child failures are logged but don't abort; at least
    # the combined master is fresh.
    for child_path in child_paths:
        try:
            _rewrite_child_playlist(bucket, child_path, qs)
        except Exception as e:
            print(f"[resign] child playlist {child_path} rewrite failed: {e}")


def _write_showcache(mongo_client, episode_id: str, url: str, expires_unix: int, signed: bool) -> bool:
    """Write URL into master.showcache. When `signed=True`, also stamps
    signed_playback_expires_at. When `signed=False`, clears that field so stale
    expiry dates don't linger. Returns True iff a showcache document matched."""
    master = mongo_client["master"]["showcache"]

    trailer_match = TRAILER_ID_RE.match(episode_id)
    if trailer_match:
        show_id_hex, trailer_key = trailer_match.group(1), trailer_match.group(2)
        update = {"$set": {"trailers_playback_urls.$[t].gcpUrl": url}}
        if signed:
            expires_at = datetime.fromtimestamp(expires_unix, tz=timezone.utc)
            update["$set"]["trailers_playback_urls.$[t].signed_playback_expires_at"] = expires_at
        else:
            update["$unset"] = {"trailers_playback_urls.$[t].signed_playback_expires_at": ""}
        result = master.update_one(
            {"_id": ObjectId(show_id_hex)},
            update,
            array_filters=[{"t._key": trailer_key}],
        )
    else:
        update = {"$set": {"episodes.$[ep].signed_playback_url": url}}
        if signed:
            expires_at = datetime.fromtimestamp(expires_unix, tz=timezone.utc)
            update["$set"]["episodes.$[ep].signed_playback_expires_at"] = expires_at
        else:
            update["$unset"] = {"episodes.$[ep].signed_playback_expires_at": ""}
        result = master.update_one(
            {"episodes.id": episode_id},
            update,
            array_filters=[{"ep.id": episode_id}],
        )
    return result.matched_count > 0


def _process_one(mongo_client, episode_id: str, canonical: str, expires_unix: int) -> dict:
    if COMBINED_MARKER not in canonical:
        return {"episode_id": episode_id, "skipped": "not-combined"}

    # Kill switch: when signing is disabled, write the canonical URL as-is and
    # clear any stale expiry. No Ed25519 work, no GCS rewrite.
    if not _signing_enabled():
        updated = _write_showcache(mongo_client, episode_id, canonical, expires_unix, signed=False)
        if not updated:
            return {"episode_id": episode_id, "skipped": "not-in-showcache"}
        return {
            "episode_id": episode_id,
            "signing_disabled": True,
            "signed_url": canonical,
        }

    key_name, priv = _get_signing_key()
    url_prefix = f"{CDN_BASE}/{_episode_id_from_url(canonical)}/"
    qs = sign_url_prefix(url_prefix, expires_unix, key_name, priv)

    bucket = _get_gcp_client().bucket(CDN_BUCKET)
    _rewrite_combined_master(bucket, _blob_path_from_url(canonical), qs)

    signed_top = append_signing_params(canonical, qs)
    updated = _write_showcache(mongo_client, episode_id, signed_top, expires_unix, signed=True)

    if not updated:
        return {"episode_id": episode_id, "skipped": "not-in-showcache"}

    return {
        "episode_id": episode_id,
        "expires": expires_unix,
        "gcs_rewritten": True,
        "signed_url": signed_top,
    }


def _collect_sweep_targets(mongo_client) -> list:
    showcache = mongo_client["master"]["showcache"]
    targets = []
    cursor = showcache.find(
        {},
        {"_id": 1, "episodes.id": 1, "episodes.signed_playback_url": 1,
         "trailers_playback_urls._key": 1, "trailers_playback_urls.gcpUrl": 1},
    )
    for show in cursor:
        for ep in show.get("episodes") or []:
            url = ep.get("signed_playback_url")
            if url and COMBINED_MARKER in url:
                targets.append({
                    "episode_id": ep["id"],
                    "canonical": url.split("?", 1)[0],
                })
        for t in show.get("trailers_playback_urls") or []:
            url = t.get("gcpUrl")
            if url and COMBINED_MARKER in url:
                targets.append({
                    "episode_id": f"trailer_{show['_id']}_{t['_key']}",
                    "canonical": url.split("?", 1)[0],
                })
    return targets


def _targeted(event: dict, mongo_client, expires_unix: int) -> dict:
    episode_id = event["episode_id"]
    canonical = event["canonical_url"].split("?", 1)[0]
    return _process_one(mongo_client, episode_id, canonical, expires_unix)


def _full_sweep(mongo_client, expires_unix: int) -> dict:
    started_at = datetime.now(timezone.utc)

    # Kill switch: full-sweep is a no-op when signing is disabled. Writes a
    # marker run doc so the admin panel can see the cron fired but did nothing.
    if not _signing_enabled():
        finished_at = datetime.now(timezone.utc)
        run_doc = {
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_s": (finished_at - started_at).total_seconds(),
            "updated_count": 0,
            "skipped_count": 0,
            "errors": [],
            "signing_disabled": True,
        }
        mongo_client["chai_q_lab"]["playback_resign_runs"].insert_one(dict(run_doc))
        run_doc["started_at"] = run_doc["started_at"].isoformat()
        run_doc["finished_at"] = run_doc["finished_at"].isoformat()
        return run_doc

    targets = _collect_sweep_targets(mongo_client)

    updated = 0
    skipped = 0
    errors = []

    def worker(target):
        return _process_one(mongo_client, target["episode_id"], target["canonical"], expires_unix)

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(worker, t): t for t in targets}
        for fut in concurrent.futures.as_completed(futures):
            target = futures[fut]
            try:
                result = fut.result()
                if result.get("skipped"):
                    skipped += 1
                else:
                    updated += 1
            except Exception as e:
                errors.append({"episode_id": target["episode_id"], "message": str(e)})

    finished_at = datetime.now(timezone.utc)
    run_doc = {
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_s": (finished_at - started_at).total_seconds(),
        "updated_count": updated,
        "skipped_count": skipped,
        "errors": errors,
    }
    mongo_client["chai_q_lab"]["playback_resign_runs"].insert_one(dict(run_doc))
    run_doc["started_at"] = run_doc["started_at"].isoformat()
    run_doc["finished_at"] = run_doc["finished_at"].isoformat()
    return run_doc


def handler(event, context):
    mongo_client = pymongo.MongoClient(os.environ["MONGO_URI"])
    expires_unix = int(time.time()) + _ttl_seconds()

    try:
        if event and event.get("episode_id"):
            return _targeted(event, mongo_client, expires_unix)
        return _full_sweep(mongo_client, expires_unix)
    finally:
        mongo_client.close()
