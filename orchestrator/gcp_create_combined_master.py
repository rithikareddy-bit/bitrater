"""
Standalone Lambda: Build combined_master.m3u8 from h264 + h265 master manifests.

Steps:
1. Download h264_master.m3u8 and h265_master.m3u8 from CDN GCS bucket
2. Strip per-codec headers and collect EXT-X-MEDIA + stream blocks
3. Reorder all stream blocks to 720p → 480p → 1080p
4. Merge into one combined_master.m3u8
5. Upload to CDN bucket under {episode_id}/combined_master.m3u8
6. Save combined_master_m3u8_url to chai_q_lab.video_episodes
"""

import os
import re
import json
import boto3
import pymongo
from datetime import datetime, timezone
from google.cloud import storage as gcs
from google.oauth2 import service_account


CDN_BASE = "https://cdn.chaishots.in"
CDN_BUCKET = "chai-shots-manifests"

_RESOLUTION_ORDER = {"720p": 0, "480p": 1, "1080p": 2}


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _resolution_rank(stream_inf_line):
    """Return sort key for a #EXT-X-STREAM-INF line based on RESOLUTION= attribute."""
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


def _parse_manifest(text):
    """
    Parse an HLS master manifest into:
    - media_lines: list of #EXT-X-MEDIA lines
    - stream_blocks: list of (stream_inf_line, uri_line) tuples
    """
    lines = text.strip().split("\n")
    media_lines = []
    stream_blocks = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-MEDIA"):
            media_lines.append(line)
            i += 1
        elif line.startswith("#EXT-X-STREAM-INF"):
            uri = lines[i + 1] if i + 1 < len(lines) else ""
            stream_blocks.append((line, uri))
            i += 2
        else:
            i += 1
    return media_lines, stream_blocks


def _download_manifest(bucket, episode_id, manifest_name):
    blob = bucket.blob(f"{episode_id}/{manifest_name}")
    if not blob.exists():
        raise FileNotFoundError(f"{manifest_name} not found in CDN bucket for episode {episode_id}")
    return blob.download_as_text()


def handler(event, context):
    episode_id = event["episode_id"]
    mongo_uri = os.environ["MONGO_URI"]

    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds)
    bucket = gcs_client.bucket(CDN_BUCKET)

    print(f"[COMBINED] Downloading codec manifests for {episode_id}")
    h264_text = _download_manifest(bucket, episode_id, "h264_master.m3u8")
    h265_text = _download_manifest(bucket, episode_id, "h265_master.m3u8")

    h264_media, h264_streams = _parse_manifest(h264_text)
    h265_media, h265_streams = _parse_manifest(h265_text)

    # Deduplicate subtitle EXT-X-MEDIA lines (take from h264 if present, else h265)
    seen_media = {}
    for line in h264_media + h265_media:
        m = re.search(r'GROUP-ID="([^"]+)".*?LANGUAGE="([^"]+)"', line)
        key = m.group(0) if m else line
        if key not in seen_media:
            seen_media[key] = line
    unique_media_lines = list(seen_media.values())

    # Sort all streams from both codecs: 720p → 480p → 1080p
    all_streams = h264_streams + h265_streams
    all_streams.sort(key=lambda b: _resolution_rank(b[0]))

    # Build combined manifest
    output_lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    output_lines.extend(unique_media_lines)
    for inf_line, uri_line in all_streams:
        output_lines.append(inf_line)
        output_lines.append(uri_line)
    output_lines.append("#EXT-X-ENDLIST")

    combined_text = "\n".join(output_lines) + "\n"

    # Upload to CDN bucket
    combined_blob = bucket.blob(f"{episode_id}/combined_master.m3u8")
    combined_blob.upload_from_string(combined_text, content_type="application/x-mpegURL")
    print(f"[COMBINED] Uploaded combined_master.m3u8 for {episode_id}")

    combined_url = f"{CDN_BASE}/{episode_id}/combined_master.m3u8"
    now_iso = datetime.now(timezone.utc).isoformat()

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "combined_master_m3u8_url": combined_url,
            "combined_master_created_at": now_iso,
        }},
    )

    print(f"[COMBINED] Saved combined URL: {combined_url}")
    return {
        "episode_id": episode_id,
        "combined_master_m3u8_url": combined_url,
    }
