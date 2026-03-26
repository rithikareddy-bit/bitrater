"""
State 6 of GCP-Orchestrator: FinalizeHLS

After the GCP Transcoder job succeeds:
1. Clear only this codec's files from CDN bucket
2. Copy transcoder output (codec-specific) from GCS to CDN
3. Fetch subtitle VTT URLs, upload to GCS, generate subtitle playlists
4. Patch only this codec's master m3u8 with subtitle track entries
5. Write only this codec's CDN URL to MongoDB
6. Return both URL keys (null for codec not produced)
"""

import os
import json
import boto3
import pymongo
import requests
from datetime import datetime, timezone
from google.cloud import storage as gcs
from google.oauth2 import service_account


CDN_BASE = "https://cdn.chaishots.in"
CDN_BUCKET = "chai-shots-manifests"

SUBTITLE_LANGS = {
    "english_translation_final": ("en", "English"),
    "native_script_final":       ("te", "Telugu"),
    "reviewed_romanized":        ("tlg", "Tinglish"),
}

SUBTITLE_PLAYLIST_TEMPLATE = """\
#EXTM3U
#EXT-X-TARGETDURATION:86400
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:86400.0,
{vtt_filename}
#EXT-X-ENDLIST
"""


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _get_episode_meta(db, episode_id):
    """Fetch episode metadata from showcache to derive slug and output key."""
    master_db = db.client["master"]
    show = master_db["showcache"].find_one(
        {"episodes.id": episode_id},
        {"episodes.$": 1, "slug": 1},
    )
    if not show or not show.get("episodes"):
        raise ValueError(f"Episode {episode_id} not found in showcache")
    ep = show["episodes"][0]
    episode_slug = ep.get("slug", episode_id)
    show_slug = show.get("slug", "unknown")
    episode_number = ep.get("episode_number", 0)
    episode_output_key = f"{show_slug}/{episode_slug}"
    return episode_slug, episode_output_key, show_slug, episode_number


# ---------------------------------------------------------------------------
# Subtitle pipeline: MongoDB -> HTTP download -> GCS upload -> manifest patch
# ---------------------------------------------------------------------------

def _get_subtitle_vtt_urls(episode_id):
    """Query the subtitle MongoDB for VTT S3 URLs keyed by language."""
    subtitle_uri = os.environ.get("SUBTITLE_MONGO_URI")
    if not subtitle_uri:
        print("[SUBS] SUBTITLE_MONGO_URI not configured, skipping subtitles")
        return {}

    client = pymongo.MongoClient(subtitle_uri)
    try:
        db = client["gld2sqs"]
        doc = db["subtitles"].find_one(
            {"episodes.episode_id": episode_id},
            {"episodes.$": 1},
        )
        if not doc or not doc.get("episodes"):
            print(f"[SUBS] No subtitle record for episode {episode_id}")
            return {}

        vtt_files = doc["episodes"][0].get("vtt_files", {})
        result = {}
        for lang_key, (lang_code, _) in SUBTITLE_LANGS.items():
            url = vtt_files.get(lang_key)
            if url:
                result[lang_key] = url
            else:
                print(f"[SUBS] Missing {lang_key} VTT for episode {episode_id}")
        print(f"[SUBS] Found {len(result)} subtitle URLs for {episode_id}")
        return result
    finally:
        client.close()


def _download_vtt(url):
    """Download VTT content from a public S3 URL."""
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text


def _upload_subtitles_to_gcs(creds, episode_id, vtt_urls):
    """Download VTTs, upload to GCS, and create subtitle .m3u8 playlists.
    Returns list of (lang_code, display_name, playlist_filename) for uploaded languages."""
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    uploaded = []

    for lang_key, url in vtt_urls.items():
        lang_code, display_name = SUBTITLE_LANGS[lang_key]
        vtt_filename = f"subtitle_{lang_code}.vtt"
        playlist_filename = f"subtitle_{lang_code}.m3u8"

        try:
            vtt_content = _download_vtt(url)
            print(f"[SUBS] Downloaded {lang_key}: {len(vtt_content)} bytes")

            vtt_blob = bucket.blob(f"{episode_id}/{vtt_filename}")
            vtt_blob.upload_from_string(vtt_content, content_type="text/vtt")

            playlist_content = SUBTITLE_PLAYLIST_TEMPLATE.format(vtt_filename=vtt_filename)
            playlist_blob = bucket.blob(f"{episode_id}/{playlist_filename}")
            playlist_blob.upload_from_string(playlist_content, content_type="application/x-mpegURL")

            uploaded.append((lang_code, display_name, playlist_filename))
            print(f"[SUBS] Uploaded {vtt_filename} + {playlist_filename}")
        except Exception as e:
            print(f"[SUBS] Failed to process {lang_key}: {e}")

    return uploaded


