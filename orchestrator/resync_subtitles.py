"""On-demand Lambda: inject (or refresh) subtitles into an episode's combined
master HLS manifest WITHOUT re-running the GCP Transcoder.

Flow per episode:
1. Read combined_master_m3u8_url from chai_q_lab.video_episodes
2. Pull VTT URLs from the subtitle Mongo (gld2sqs.subtitles)
3. Upload subtitle_<lang>.vtt + subtitle_<lang>.m3u8 to GCS next to the master
4. Patch combined master in place:
     - dedupe existing EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles"
     - inject ABSOLUTE subtitle .m3u8 URIs so the resign step finds them
     - add SUBTITLES="subtitles" to STREAM-INF lines that lack it
5. Invoke chai-q-resign-playback-urls with {episode_id, canonical_url}
     - re-signs combined master and every absolute child .m3u8
     - inside subtitle_<lang>.m3u8, signs the bare subtitle_<lang>.vtt URI
     - writes a fresh signed_playback_url + expiry into master.showcache
6. Issue a Media CDN invalidateCache for /{cdn_prefix}/*
7. Stamp chai_q_lab.video_episodes.subtitles_injected + subtitles_resynced_at

Triggered by the dashboard "Resync Subtitles" buttons (per-episode or show-wide
fan-out from the API route).

Required env:
    MONGO_URI, SUBTITLE_MONGO_URI, GCP_CREDENTIALS_SECRET_ARN, CDN_BASE,
    RESIGN_PLAYBACK_URLS_LAMBDA_ARN
Optional env:
    MEDIA_CDN_PROJECT  (default: media-cdn-poc-466009)
    MEDIA_CDN_SERVICE  (default: chai-shorts-media-cdn)
    MEDIA_CDN_LOCATION (default: global)
    SKIP_CDN_INVALIDATION=1 to disable
"""

import json
import os
import re
from datetime import datetime, timezone

import boto3
import pymongo
from google.auth.transport.requests import AuthorizedSession
from google.cloud import storage as gcs

from gcp_finalize_hls import (
    CDN_BASE,
    CONTENT_TYPE_M3U8,
    build_subtitle_langs,
    _get_episode_meta,
    _get_gcp_credentials,
    _get_subtitle_vtt_urls,
    _upload_subtitles_to_gcs,
)
CDN_BUCKET = "chai-shots-manifests"
RESIGN_LAMBDA_ARN = os.environ.get("RESIGN_PLAYBACK_URLS_LAMBDA_ARN")
MEDIA_CDN_PROJECT = os.environ.get("MEDIA_CDN_PROJECT", "media-cdn-poc-466009")
MEDIA_CDN_SERVICE = os.environ.get("MEDIA_CDN_SERVICE", "chai-shorts-media-cdn")
MEDIA_CDN_LOCATION = os.environ.get("MEDIA_CDN_LOCATION", "global")
NETWORK_SERVICES_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
SUBTITLE_GROUP_ID = '"subtitles"'

_lambda_client = None


def _split_cdn_url(url: str):
    """Return (cdn_prefix, master_filename) from a CDN_BASE-rooted absolute URL."""
    base = CDN_BASE.rstrip("/") + "/"
    if not url.startswith(base):
        raise ValueError(f"URL not under CDN_BASE ({CDN_BASE}): {url}")
    path = url[len(base):].split("?", 1)[0]
    prefix, _, filename = path.rpartition("/")
    if not prefix or not filename:
        raise ValueError(f"Cannot parse cdn_prefix/filename from {url}")
    return prefix, filename




