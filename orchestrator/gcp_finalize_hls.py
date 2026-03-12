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


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _get_episode_meta(db, episode_id):
    """Fetch episode metadata from showcache to derive slug and output key."""
    master_client = pymongo.MongoClient(os.environ["MONGO_URI"])
    master_db = master_client["master"]
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

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]

    episode_slug, episode_output_key = _get_episode_meta(db, episode_id)

    hls_folder_h264 = f"hls/{episode_output_key}/h264"
    hls_folder_h265 = f"hls/{episode_output_key}/h265"

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

    h264_url = f"{CDN_BASE}/hls/{episode_output_key}/{episode_slug}_h264.m3u8"
    h265_url = f"{CDN_BASE}/hls/{episode_output_key}/{episode_slug}_h265.m3u8"

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
