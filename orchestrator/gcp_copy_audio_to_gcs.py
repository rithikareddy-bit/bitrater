"""
Audio State 1: Copy source audio from its CloudFront/HTTPS URL to GCS.

Unlike the video copy (gcp_copy_s3_to_gcs.py), the podcast source `audio_url` is a
public CloudFront HTTPS URL (verified: d27vk6lpclibck.cloudfront.net/uploads/...),
not an s3:// URI. So we stream it over plain HTTPS straight into GCS — no AWS creds,
no bucket/region parsing, no /tmp (avoids the Lambda 512 MB limit).

Writes:  gs://${GCS_INPUT_BUCKET}/input/${episode_id}/source.<ext>
Clears:  gs://${GCS_OUTPUT_BUCKET}/output/${episode_id}/  (stale prior renditions)
"""

import os
import json
from datetime import datetime, timezone
from urllib.parse import urlparse

import boto3
import pymongo
import requests
from google.cloud import storage as gcs
from google.oauth2 import service_account
import runtime_config
import secret_store


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    info = secret_store.get_json(secret_arn)
    return service_account.Credentials.from_service_account_info(info)


def _set_status(episode_id, fields):
    """Best-effort status stamp on chai_q_lab.audio_episodes so the dashboard shows
    progress (and failures) through the copy/normalize phases, not just from transcode on."""
    try:
        pymongo.MongoClient(os.environ["MONGO_URI"])[runtime_config.DB_LAB].audio_episodes.update_one(
            {"episode_id": episode_id}, {"$set": fields}, upsert=True
        )
    except Exception as e:  # status is non-critical; never fail the step over it
        print(f"[WARN] status write failed: {e}")


def _ext_from(url: str, content_type: str) -> str:
    path = urlparse(url).path.lower()
    for ext in (".wav", ".mp3", ".m4a", ".aac", ".flac"):
        if path.endswith(ext):
            return ext.lstrip(".")
    ct = (content_type or "").lower()
    if "wav" in ct:
        return "wav"
    if "mpeg" in ct or "mp3" in ct:
        return "mp3"
    return "bin"


def handler(event, context):
    episode_id = event["episode_id"]
    audio_url = event["audio_url"]
    # podcast_showcache stores some audio_url values without a scheme
    # (e.g. "d27vk6lpclibck.cloudfront.net/..."). requests needs one — default to https.
    if audio_url and not audio_url.startswith(("http://", "https://")):
        audio_url = "https://" + audio_url
    try:
        return _copy(episode_id, audio_url)
    except Exception as e:
        _set_status(episode_id, {
            "gcp_job_status": "FAILED",
            "gcp_error": f"copy: {e}",
            "gcp_finished_at": datetime.now(timezone.utc).isoformat(),
        })
        raise


def _copy(episode_id, audio_url):
    gcs_input_bucket = os.environ.get("AUDIO_GCS_BUCKET") or os.environ["GCS_INPUT_BUCKET"]  # AUDIO_GCS_BUCKET: Azure runs audio + video in one app (shared GCS_* names)
    gcs_output_bucket = os.environ.get("AUDIO_GCS_BUCKET") or os.environ.get("GCS_OUTPUT_BUCKET", gcs_input_bucket)

    _set_status(episode_id, {
        "gcp_job_status": "COPYING",
        "gcp_started_at": datetime.now(timezone.utc).isoformat(),
        "audio_url": audio_url,
    })

    resp = requests.get(audio_url, stream=True, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(
            f"Source fetch failed: HTTP {resp.status_code} for {audio_url}"
        )
    resp.raw.decode_content = True
    ext = _ext_from(audio_url, resp.headers.get("Content-Type", ""))

    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds, project=os.environ["GCP_PROJECT"])

    # Clear stale renditions for this episode so a re-run never mixes old + new segments.
    out_bucket = gcs_client.bucket(gcs_output_bucket)
    stale = list(out_bucket.list_blobs(prefix=f"output/{episode_id}/"))
    if stale:
        out_bucket.delete_blobs(stale)
        print(f"[CLEAR] Deleted {len(stale)} stale objects from output/{episode_id}/")

    in_bucket = gcs_client.bucket(gcs_input_bucket)
    blob = in_bucket.blob(f"input/{episode_id}/source.{ext}")
    # resp.raw is a non-seekable stream; set chunk_size so GCS does a resumable chunked
    # upload (reads chunk_size at a time) instead of trying to seek/size or buffer it all.
    blob.chunk_size = 8 * 1024 * 1024  # 8 MiB (multiple of 256 KiB, as GCS requires)
    blob.upload_from_file(
        resp.raw, size=None, content_type=resp.headers.get("Content-Type")
    )

    gcs_input_uri = f"gs://{gcs_input_bucket}/input/{episode_id}/source.{ext}"
    print(f"[OK] Streamed {audio_url} -> {gcs_input_uri}")

    return {
        "episode_id": episode_id,
        "gcs_input_uri": gcs_input_uri,
        "source_ext": ext,
    }
