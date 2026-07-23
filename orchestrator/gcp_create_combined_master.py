"""
Standalone Lambda: Build combined_master.m3u8 from h264 + h265 master manifests.

Steps:
1. Download h264_master.m3u8 and h265_master.m3u8 from CDN GCS bucket
2. Strip per-codec headers and collect EXT-X-MEDIA + stream blocks
3. Absolutize all URIs using each codec's versioned CDN folder as base
4. Group H265 streams first (modern devices), then H264 (fallback)
5. Within each codec group, sort 720p→480p→1080p (classic ladder) or
   144p→720p→480p→1080p when the 4-rung Audio-Video ladder is present
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

# Untokenised variant. Media CDN enforces tokens by FILENAME — route 1 matches
# `/*_combined.m3u8` at each depth; everything else falls through to the open
# catch-all. Naming this master `podcastvideo.m3u8` therefore serves it (and its
# already-open child playlists and segments) with no `edge-cache-token`.
PODCAST_VIDEO_VARIANT = "podcastvideo"
PODCAST_VIDEO_FILENAME = "podcastvideo.m3u8"


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _bandwidth(stream_inf_line):
    m = re.search(r'BANDWIDTH=(\d+)', stream_inf_line)
    return int(m.group(1)) if m else 0


# Classic 3-rung ladder: 720p first, so playback starts on a good-looking rung.
# The 4-rung Audio-Video ladder starts on the lowest rung instead — see _order_map.
_RESOLUTION_ORDER = {"720p": 0, "480p": 1, "1080p": 2}
_LOW_RUNG = "144p"
_AV_RESOLUTION_ORDER = {"144p": 0, "720p": 1, "480p": 2, "1080p": 3}


def _res_tag(stream_inf_line):
    """Resolution tag for a #EXT-X-STREAM-INF line, defaulting to 720p when absent.

    Portrait renditions are WxH with the *width* carrying the rung (144x256,
    480x854, 720x1280, 1080x1920), so the thresholds walk the width.
    """
    m = re.search(r'RESOLUTION=(\d+)x(\d+)', stream_inf_line)
    if not m:
        return "720p"
    width = int(m.group(1))
    if width <= 144:
        return "144p"
    if width <= 480:
        return "480p"
    if width <= 720:
        return "720p"
    return "1080p"


def _order_map(stream_inf_lines):
    """Pick the rung ordering: 144p-first for Audio-Video ladders, legacy otherwise."""
    tags = {_res_tag(line) for line in stream_inf_lines}
    if _LOW_RUNG in tags:
        return _AV_RESOLUTION_ORDER
    return _RESOLUTION_ORDER


def _sort_key(stream_inf_line, order=None):
    """Sort by rung order, then descending bandwidth within each rung."""
    tag = _res_tag(stream_inf_line)
    return ((order or _RESOLUTION_ORDER).get(tag, 99), -_bandwidth(stream_inf_line))


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
    # Optional. Absent (or "combined") → the classic tokenised combined master,
    # byte-for-byte the behaviour every existing caller depends on.
    variant = event.get("variant") or "combined"
    if variant not in ("combined", PODCAST_VIDEO_VARIANT):
        raise ValueError(f"Unknown variant: {variant}")
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

    # Group H265 first (modern phones), then H264 (fallback) — for every ladder.
    # H265 delivers the same quality at roughly 40% less bitrate, so it is the
    # default for anything that can decode it; H264 is the tail for devices that
    # cannot. Keeping each codec contiguous also stops ABR from crossing codec
    # groups mid-playback, which would switch audio group and cause audio gaps.
    # Within each codec, sort by the rung order chosen above (144p first for
    # Audio-Video ladders, 720p first for the classic ladder).
    order = _order_map([inf for inf, _ in (h265_streams + h264_streams)])
    h265_streams.sort(key=lambda b: _sort_key(b[0], order))
    h264_streams.sort(key=lambda b: _sort_key(b[0], order))
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

    if variant == PODCAST_VIDEO_VARIANT:
        # Token enforcement on the CDN matches the *filename* — route 1 is
        # `/*_combined.m3u8` (per depth). A master named anything else falls
        # through to the open catch-all route, and its child playlists and
        # segments are already served unsigned. So this variant is the same
        # manifest under a name that carries no token requirement.
        combined_filename = PODCAST_VIDEO_FILENAME
        url_field = "podcastvideo_m3u8_url"
        created_field = "podcastvideo_created_at"
        log_tag = "PODCASTVIDEO"
    elif _TRAILER_ID_RE.match(episode_id):
        combined_filename = f"{show_slug}_trailer_{episode_number}_{folder_ts}_combined.m3u8"
        url_field = "combined_master_m3u8_url"
        created_field = "combined_master_created_at"
        log_tag = "COMBINED"
    else:
        combined_filename = f"{show_slug}_ep_{episode_number}_{folder_ts}_combined.m3u8"
        url_field = "combined_master_m3u8_url"
        created_field = "combined_master_created_at"
        log_tag = "COMBINED"

    combined_blob = bucket.blob(f"{cdn_prefix}/{combined_filename}")
    combined_blob.cache_control = "public, max-age=2592000"
    combined_blob.upload_from_string(combined_text, content_type=CONTENT_TYPE_M3U8)
    print(f"[{log_tag}] Uploaded {combined_filename} to {cdn_prefix}/")

    combined_url = f"{CDN_BASE}/{cdn_prefix}/{combined_filename}"

    updates = {url_field: combined_url, created_field: now_iso}
    if variant != PODCAST_VIDEO_VARIANT:
        # Reset subtitles_injected: a fresh combined at a new prefix only
        # carries subs propagated from per-codec masters. Resync coverage
        # for THIS new combined must be re-asserted via the dashboard button.
        # The podcastvideo variant is a side artifact — it must not disturb the
        # combined master's subtitle bookkeeping.
        updates["subtitles_injected"] = 0

    try:
        mongo_client["chai_q_lab"].video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": updates},
        )
    finally:
        mongo_client.close()

    print(f"[{log_tag}] Saved URL: {combined_url}")
    # For the default variant url_field IS "combined_master_m3u8_url", so the
    # response shape existing callers rely on is unchanged.
    return {
        "episode_id": episode_id,
        url_field: combined_url,
    }