def _patch_combined_master(creds, cdn_prefix: str, master_filename: str, subtitle_tracks, episode_id: str):
    """Patch combined master in place: STRIP all existing entries in our
    subtitle group and rewrite the canonical set from `subtitle_tracks`.

    Why strip-and-rewrite instead of dedupe-by-LANGUAGE: an earlier version of
    this code hardcoded `LANGUAGE="te"` for any non-Telugu show, so historical
    masters carry mislabeled entries (e.g. Kannada labeled "te"). We own the
    GROUP-ID="subtitles" group, so wiping ours and rewriting is safe.
    Other groups (audio etc.) are untouched.

    Absolute subtitle URIs let resign_playback_urls discover and sign them.
    """
    if not subtitle_tracks:
        return False

    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{cdn_prefix}/{master_filename}")
    if not blob.exists():
        print(f"[PATCH] {master_filename} missing in {cdn_prefix}/")
        return False

    text = blob.download_as_text(encoding="utf-8")
    lines = text.replace("\r\n", "\n").split("\n")

    # Strip every existing EXT-X-MEDIA line in OUR subtitle group. Lines for
    # other groups (audio, other subtitle groups if any) are preserved.
    def _is_our_subtitle_media(line: str) -> bool:
        return (
            line.startswith("#EXT-X-MEDIA")
            and "TYPE=SUBTITLES" in line
            and f"GROUP-ID={SUBTITLE_GROUP_ID}" in line
        )

    stripped_count = sum(1 for l in lines if _is_our_subtitle_media(l))
    if stripped_count:
        print(f"[PATCH] Stripping {stripped_count} existing subtitle entries from {master_filename}")

    new_subtitle_lines = []
    en_seen = False
    for lang_code, display_name, playlist_filename in subtitle_tracks:
        default = "YES" if (lang_code == "en" and not en_seen) else "NO"
        if lang_code == "en":
            en_seen = True
        absolute_uri = f"{CDN_BASE}/{cdn_prefix}/{playlist_filename}"
        new_subtitle_lines.append(
            f'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID={SUBTITLE_GROUP_ID},'
            f'NAME="{display_name}",LANGUAGE="{lang_code}",'
            f'DEFAULT={default},AUTOSELECT=YES,'
            f'URI="{absolute_uri}"'
        )

    patched = []
    inserted = False
    for line in lines:
        if _is_our_subtitle_media(line):
            continue  # drop old entries
        if line.startswith("#EXT-X-STREAM-INF"):
            if not inserted:
                patched.extend(new_subtitle_lines)
                inserted = True
            if 'SUBTITLES=' not in line:
                line = line.rstrip() + f',SUBTITLES={SUBTITLE_GROUP_ID}'
            patched.append(line)
        else:
            patched.append(line)

    new_text = "\n".join(patched).rstrip() + "\n"
    if new_text == text.rstrip() + "\n":
        print(f"[PATCH] {master_filename} unchanged after patch; skipping upload")
        return True

    blob.cache_control = "public, max-age=2592000"
    blob.upload_from_string(new_text, content_type=CONTENT_TYPE_M3U8)
    print(f"[PATCH] {master_filename}: stripped={stripped_count}, "
          f"wrote langs={[t[0] for t in subtitle_tracks]}")
    return True


