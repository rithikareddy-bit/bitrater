"""
Standalone Lambda: Build combined_master.m3u8 from h264 + h265 master manifests.

Steps:
1. Download h264_master.m3u8 and h265_master.m3u8 from CDN GCS bucket
2. Strip per-codec headers and collect EXT-X-MEDIA + stream blocks
3. Sort all stream blocks by ascending BANDWIDTH
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

def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _bandwidth(stream_inf_line):
    m = re.search(r'BANDWIDTH=(\d+)', stream_inf_line)
    return int(m.group(1)) if m else 0


_RESOLUTION_ORDER = {"720p": 0, "1080p": 1, "480p": 2}

def _sort_key(stream_inf_line):
    """Sort by resolution order (720p→1080p→480p), then descending bandwidth within each group."""
    m = re.search(r'RESOLUTION=(\d+)x(\d+)', stream_inf_line)
    if m:
        width = int(m.group(1))
        if width <= 480:
            tag = "480p"
        elif width <= 720:
            tag = "720p"
        else:
            tag = "1080p"
    else:
        tag = "720p"
    return (_RESOLUTION_ORDER.get(tag, 99), -_bandwidth(stream_inf_line))


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

    # Separate audio and subtitle lines for each codec
    h265_audio_lines = [l for l in h265_media if 'TYPE=AUDIO' in l]
    h264_audio_lines = [l for l in h264_media if 'TYPE=AUDIO' in l]

    # Deduplicate subtitle lines only
    seen_subtitles = {}
    for line in h265_media + h264_media:
        if 'TYPE=SUBTITLES' not in line:
            continue
        m = re.search(r'GROUP-ID="([^"]+)".*?LANGUAGE="([^"]+)"', line)
        key = m.group(0) if m else line
        if key not in seen_subtitles:
            seen_subtitles[key] = line
    subtitle_lines = list(seen_subtitles.values())

    # Give each codec its own audio group ID so timestamps stay aligned
    h265_audio_group = "audio-h265"
    h264_audio_group = "audio-h264"

    h265_audio_lines = [re.sub(r'GROUP-ID="[^"]+"', f'GROUP-ID="{h265_audio_group}"', l) for l in h265_audio_lines]
    h264_audio_lines = [re.sub(r'GROUP-ID="[^"]+"', f'GROUP-ID="{h264_audio_group}"', l) for l in h264_audio_lines]

    # Sort all streams by ascending bandwidth
    all_streams = h264_streams + h265_streams
    all_streams.sort(key=lambda b: _sort_key(b[0]))

    # Build combined manifest
    output_lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    output_lines.extend(h265_audio_lines)
    output_lines.extend(h264_audio_lines)
    output_lines.extend(subtitle_lines)

    for inf_line, uri_line in all_streams:
        if "h265" in uri_line:
            inf_line = re.sub(r'AUDIO="[^"]+"', f'AUDIO="{h265_audio_group}"', inf_line)
            if 'AUDIO=' not in inf_line:
                inf_line = inf_line + f',AUDIO="{h265_audio_group}"'
        else:
            inf_line = re.sub(r'AUDIO="[^"]+"', f'AUDIO="{h264_audio_group}"', inf_line)
            if 'AUDIO=' not in inf_line:
                inf_line = inf_line + f',AUDIO="{h264_audio_group}"'
        if subtitle_lines and 'SUBTITLES=' not in inf_line:
            inf_line = inf_line + ',SUBTITLES="subtitles"'
        output_lines.append(inf_line)
        output_lines.append(uri_line)

    combined_text = "\n".join(output_lines) + "\n"

    # Fetch show metadata for versioned filename
    mongo_client = pymongo.MongoClient(mongo_uri)
    show = mongo_client["master"]["showcache"].find_one(
        {"episodes.id": episode_id},
        {"episodes.$": 1, "slug": 1},
    )
    show_slug = "unknown"
    episode_number = 0
    if show and show.get("episodes"):
        show_slug = show.get("slug", "unknown")
        episode_number = show["episodes"][0].get("episode_number", 0)

    now_iso = datetime.now(timezone.utc).isoformat()
    _now = datetime.now(timezone.utc)
    date_str = _now.strftime("%d%m%Y")
    time_str = _now.strftime("%H%M%S")
    versioned_name = f"{show_slug}_ep_{episode_number}_{date_str}_{time_str}_combined.m3u8"

    # Upload to CDN bucket under a versioned filename so CDN always fetches fresh
    combined_blob = bucket.blob(f"{episode_id}/{versioned_name}")
    combined_blob.upload_from_string(combined_text, content_type="application/x-mpegURL")
    print(f"[COMBINED] Uploaded {versioned_name} for {episode_id}")

    combined_url = f"{CDN_BASE}/{episode_id}/{versioned_name}"

    mongo_client["chai_q_lab"].video_episodes.update_one(
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
