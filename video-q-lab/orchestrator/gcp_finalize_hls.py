"""
State 6 of GCP-Orchestrator: FinalizeHLS

After the GCP Transcoder job succeeds:
1. Upload subtitles once via media-api (replicates sync_subs_step_4 logic)
2. Run subtitle sync twice — once for H.264 HLS folder, once for H.265 HLS folder
3. On both sync successes, write final CDN URLs to MongoDB
"""

import os
import json
import boto3
import pymongo
import requests
from datetime import datetime, timezone
from google.cloud import storage as gcs
from google.oauth2 import service_account

MEDIA_API_BASE = "https://media-api.chaishots.in"
CDN_BASE = "https://cdn.chaishots.in"

_GCP_CREDENTIALS_CACHE = None


def _get_gcp_credentials():
    """Load GCP credentials from AWS Secrets Manager (cached per container instance)."""
    global _GCP_CREDENTIALS_CACHE
    if _GCP_CREDENTIALS_CACHE is not None:
        return _GCP_CREDENTIALS_CACHE
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    _GCP_CREDENTIALS_CACHE = service_account.Credentials.from_service_account_info(info)
    return _GCP_CREDENTIALS_CACHE


def _download_subtitles_from_s3(episode_slug, s3_bucket):
    """
    Download VTT subtitle files from S3 into /tmp/subtitles/{episode_slug}/.

    Subtitles are uploaded to S3 by the manual subtitle pipeline before
    the GCP transcoding run.  If the bucket is not configured or no files
    are found, this function logs a warning and returns without raising so
    the pipeline continues without subtitles.
    """
    if not s3_bucket:
        print("[WARN] S3_SUBTITLES_BUCKET not configured — skipping subtitle download")
        return
    s3 = boto3.client("s3")
    prefix = f"subtitles/{episode_slug}/"
    dest_dir = f"/tmp/subtitles/{episode_slug}"
    os.makedirs(dest_dir, exist_ok=True)
    try:
        paginator = s3.get_paginator("list_objects_v2")
        count = 0
        for page in paginator.paginate(Bucket=s3_bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith(".vtt"):
                    continue
                fname = os.path.basename(key)
                s3.download_file(s3_bucket, key, os.path.join(dest_dir, fname))
                count += 1
        if count:
            print(f"[OK] Downloaded {count} VTT file(s) from s3://{s3_bucket}/{prefix}")
        else:
            print(f"[WARN] No VTT files found at s3://{s3_bucket}/{prefix}")
    except Exception as e:
        print(f"[WARN] Could not download subtitles from S3: {e}")


def _get_episode_meta(mongo_client, episode_id):
    """Fetch episode metadata from showcache to derive slug and output key."""
    master_db = mongo_client["master"]
    show = master_db["showcache"].find_one(
        {"episodes.id": episode_id},
        {"episodes.$": 1, "slug": 1},
    )
    if not show or not show.get("episodes"):
        raise ValueError(f"Episode {episode_id} not found in showcase")
    ep = show["episodes"][0]
    episode_slug = ep.get("slug", episode_id)
    show_slug = show.get("slug", "unknown")
    episode_output_key = f"{show_slug}/{episode_slug}"
    return episode_slug, episode_output_key


def _upload_subtitles(episode_slug):
    """
    Upload subtitles for the episode via media-api /upload-subtitles/.
    Returns subtitle_folder on success.
    """
    url = f"{MEDIA_API_BASE}/upload-subtitles/"

    vtt_dir = f"/tmp/subtitles/{episode_slug}"
    if not os.path.isdir(vtt_dir):
        print(f"[WARN] No subtitle VTT dir at {vtt_dir}, skipping subtitle upload")
        return None

    vtt_files = sorted(
        [f for f in os.listdir(vtt_dir) if f.endswith(".vtt")],
    )
    if not vtt_files:
        print(f"[WARN] No VTT files in {vtt_dir}")
        return None

    languages = []
    files_payload = []
    for vtt_name in vtt_files:
        lang = vtt_name.rsplit("_", 1)[-1].replace(".vtt", "")
        if lang in ("en", "te", "tlg"):
            languages.append(lang)
            fpath = os.path.join(vtt_dir, vtt_name)
            files_payload.append(("subtitles", (vtt_name, open(fpath, "rb"), "text/vtt")))

    if not languages:
        print("[WARN] No valid language codes found in VTT filenames")
        return None

    data = {
        "bucket": "chai-shots-manifests",
        "languages": languages,
    }

    try:
        resp = requests.post(url, data=data, files=files_payload, timeout=120)
        payload = resp.json() if resp.ok else {}
        subtitle_folder = payload.get("subtitle_folder") or payload.get("data", {}).get("subtitle_folder")
        if resp.ok and subtitle_folder:
            print(f"[OK] Subtitles uploaded, folder: {subtitle_folder}")
            return subtitle_folder
        print(f"[ERROR] Subtitle upload failed: {resp.status_code} {resp.text[:300]}")
        return None
    finally:
        for _, (_, fh, _) in files_payload:
            fh.close()


def _sync_subtitles(subtitle_folder, hls_folder):
    """Call sync-subtitles API for a single HLS folder."""
    url = f"{MEDIA_API_BASE}/sync-subtitles"
    form = {"subtitle_folder": subtitle_folder, "hls_folder": hls_folder}
    print(f"[SYNC] {form}")
    resp = requests.post(url, data=form, timeout=300)
    print(f"[SYNC] Response: {resp.status_code} {resp.text[:500]}")
    resp.raise_for_status()
    return resp.json()


def handler(event, context):
    episode_id = event["episode_id"]
    golden_recipes = event["golden_recipes"]
    output_uri = event["output_uri"]
    mongo_uri = os.environ["MONGO_URI"]
    gcs_output_bucket = os.environ["GCS_OUTPUT_BUCKET"]

    mongo_client = pymongo.MongoClient(mongo_uri)
    db = mongo_client["chai_q_lab"]
    s3_subtitles_bucket = os.environ.get("S3_SUBTITLES_BUCKET")

    episode_slug, episode_output_key = _get_episode_meta(mongo_client, episode_id)

    # GCP Transcoder writes to gs://{bucket}/{episode_id}/ — derive the
    # GCS prefix so CDN URLs match the actual transcoder output location.
    gcs_prefix = output_uri.replace(f"gs://{gcs_output_bucket}/", "").rstrip("/")

    hls_folder_h264 = f"{gcs_prefix}/h264"
    hls_folder_h265 = f"{gcs_prefix}/h265"

    # Download VTT files from S3 before attempting subtitle upload.
    _download_subtitles_from_s3(episode_slug, s3_subtitles_bucket)
    subtitle_folder = _upload_subtitles(episode_slug)

    if subtitle_folder:
        try:
            _sync_subtitles(subtitle_folder, hls_folder_h264)
            _sync_subtitles(subtitle_folder, hls_folder_h265)
        except Exception as e:
            db.video_episodes.update_one(
                {"episode_id": episode_id},
                {"$set": {
                    "gcp_job_status": "SUBTITLE_SYNC_FAILED",
                    "gcp_error": str(e),
                    "gcp_finished_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
            raise

    h264_url = f"{CDN_BASE}/{gcs_prefix}/h264_master.m3u8"
    h265_url = f"{CDN_BASE}/{gcs_prefix}/h265_master.m3u8"

    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "gcp_job_status": "SUCCEEDED",
            "gcp_finished_at": datetime.now(timezone.utc).isoformat(),
            "h264_master_m3u8_url": h264_url,
            "h265_master_m3u8_url": h265_url,
        }},
    )

    print(f"[OK] Finalized HLS for {episode_id}")
    print(f"  H.264: {h264_url}")
    print(f"  H.265: {h265_url}")

    return {
        "episode_id": episode_id,
        "h264_master_m3u8_url": h264_url,
        "h265_master_m3u8_url": h265_url,
    }