def _invoke_resign(episode_id: str, canonical_url: str) -> dict:
    """Trigger chai-q-resign-playback-urls so the combined master + every
    child .m3u8 (including our new subtitle playlists) get signed and the
    fresh signed URL is written into master.showcache.

    Fails loud if the env var is missing — silently skipping would leave the
    subtitle children unsigned and players would 403 on every .vtt fetch
    while subtitles_injected was marked > 0 in Mongo.
    """
    if not RESIGN_LAMBDA_ARN:
        raise RuntimeError(
            "RESIGN_PLAYBACK_URLS_LAMBDA_ARN env var not set; refusing to "
            "mark subtitles injected without re-signing the master + children."
        )
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client("lambda")
    payload = {"episode_id": episode_id, "canonical_url": canonical_url}
    resp = _lambda_client.invoke(
        FunctionName=RESIGN_LAMBDA_ARN,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    body = resp["Payload"].read().decode("utf-8")
    if resp.get("FunctionError"):
        raise RuntimeError(f"resign Lambda failed: {body}")
    print(f"[RESIGN] {episode_id}: {body}")
    return json.loads(body) if body else {}


def _invalidate_cdn(creds, cdn_prefix: str) -> None:
    if os.environ.get("SKIP_CDN_INVALIDATION") == "1":
        print("[CDN] SKIP_CDN_INVALIDATION=1, skipping invalidation")
        return
    scoped = creds.with_scopes([NETWORK_SERVICES_SCOPE]) if hasattr(creds, "with_scopes") else creds
    session = AuthorizedSession(scoped)
    service_path = (
        f"projects/{MEDIA_CDN_PROJECT}/locations/{MEDIA_CDN_LOCATION}"
        f"/edgeCacheServices/{MEDIA_CDN_SERVICE}"
    )
    url = f"https://networkservices.googleapis.com/v1/{service_path}:invalidateCache"
    path_pattern = f"/{cdn_prefix.strip('/')}/*"
    resp = session.post(url, json={"path": path_pattern})
    if resp.status_code >= 300:
        print(f"[CDN] invalidation FAILED for {path_pattern}: {resp.status_code} {resp.text}")
    else:
        print(f"[CDN] invalidation queued for {path_pattern}")


def _resync_one(db, episode_id: str, skip_cdn_invalidation: bool = False) -> dict:
    episode = db.video_episodes.find_one(
        {"episode_id": episode_id},
        {"combined_master_m3u8_url": 1, "subtitles_injected": 1},
    )
    if not episode:
        return {"episode_id": episode_id, "status": "skipped", "reason": "not-in-video-episodes"}

    combined_url = episode.get("combined_master_m3u8_url")
    if not combined_url:
        return {"episode_id": episode_id, "status": "skipped", "reason": "no-combined-master"}

    canonical = combined_url.split("?", 1)[0]
    cdn_prefix, master_filename = _split_cdn_url(canonical)

    vtt_urls, source_language = _get_subtitle_vtt_urls(episode_id)
    if not vtt_urls:
        return {"episode_id": episode_id, "status": "skipped", "reason": "no-vtts-available"}

    _, _, _, _, video_duration = _get_episode_meta(db, episode_id)
    creds = _get_gcp_credentials()
    subtitle_langs = build_subtitle_langs(source_language)

    tracks = _upload_subtitles_to_gcs(creds, cdn_prefix, vtt_urls, video_duration, subtitle_langs)
    if not tracks:
        return {"episode_id": episode_id, "status": "skipped", "reason": "no-tracks-uploaded"}

    _patch_combined_master(creds, cdn_prefix, master_filename, tracks, episode_id)
    resign_result = _invoke_resign(episode_id, canonical)

    if not skip_cdn_invalidation:
        _invalidate_cdn(creds, cdn_prefix)

    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "subtitles_injected": len(tracks),
            "subtitles_resynced_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {
        "episode_id": episode_id,
        "status": "ok",
        "cdn_prefix": cdn_prefix,
        "tracks": [t[0] for t in tracks],
        "signed_url": resign_result.get("signed_url"),
    }


def handler(event, context):
    """
    Single-episode:  {"episode_id": "..."}
    Batch mode:      {"episode_ids": ["...", ...]}
      — processes all episodes, skips per-episode CDN invalidation,
        then fires invalidations sequentially at the end (same as local script).
    """
    mongo_client = pymongo.MongoClient(os.environ["MONGO_URI"])
    try:
        db = mongo_client["chai_q_lab"]

        episode_ids = event.get("episode_ids")
        if episode_ids:
            # First call fetches from Secrets Manager and caches; subsequent
            # calls inside _resync_one return the cached value instantly.
            creds = _get_gcp_credentials()
            fixed_prefixes = set()
            results = []
            ok = skipped = errors = 0
            for eid in episode_ids:
                try:
                    result = _resync_one(db, eid, skip_cdn_invalidation=True)
                    results.append(result)
                    if result.get("status") == "ok":
                        ok += 1
                        fixed_prefixes.add(result["cdn_prefix"])
                    else:
                        skipped += 1
                except Exception as e:
                    errors += 1
                    print(f"[batch] {eid} error: {e}")

            # Sequential CDN invalidation — same pattern as fix_subtitle_timestamp_map.py
            for prefix in sorted(fixed_prefixes):
                _invalidate_cdn(creds, prefix)

            return {
                "batch": True,
                "ok": ok,
                "skipped": skipped,
                "errors": errors,
                "invalidated": len(fixed_prefixes),
            }

        episode_id = event["episode_id"]
        return _resync_one(db, episode_id)
    finally:
        mongo_client.close()
