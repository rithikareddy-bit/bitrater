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
import time
from datetime import datetime, timezone

import boto3
import pymongo
from google.auth.transport.requests import AuthorizedSession
from google.cloud import storage as gcs

from gcp_finalize_hls import (
    CDN_BASE,
    CONTENT_TYPE_M3U8,
    SUBTITLE_LANGS,
    _get_episode_meta,
    _get_gcp_credentials,
    _get_subtitle_vtt_urls,
    _upload_subtitles_to_gcs,
)
from media_cdn_signer import sign_url_prefix, append_signing_params


CDN_BUCKET = "chai-shots-manifests"
RESIGN_LAMBDA_ARN = os.environ.get("RESIGN_PLAYBACK_URLS_LAMBDA_ARN")
SIGNING_KEY_SECRET_ID = os.environ.get("SIGNING_KEY_SECRET_ID")
SIGNED_URL_TTL_SECONDS = int(os.environ.get("SIGNED_URL_TTL_SECONDS", "7200"))
SIGNING_ENABLED = os.environ.get("SIGNING_ENABLED", "false").lower() == "true"
MEDIA_CDN_PROJECT = os.environ.get("MEDIA_CDN_PROJECT", "media-cdn-poc-466009")
MEDIA_CDN_SERVICE = os.environ.get("MEDIA_CDN_SERVICE", "chai-shorts-media-cdn")
MEDIA_CDN_LOCATION = os.environ.get("MEDIA_CDN_LOCATION", "global")
NETWORK_SERVICES_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
SUBTITLE_GROUP_ID = '"subtitles"'

_lambda_client = None
_signing_key_cache = None


def _get_signing_key():
    """Cached fetch of the Ed25519 prefix-signing key from Secrets Manager."""
    global _signing_key_cache
    if _signing_key_cache is None:
        if not SIGNING_KEY_SECRET_ID:
            return None
        sm = boto3.client("secretsmanager")
        secret = sm.get_secret_value(SecretId=SIGNING_KEY_SECRET_ID)
        data = json.loads(secret["SecretString"])
        _signing_key_cache = (data["key_name"], data["private_key_b64url"])
    return _signing_key_cache


def _presign_subtitle_uri(absolute_uri: str, episode_id: str) -> str:
    """Pre-sign the subtitle .m3u8 absolute URI with the same prefix-sig the
    resign Lambda uses, so there is NO window where the patched master
    references unsigned subtitle children. The subsequent resign re-signs
    everything (strip-then-append is idempotent).
    """
    if not SIGNING_ENABLED:
        return absolute_uri
    key = _get_signing_key()
    if not key:
        return absolute_uri
    key_name, priv = key
    url_prefix = f"{CDN_BASE}/{episode_id}/"
    expires_unix = int(time.time()) + SIGNED_URL_TTL_SECONDS
    qs = sign_url_prefix(url_prefix, expires_unix, key_name, priv)
    return append_signing_params(absolute_uri, qs)


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


def _presign_subtitle_playlist(creds, cdn_prefix: str, playlist_filename: str, episode_id: str) -> None:
    """Rewrite the just-uploaded subtitle_<lang>.m3u8 so its bare .vtt URI
    carries signing params from the start. Resign will idempotently re-sign
    on its sweep; this just removes the unsigned-window between our patch
    upload and the resign Lambda completing."""
    if not SIGNING_ENABLED:
        return
    key = _get_signing_key()
    if not key:
        return
    key_name, priv = key
    episode_id_in_path = cdn_prefix.split("/", 1)[0]
    url_prefix = f"{CDN_BASE}/{episode_id_in_path}/"
    expires_unix = int(time.time()) + SIGNED_URL_TTL_SECONDS
    qs = sign_url_prefix(url_prefix, expires_unix, key_name, priv)

    bucket = gcs.Client(credentials=creds).bucket(CDN_BUCKET)
    blob = bucket.blob(f"{cdn_prefix}/{playlist_filename}")
    text = blob.download_as_text(encoding="utf-8")

    def rewrite(line: str) -> str:
        s = line.strip()
        if not s or s.startswith("#"):
            return line
        return append_signing_params(s, qs)

    new_text = "\n".join(rewrite(l) for l in text.splitlines()) + "\n"
    blob.cache_control = "no-store"
    blob.upload_from_string(new_text, content_type=CONTENT_TYPE_M3U8)


