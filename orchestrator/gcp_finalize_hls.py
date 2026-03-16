"""
State 6 of GCP-Orchestrator: FinalizeHLS

After the GCP Transcoder job succeeds:
1. Copy transcoder output from GCS output bucket to CDN bucket
2. Fetch subtitle VTT URLs from subtitle MongoDB, download, upload to GCS
3. Generate per-language subtitle .m3u8 playlists
4. Patch master m3u8 manifests (h264 + h265) with subtitle track entries
5. Write final CDN URLs to MongoDB
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
    episode_output_key = f"{show_slug}/{episode_slug}"
    return episode_slug, episode_output_key


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
# Copy transcoder output to CDN bucket
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def handler(event, context):
    episode_id = event["episode_id"]
    output_uri = event["output_uri"]
    mongo_uri = os.environ["MONGO_URI"]
    gcs_output_bucket = os.environ["GCS_OUTPUT_BUCKET"]

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    gcs_prefix = output_uri.replace(f"gs://{gcs_output_bucket}/", "").rstrip("/")

    creds = _get_gcp_credentials()
    _copy_to_cdn_bucket(creds, gcs_output_bucket, episode_id)

    # --- Subtitle pipeline ---
    vtt_urls = _get_subtitle_vtt_urls(episode_id)
    subtitle_tracks = []
    if vtt_urls:
        try:
            subtitle_tracks = _upload_subtitles_to_gcs(creds, episode_id, vtt_urls)
            _patch_master_manifest(creds, episode_id, "h264_master.m3u8", subtitle_tracks)
            _patch_master_manifest(creds, episode_id, "h265_master.m3u8", subtitle_tracks)
        except Exception as e:
            print(f"[SUBS] Subtitle injection failed (non-fatal): {e}")
            db.video_episodes.update_one(
                {"episode_id": episode_id},
                {"$set": {
                    "gcp_subtitle_error": str(e),
                    "gcp_finished_at": datetime.now(timezone.utc).isoformat(),
                }},
            )

    h264_url = f"{CDN_BASE}/{gcs_prefix}/h264_master.m3u8"
    h265_url = f"{CDN_BASE}/{gcs_prefix}/h265_master.m3u8"

    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "gcp_job_status": "SUCCEEDED",
            "gcp_finished_at": datetime.now(timezone.utc).isoformat(),
            "h264_master_m3u8_url": h264_url,
            "h265_master_m3u8_url": h265_url,
            "subtitles_injected": len(subtitle_tracks),
        }},
    )

    print(f"[OK] Finalized HLS for {episode_id}")
    print(f"  H.264: {h264_url}")
    print(f"  H.265: {h265_url}")
    print(f"  Subtitles: {len(subtitle_tracks)} tracks")

    return {
        "episode_id": episode_id,
        "h264_master_m3u8_url": h264_url,
        "h265_master_m3u8_url": h265_url,
    }
