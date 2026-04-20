"""
Standalone Lambda: Build combined_master.m3u8 from h264 + h265 master manifests.

Steps:
1. Download h264_master.m3u8 and h265_master.m3u8 from CDN GCS bucket
2. Strip per-codec headers and collect EXT-X-MEDIA + stream blocks
3. Absolutize all URIs using each codec's versioned CDN folder as base
4. Group H265 streams first (modern devices), then H264 (fallback)
5. Within each codec group, sort 720p→480p→1080p
6. Upload to CDN bucket under {episode_id}/{timestamp}/{slug}_combined.m3u8
7. Save combined_master_m3u8_url to chai_q_lab.video_episodes
"""

import os
import re
import json
import boto3
import pymongo
from datetime import datetime, timezone
from google.cloud import storage as gcs
from google.oauth2 import service_account


CDN_BASE = os.environ["CDN_BASE"]
CDN_BUCKET = "chai-shots-manifests"

# HLS playlists are UTF-8; subtitle #EXT-X-MEDIA NAME may include non-ASCII.
CONTENT_TYPE_M3U8 = "application/x-mpegURL; charset=utf-8"


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _bandwidth(stream_inf_line):
    m = re.search(r'BANDWIDTH=(\d+)', stream_inf_line)
    return int(m.group(1)) if m else 0


_RESOLUTION_ORDER = {"720p": 0, "480p": 1, "1080p": 2}

def _sort_key(stream_inf_line):
    """Sort by resolution order (720p→480p→1080p), then descending bandwidth within each group."""
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


_TRAILER_ID_RE = re.compile(r"^trailer_([a-f0-9]{24})_(.+)$")


def _get_episode_meta(mongo_client, episode_id):
    """Fetch show_slug and episode_number (or trailer_key) from showcache.

    For trailer ids (`trailer_<showObjectId>_<_key>`) return the _key as the
    number-slot so filename builders can produce stable trailer-specific names.
    """
    master_db = mongo_client["master"]

    trailer_match = _TRAILER_ID_RE.match(episode_id)
    if trailer_match:
        from bson import ObjectId as _ObjectId
        show_id_hex, trailer_key = trailer_match.group(1), trailer_match.group(2)
        show = master_db["showcache"].find_one(
            {"_id": _ObjectId(show_id_hex), "trailers_playback_urls._key": trailer_key},
            {"slug": 1},
        )
        if not show:
            return "unknown", trailer_key
        return show.get("slug", "unknown"), trailer_key

    show = master_db["showcache"].find_one(
        {"episodes.id": episode_id},
        {"episodes.$": 1, "slug": 1},
    )
    if not show or not show.get("episodes"):
        return "unknown", 0
    ep = show["episodes"][0]
    return show.get("slug", "unknown"), ep.get("episode_number", 0)


def _download_manifest_from_url(bucket, cdn_base, url):
    """Download a manifest blob using its full CDN URL to derive the GCS path."""
    gcs_path = url[len(cdn_base) + 1:]  # strip "https://cdn.chaishots.in/"
    blob = bucket.blob(gcs_path)
    if not blob.exists():
        raise FileNotFoundError(f"Manifest not found at gs path: {gcs_path}")
    return blob.download_as_text(encoding="utf-8")