def _patch_master_manifest(creds, episode_id, manifest_name, subtitle_tracks):
    """Download master .m3u8, inject subtitle entries, re-upload."""
    if not subtitle_tracks:
        return

    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{episode_id}/{manifest_name}")

    if not blob.exists():
        print(f"[PATCH] Skipping {manifest_name} — does not exist")
        return

    original = blob.download_as_text()
    lines = original.strip().split("\n")

    subtitle_lines = []
    for lang_code, display_name, playlist_filename in subtitle_tracks:
        default = "YES" if lang_code == "en" else "NO"
        subtitle_lines.append(
            f'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",'
            f'NAME="{display_name}",LANGUAGE="{lang_code}",'
            f'DEFAULT={default},AUTOSELECT=YES,'
            f'URI="{playlist_filename}"'
        )

    patched = []
    header_done = False
    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF"):
            if not header_done:
                patched.extend(subtitle_lines)
                header_done = True
            if 'SUBTITLES=' not in line:
                line = line.rstrip() + ',SUBTITLES="subtitles"'
            patched.append(line)
        else:
            patched.append(line)

    patched_text = "\n".join(patched) + "\n"
    blob.upload_from_string(patched_text, content_type="application/x-mpegURL")
    print(f"[PATCH] Patched {manifest_name} with {len(subtitle_tracks)} subtitle tracks")


# ---------------------------------------------------------------------------
# Clear codec-specific CDN files + copy transcoder output
# ---------------------------------------------------------------------------

def _codec_filename_pattern(codec):
    """Blob names that belong to this codec."""
    if codec == "h264":
        return "h264"
    return "h265"


def _clear_cdn_bucket_codec(creds, episode_id, codec):
    """Delete only this codec's objects for this episode in the CDN bucket."""
    pattern = _codec_filename_pattern(codec)
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    prefix = f"{episode_id}/"
    blobs = list(bucket.list_blobs(prefix=prefix))
    to_delete = [b for b in blobs if pattern in b.name]
    if to_delete:
        bucket.delete_blobs(to_delete)
        print(f"[CLEAR] Deleted {len(to_delete)} {codec} objects from gs://{CDN_BUCKET}/{prefix}")
    else:
        print(f"[CLEAR] No existing {codec} objects in gs://{CDN_BUCKET}/{prefix}")


def _copy_to_cdn_bucket(creds, source_bucket_name, episode_id):
    """Copy all transcoder output from the source bucket to the CDN bucket."""
    client = gcs.Client(credentials=creds)
    src_bucket = client.bucket(source_bucket_name)
    dst_bucket = client.bucket(CDN_BUCKET)

    prefix = f"{episode_id}/"
    blobs = list(src_bucket.list_blobs(prefix=prefix))
    print(f"[COPY] Found {len(blobs)} objects in gs://{source_bucket_name}/{prefix}")

    for blob in blobs:
        src_bucket.copy_blob(blob, dst_bucket, new_name=blob.name)

    print(f"[COPY] Copied {len(blobs)} objects to gs://{CDN_BUCKET}/{prefix}")


_RESOLUTION_ORDER = {"720p": 0, "480p": 1, "1080p": 2}

def _resolution_rank(stream_inf_line):
    """Return sort key for a #EXT-X-STREAM-INF line based on RESOLUTION= attribute."""
    import re
    m = re.search(r'RESOLUTION=(\d+)x(\d+)', stream_inf_line)
    if not m:
        return 99
    width = int(m.group(1))
    if width <= 480:
        tag = "480p"
    elif width <= 720:
        tag = "720p"
    else:
        tag = "1080p"
    return _RESOLUTION_ORDER.get(tag, 99)


def _reorder_streams_in_manifest(creds, episode_id, manifest_name):
    """Download manifest, reorder #EXT-X-STREAM-INF blocks to 720p→480p→1080p, re-upload."""
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{episode_id}/{manifest_name}")
    if not blob.exists():
        print(f"[REORDER] {manifest_name} not found, skipping")
        return

    text = blob.download_as_text()
    lines = text.strip().split("\n")

    header = []
    stream_blocks = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF"):
            uri = lines[i + 1] if i + 1 < len(lines) else ""
            stream_blocks.append((line, uri))
            i += 2
        else:
            header.append(line)
            i += 1

    stream_blocks.sort(key=lambda b: _resolution_rank(b[0]))

    reordered = list(header)
    for inf_line, uri_line in stream_blocks:
        reordered.append(inf_line)
        reordered.append(uri_line)

    blob.upload_from_string("\n".join(reordered) + "\n", content_type="application/x-mpegURL")
    print(f"[REORDER] Reordered streams in {manifest_name} to 720p→480p→1080p")