def _patch_combined_master(creds, cdn_prefix: str, master_filename: str, subtitle_tracks, episode_id: str):
    """Patch combined master in place with ABSOLUTE subtitle URIs and dedupe.

    Idempotent — running twice on the same master does NOT duplicate
    EXT-X-MEDIA lines or SUBTITLES="subtitles" attributes. Absolute URIs let
    `resign_playback_urls._collect_child_m3u8_paths` discover the subtitle
    playlists so they get signed alongside h264/h265 children.
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

    existing_langs = set()
    for line in lines:
        if line.startswith("#EXT-X-MEDIA") and 'TYPE=SUBTITLES' in line and f'GROUP-ID={SUBTITLE_GROUP_ID}' in line:
            m = re.search(r'LANGUAGE="([^"]+)"', line)
            if m:
                existing_langs.add(m.group(1))

    new_subtitle_lines = []
    for lang_code, display_name, playlist_filename in subtitle_tracks:
        if lang_code in existing_langs:
            continue
        default = "YES" if lang_code == "en" and "en" not in existing_langs else "NO"
        absolute_uri_unsigned = f"{CDN_BASE}/{cdn_prefix}/{playlist_filename}"
        absolute_uri = _presign_subtitle_uri(absolute_uri_unsigned, episode_id)
        new_subtitle_lines.append(
            f'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID={SUBTITLE_GROUP_ID},'
            f'NAME="{display_name}",LANGUAGE="{lang_code}",'
            f'DEFAULT={default},AUTOSELECT=YES,'
            f'URI="{absolute_uri}"'
        )

    patched = []
    inserted = False
    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF"):
            if not inserted and new_subtitle_lines:
                patched.extend(new_subtitle_lines)
                inserted = True
            if 'SUBTITLES=' not in line:
                line = line.rstrip() + f',SUBTITLES={SUBTITLE_GROUP_ID}'
            patched.append(line)
        else:
            patched.append(line)

    if not new_subtitle_lines and not any(
        ('SUBTITLES=' not in l and l.startswith('#EXT-X-STREAM-INF')) for l in lines
    ):
        # Nothing to add and every STREAM-INF already references the group → no-op
        print(f"[PATCH] {master_filename} already has all subtitle tracks; skipping upload")
        return True

    new_text = "\n".join(patched).rstrip() + "\n"
    if new_text == text.rstrip() + "\n":
        print(f"[PATCH] {master_filename} unchanged after patch; skipping upload")
        return True

    blob.cache_control = "no-store"
    blob.upload_from_string(new_text, content_type=CONTENT_TYPE_M3U8)
    added = [t[0] for t in subtitle_tracks if t[0] not in existing_langs]
    print(f"[PATCH] {master_filename}: added langs={added}, existing={sorted(existing_langs)}")
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
    resp = session.post(url, json={"pathMatcher": path_pattern})
    if resp.status_code >= 300:
        print(f"[CDN] invalidation FAILED for {path_pattern}: {resp.status_code} {resp.text}")
    else:
        print(f"[CDN] invalidation queued for {path_pattern}")


def _resync_one(db, episode_id: str) -> dict:
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

    vtt_urls = _get_subtitle_vtt_urls(episode_id)
    if not vtt_urls:
        return {"episode_id": episode_id, "status": "skipped", "reason": "no-vtts-available"}

    _, _, _, _, video_duration = _get_episode_meta(db, episode_id)
    creds = _get_gcp_credentials()

    tracks = _upload_subtitles_to_gcs(creds, cdn_prefix, vtt_urls, video_duration)
    if not tracks:
        return {"episode_id": episode_id, "status": "skipped", "reason": "no-tracks-uploaded"}

    # Pre-sign each new subtitle .m3u8's bare .vtt URI so there is no window
    # where players see unsigned children between our upload and the resign
    # Lambda completing. Resign will strip-and-re-sign idempotently.
    for _, _, playlist_filename in tracks:
        try:
            _presign_subtitle_playlist(creds, cdn_prefix, playlist_filename, episode_id)
        except Exception as e:
            print(f"[PRESIGN] {playlist_filename} failed (non-fatal, resign will handle): {e}")
    _patch_combined_master(creds, cdn_prefix, master_filename, tracks, episode_id)
    resign_result = _invoke_resign(episode_id, canonical)
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
        "tracks": [t[0] for t in tracks],
        "signed_url": resign_result.get("signed_url"),
    }


def handler(event, context):
    """Single-episode invocation: {"episode_id": "..."}."""
    episode_id = event["episode_id"]
    mongo_client = pymongo.MongoClient(os.environ["MONGO_URI"])
    try:
        db = mongo_client["chai_q_lab"]
        return _resync_one(db, episode_id)
    finally:
        mongo_client.close()