def handler(event, context):
    episode_id = event["episode_id"]
    mongo_uri = os.environ["MONGO_URI"]

    mongo_client = pymongo.MongoClient(mongo_uri)
    episode = mongo_client["chai_q_lab"].video_episodes.find_one(
        {"episode_id": episode_id},
        {"h264_master_m3u8_url": 1, "h265_master_m3u8_url": 1},
    )
    h264_url = episode.get("h264_master_m3u8_url") if episode else None
    h265_url = episode.get("h265_master_m3u8_url") if episode else None
    if not h264_url or not h265_url:
        raise ValueError(f"Missing h264/h265 URLs for episode {episode_id}")

    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds)
    bucket = gcs_client.bucket(CDN_BUCKET)

    print(f"[COMBINED] Downloading codec manifests for {episode_id}")
    h264_text = _download_manifest_from_url(bucket, CDN_BASE, h264_url)
    h265_text = _download_manifest_from_url(bucket, CDN_BASE, h265_url)

    # Base CDN folder for each codec (absolute, no trailing slash)
    h264_base = h264_url.rsplit("/", 1)[0]
    h265_base = h265_url.rsplit("/", 1)[0]

    def _absolutize(line, base):
        """Replace relative URI="..." values with absolute CDN URLs."""
        return re.sub(
            r'URI="(?!https?://)([^"]+)"',
            lambda m: f'URI="{base}/{m.group(1)}"',
            line,
        )

    h264_media, h264_streams = _parse_manifest(h264_text)
    h265_media, h265_streams = _parse_manifest(h265_text)

    # Absolutize stream URIs
    h264_streams = [
        (inf, f"{h264_base}/{uri}" if not uri.startswith("http") else uri)
        for inf, uri in h264_streams
    ]
    h265_streams = [
        (inf, f"{h265_base}/{uri}" if not uri.startswith("http") else uri)
        for inf, uri in h265_streams
    ]

    # Separate audio lines, absolutize URIs
    h265_audio_lines = [_absolutize(l, h265_base) for l in h265_media if 'TYPE=AUDIO' in l]
    h264_audio_lines = [_absolutize(l, h264_base) for l in h264_media if 'TYPE=AUDIO' in l]

    # Deduplicate subtitle lines, absolutize URIs
    seen_subtitles = {}
    for line, base in (
        [(l, h265_base) for l in h265_media if 'TYPE=SUBTITLES' in l] +
        [(l, h264_base) for l in h264_media if 'TYPE=SUBTITLES' in l]
    ):
        m = re.search(r'GROUP-ID="([^"]+)".*?LANGUAGE="([^"]+)"', line)
        key = m.group(0) if m else line
        if key not in seen_subtitles:
            seen_subtitles[key] = _absolutize(line, base)
    subtitle_lines = list(seen_subtitles.values())

    # Give each codec its own audio group ID so timestamps stay aligned
    h265_audio_group = "audio-h265"
    h264_audio_group = "audio-h264"

    h265_audio_lines = [re.sub(r'GROUP-ID="[^"]+"', f'GROUP-ID="{h265_audio_group}"', l) for l in h265_audio_lines]
    h264_audio_lines = [re.sub(r'GROUP-ID="[^"]+"', f'GROUP-ID="{h264_audio_group}"', l) for l in h264_audio_lines]

    # Group H265 first (modern phones), then H264 (fallback).
    # Within each codec, sort by resolution order (720p→480p→1080p).
    # This prevents ABR from switching between codec groups mid-playback,
    # which would also switch audio groups and cause audio gaps.
    h265_streams.sort(key=lambda b: _sort_key(b[0]))
    h264_streams.sort(key=lambda b: _sort_key(b[0]))
    all_streams = h265_streams + h264_streams

    # Build combined manifest (VERSION:7 — sub-manifests use fMP4/BYTERANGE features)
    output_lines = ["#EXTM3U", "#EXT-X-VERSION:7"]
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

    _now = datetime.now(timezone.utc)
    folder_ts = _now.strftime("%d%m%Y_%H%M%S")
    now_iso = _now.isoformat()
    cdn_prefix = f"{episode_id}/{folder_ts}"

    show_slug, episode_number = _get_episode_meta(mongo_client, episode_id)
    if _TRAILER_ID_RE.match(episode_id):
        combined_filename = f"{show_slug}_trailer_{episode_number}_{folder_ts}_combined.m3u8"
    else:
        combined_filename = f"{show_slug}_ep_{episode_number}_{folder_ts}_combined.m3u8"

    combined_blob = bucket.blob(f"{cdn_prefix}/{combined_filename}")
    combined_blob.cache_control = "no-store"
    combined_blob.upload_from_string(combined_text, content_type=CONTENT_TYPE_M3U8)
    print(f"[COMBINED] Uploaded {combined_filename} to {cdn_prefix}/")

    combined_url = f"{CDN_BASE}/{cdn_prefix}/{combined_filename}"

    try:
        mongo_client["chai_q_lab"].video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {
                "combined_master_m3u8_url": combined_url,
                "combined_master_created_at": now_iso,
            }},
        )
    finally:
        mongo_client.close()

    print(f"[COMBINED] Saved combined URL: {combined_url}")
    return {
        "episode_id": episode_id,
        "combined_master_m3u8_url": combined_url,
    }