def _fix_audio_name(creds, episode_id, slug, codec):
    """Replace placeholder audio NAME in the codec's master manifest."""
    manifest_name = f"{codec}_master.m3u8"
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{episode_id}/{manifest_name}")
    if not blob.exists():
        return
    text = blob.download_as_text()
    patched = text.replace('NAME="Test Language"', f'NAME="{slug}"')
    if patched != text:
        blob.upload_from_string(patched, content_type="application/x-mpegURL")
        print(f"[PATCH] Fixed audio NAME to '{slug}' in {manifest_name}")


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def handler(event, context):
    episode_id = event["episode_id"]
    output_uri = event["output_uri"]
    codec = event.get("codec", "h265")
    mongo_uri = os.environ["MONGO_URI"]
    gcs_output_bucket = os.environ["GCS_OUTPUT_BUCKET"]

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    gcs_prefix = output_uri.replace(f"gs://{gcs_output_bucket}/", "").rstrip("/")

    episode_slug, _, show_slug, episode_number = _get_episode_meta(db, episode_id)

    creds = _get_gcp_credentials()
    _clear_cdn_bucket_codec(creds, episode_id, codec)
    _copy_to_cdn_bucket(creds, gcs_output_bucket, episode_id)
    _fix_audio_name(creds, episode_id, episode_slug, codec)
    _reorder_streams_in_manifest(creds, episode_id, f"{codec}_master.m3u8")

    # --- Subtitle pipeline (only for this codec's manifest) ---
    vtt_urls = _get_subtitle_vtt_urls(episode_id)
    subtitle_tracks = []
    if vtt_urls:
        try:
            subtitle_tracks = _upload_subtitles_to_gcs(creds, episode_id, vtt_urls)
            manifest_name = f"{codec}_master.m3u8"
            _patch_master_manifest(creds, episode_id, manifest_name, subtitle_tracks)
        except Exception as e:
            print(f"[SUBS] Subtitle injection failed (non-fatal): {e}")
            finished_key = f"gcp_finished_at_{codec}"
            db.video_episodes.update_one(
                {"episode_id": episode_id},
                {"$set": {
                    "gcp_subtitle_error": str(e),
                    finished_key: datetime.now(timezone.utc).isoformat(),
                }},
            )

    now_iso = datetime.now(timezone.utc).isoformat()
    date_str = datetime.now(timezone.utc).strftime("%d%m%Y")
    versioned_name = f"{show_slug}_ep_{episode_number}_{date_str}_{codec}.m3u8"

    # Copy final patched master to versioned filename for CDN cache busting
    cdn_client = gcs.Client(credentials=creds)
    cdn_bucket = cdn_client.bucket(CDN_BUCKET)
    src_blob = cdn_bucket.blob(f"{episode_id}/{codec}_master.m3u8")
    cdn_bucket.copy_blob(src_blob, cdn_bucket, new_name=f"{episode_id}/{versioned_name}")
    print(f"[VERSION] Copied to {versioned_name}")

    url_value = f"{CDN_BASE}/{episode_id}/{versioned_name}"

    url_key = f"{codec}_master_m3u8_url"
    status_key = f"gcp_job_status_{codec}"
    finished_key = f"gcp_finished_at_{codec}"
    update = {
        status_key: "SUCCEEDED",
        finished_key: now_iso,
        url_key: url_value,
        "subtitles_injected": len(subtitle_tracks),
    }
    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": update},
    )

    h264_url = url_value if codec == "h264" else None
    h265_url = url_value if codec == "h265" else None

    # Preserve existing URL for the other codec when $set
    existing = db.video_episodes.find_one(
        {"episode_id": episode_id},
        {"h264_master_m3u8_url": 1, "h265_master_m3u8_url": 1},
    )
    if codec == "h264":
        h265_url = existing.get("h265_master_m3u8_url")
    else:
        h264_url = existing.get("h264_master_m3u8_url")

    print(f"[OK] Finalized HLS for {episode_id} (codec={codec})")
    print(f"  {codec.upper()}: {url_value}")
    print(f"  Subtitles: {len(subtitle_tracks)} tracks")

    return {
        "episode_id": episode_id,
        "h264_master_m3u8_url": h264_url,
        "h265_master_m3u8_url": h265_url,
    }
