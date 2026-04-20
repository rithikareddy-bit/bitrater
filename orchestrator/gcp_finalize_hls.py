"""
State 6 of GCP-Orchestrator: FinalizeHLS

After the GCP Transcoder job succeeds:
1. Copy codec-specific transcoder output into a versioned CDN folder (no delete, no overwrite)
2. Fetch subtitle VTT URLs, upload to GCS, generate subtitle playlists
3. Patch only this codec's master m3u8 with subtitle track entries
4. Write only this codec's CDN URL to MongoDB
5. Return both URL keys (null for codec not produced)

Subtitle pipeline: VTT files are read as raw bytes and decoded strictly as UTF-8 (never
requests.Response.text). GCS objects are stored with Content-Type charset=utf-8 so players
do not misinterpret Telugu or other scripts.
"""

import os
import re
import json
import boto3
import pymongo
import requests
from datetime import datetime, timezone
from google.cloud import storage as gcs
from google.oauth2 import service_account


CDN_BASE = os.environ["CDN_BASE"]
CDN_BUCKET = "chai-shots-manifests"

# WebVTT and HLS manifests must be UTF-8 (Telugu, smart quotes, etc.).
# Do not rely on HTTP Content-Type charset or requests' guessed encoding for VTT bodies.
CONTENT_TYPE_VTT = "text/vtt; charset=utf-8"
CONTENT_TYPE_M3U8 = "application/x-mpegURL; charset=utf-8"


def _decode_utf8_vtt_bytes(raw: bytes) -> str:
    """
    Decode WebVTT file bytes as UTF-8 (W3C WebVTT: UTF-8 only).
    utf-8-sig strips an optional BOM so cue text is not corrupted.
    Raises UnicodeDecodeError if the source is not valid UTF-8 (mis-encoded uploads).
    """
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        head = raw[: min(160, len(raw))]
        print(
            "[SUBS] VTT decode failed: file is not valid UTF-8. "
            "Re-export the source .vtt as UTF-8 (no Windows-1252 / Latin-1). "
            f"First {len(head)} bytes (hex): {head.hex()}"
        )
        raise


def _warn_if_missing_webvtt_header(text: str, lang_key: str) -> None:
    """Log if the file does not look like WebVTT (helps catch HTML/error pages)."""
    sample = text.lstrip("\ufeff").strip()
    first_line = sample.split("\n", 1)[0] if sample else ""
    if not first_line.upper().startswith("WEBVTT"):
        print(
            f"[SUBS] Warning ({lang_key}): expected WEBVTT header; "
            f"first line was {first_line[:120]!r}"
        )

def _parse_vtt_time_to_seconds(time_str: str) -> float:
    """Convert VTT time string (HH:MM:SS.mmm or MM:SS.mmm) to seconds."""
    time_str = time_str.strip()
    if time_str.count(":") == 2:
        h, m, s = time_str.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    elif time_str.count(":") == 1:
        m, s = time_str.split(":")
        return int(m) * 60 + float(s)
    return float(time_str)


def _seconds_to_vtt_time(seconds: float) -> str:
    """Convert seconds to VTT time string HH:MM:SS.mmm."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def _inject_gap_separators(vtt_content: str, video_duration: float = 0) -> str:
    """Insert hash-separator cues into gaps between subtitles.

    HLS players keep displaying the last cue until a new one appears.
    By filling every gap with a ``########################`` cue the player
    shows that (effectively blank-looking) text instead of lingering on the
    previous subtitle.

    If *video_duration* is provided and the last subtitle ends before the video
    ends, a final hash cue is added from the last subtitle's end to the video
    end so the player does not freeze on the last real subtitle.
    """
    normalized = vtt_content.replace("\r\n", "\n").replace("\r", "\n").strip()
    blocks = [b.strip() for b in normalized.split("\n\n") if b.strip()]

    # Extract subtitle cues
    cues: list[dict] = []
    for block in blocks:
        lines = block.split("\n")
        if not lines:
            continue
        if lines[0].strip().upper().startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            continue

        timestamp_line = ""
        text_lines: list[str] = []
        for line in lines:
            if "-->" in line:
                timestamp_line = line
            elif line.strip():
                text_lines.append(line)

        if not timestamp_line or not text_lines:
            continue

        try:
            start_raw, end_raw = timestamp_line.split("-->", 1)
            start_raw = re.sub(r"^\d+\s+", "", start_raw.strip())
            end_raw = re.sub(r"\s+\d+$", "", end_raw.strip())

            # Drop leading cue-number line
            filtered = []
            for j, tl in enumerate(text_lines):
                if j == 0 and re.match(r"^\d+$", tl.strip()):
                    continue
                filtered.append(tl)

            cues.append({
                "start": start_raw,
                "end": end_raw,
                "text": "\n".join(filtered),
            })
        except ValueError:
            continue

    if not cues:
        return vtt_content  # nothing to process, return as-is

    # Rebuild VTT with separator cues in gaps
    out = "WEBVTT\n\n"
    cue_num = 1
    for i, cue in enumerate(cues):
        out += f"{cue_num}\n{cue['start']} --> {cue['end']}\n{cue['text']}\n\n"
        cue_num += 1

        if i < len(cues) - 1:
            try:
                end_sec = _parse_vtt_time_to_seconds(cue["end"])
                next_sec = _parse_vtt_time_to_seconds(cues[i + 1]["start"])
                if end_sec < next_sec:
                    out += f"{cue_num}\n{cue['end']} --> {cues[i + 1]['start']}\n########################\n\n"
                    cue_num += 1
            except (ValueError, IndexError):
                pass

    # Trailing hash cue: last subtitle end → video end
    if video_duration > 0 and cues:
        try:
            last_end_sec = _parse_vtt_time_to_seconds(cues[-1]["end"])
            if last_end_sec < video_duration:
                out += f"{cue_num}\n{cues[-1]['end']} --> {_seconds_to_vtt_time(video_duration)}\n########################\n\n"
        except (ValueError, IndexError):
            pass

    return out.strip()


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


_TRAILER_ID_RE = re.compile(r"^trailer_([a-f0-9]{24})_(.+)$")


def _get_episode_meta(db, episode_id):
    """Fetch item metadata from showcache. Supports episodes and trailers.

    For trailers the episode_id has form `trailer_<showObjectId>_<_key>`; we look
    up showcache.trailers_playback_urls by _key. Trailers have no episode_number
    or slug of their own so we substitute the _key for stable output file names.
    """
    master_db = db.client["master"]

    trailer_match = _TRAILER_ID_RE.match(episode_id)
    if trailer_match:
        from bson import ObjectId as _ObjectId
        show_id_hex, trailer_key = trailer_match.group(1), trailer_match.group(2)
        show = master_db["showcache"].find_one(
            {"_id": _ObjectId(show_id_hex), "trailers_playback_urls._key": trailer_key},
            {"trailers_playback_urls.$": 1, "slug": 1},
        )
        if not show or not show.get("trailers_playback_urls"):
            raise ValueError(f"Trailer {episode_id} not found in showcache")
        trailer = show["trailers_playback_urls"][0]
        show_slug = show.get("slug", "unknown")
        duration = trailer.get("duration", 0)
        episode_slug = trailer_key
        episode_number = trailer_key
        episode_output_key = f"{show_slug}/trailer_{trailer_key}"
        return episode_slug, episode_output_key, show_slug, episode_number, duration

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
    duration = ep.get("duration", 0)
    return episode_slug, episode_output_key, show_slug, episode_number, duration


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
    """Download VTT content from a public S3/HTTP URL.

    Always decodes ``response.content`` as UTF-8 (never ``response.text``, which
    follows Content-Type charset and can mangle Telugu / smart quotes).
    """
    resp = requests.get(
        url,
        timeout=30,
        headers={"Accept": "text/vtt, text/*;q=0.9, */*;q=0.8"},
    )
    resp.raise_for_status()
    text = _decode_utf8_vtt_bytes(resp.content)
    return text


def _upload_subtitles_to_gcs(creds, cdn_prefix, vtt_urls, video_duration=0):
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
            _warn_if_missing_webvtt_header(vtt_content, lang_key)
            vtt_content = _inject_gap_separators(vtt_content, video_duration)
            utf8_bytes = len(vtt_content.encode("utf-8"))
            print(f"[SUBS] Downloaded {lang_key}: {utf8_bytes} UTF-8 bytes ({len(vtt_content)} chars)")

            vtt_blob = bucket.blob(f"{cdn_prefix}/{vtt_filename}")
            vtt_blob.cache_control = "no-store"
            # str → UTF-8 on upload; charset in Content-Type tells players/CDN the encoding
            vtt_blob.upload_from_string(vtt_content, content_type=CONTENT_TYPE_VTT)

            playlist_content = SUBTITLE_PLAYLIST_TEMPLATE.format(vtt_filename=vtt_filename)
            playlist_blob = bucket.blob(f"{cdn_prefix}/{playlist_filename}")
            playlist_blob.cache_control = "no-store"
            playlist_blob.upload_from_string(playlist_content, content_type=CONTENT_TYPE_M3U8)

            uploaded.append((lang_code, display_name, playlist_filename))
            print(f"[SUBS] Uploaded {vtt_filename} + {playlist_filename}")
        except Exception as e:
            print(f"[SUBS] Failed to process {lang_key}: {e}")

    return uploaded


def _patch_master_manifest(creds, cdn_prefix, manifest_name, subtitle_tracks):
    """Download master .m3u8 as UTF-8, inject subtitle entries, re-upload with charset=utf-8."""
    if not subtitle_tracks:
        return

    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{cdn_prefix}/{manifest_name}")

    if not blob.exists():
        print(f"[PATCH] Skipping {manifest_name} — does not exist")
        return

    original = blob.download_as_text(encoding="utf-8")
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
    blob.cache_control = "no-store"
    blob.upload_from_string(patched_text, content_type=CONTENT_TYPE_M3U8)
    print(f"[PATCH] Patched {manifest_name} with {len(subtitle_tracks)} subtitle tracks")


# ---------------------------------------------------------------------------
# Clear codec-specific CDN files + copy transcoder output
# ---------------------------------------------------------------------------

def _build_name_map(slug_prefix, codec):
    """Map original GCP Transcoder output filenames to slug-prefixed names."""
    name_map = {
        f"{codec}_master.m3u8": f"{slug_prefix}_{codec}.m3u8",
        f"mux_{codec}_audio.m3u8": f"{slug_prefix}_{codec}_audio.m3u8",
    }
    for res in ["720p", "480p", "1080p"]:
        name_map[f"mux_{res}_{codec}_video.m3u8"] = f"{slug_prefix}_{res}_{codec}_video.m3u8"
    return name_map


def _copy_to_cdn_bucket(creds, source_bucket_name, episode_id, cdn_prefix, codec, name_map):
    """Copy codec-specific transcoder output into CDN folder, renaming manifests."""
    client = gcs.Client(credentials=creds)
    src_bucket = client.bucket(source_bucket_name)
    dst_bucket = client.bucket(CDN_BUCKET)

    prefix = f"{episode_id}/"
    print(f"[COPY] Listing objects in gs://{source_bucket_name}/{prefix}")

    copied = 0
    for blob in src_bucket.list_blobs(prefix=prefix):
        if codec not in blob.name:
            continue
        basename = os.path.basename(blob.name)
        dst_basename = name_map.get(basename, basename)
        dst_name = f"{cdn_prefix}/{dst_basename}"
        dst_blob = src_bucket.copy_blob(blob, dst_bucket, new_name=dst_name)
        dst_blob.reload()
        if dst_blob.size != blob.size:
            raise RuntimeError(
                f"Partial copy: {blob.name} expected {blob.size} bytes, got {dst_blob.size}"
            )
        if dst_name.endswith(".m3u8"):
            dst_blob.cache_control = "no-store"
        else:
            dst_blob.cache_control = "public, max-age=31536000"
        dst_blob.patch()
        copied += 1

    print(f"[COPY] Copied {copied} {codec} objects to gs://{CDN_BUCKET}/{cdn_prefix}/")


def _correct_init_byterange(creds, cdn_prefix, name_map):
    """
    GCP Transcoder sometimes declares EXT-X-MAP BYTERANGE 1 byte beyond the true
    ftyp+moov boundary, causing the player to read 1 byte into the mdat box.
    For each sub-manifest, read the actual MP4 box sizes from the .m4s file and
    patch BYTERANGE if it is off.
    """
    import struct
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)

    sub_manifests = [v for k, v in name_map.items() if k.endswith(".m3u8") and "master" not in k]

    for manifest_name in sub_manifests:
        blob = bucket.blob(f"{cdn_prefix}/{manifest_name}")
        if not blob.exists():
            continue
        text = blob.download_as_text(encoding="utf-8")
        m = re.search(r'#EXT-X-MAP:URI="([^"]+)",BYTERANGE="(\d+)@0"', text)
        if not m:
            continue
        m4s_name = m.group(1)
        declared_size = int(m.group(2))

        # Read first 16 bytes of .m4s to parse ftyp and moov box sizes
        m4s_blob = bucket.blob(f"{cdn_prefix}/{m4s_name}")
        if not m4s_blob.exists():
            continue
        header = m4s_blob.download_as_bytes(start=0, end=15)

        ftyp_size = struct.unpack(">I", header[0:4])[0]
        if ftyp_size + 8 > len(header):
            # Need more bytes to reach moov size field
            header = m4s_blob.download_as_bytes(start=0, end=ftyp_size + 7)
        moov_size = struct.unpack(">I", header[ftyp_size:ftyp_size + 4])[0]
        correct_size = ftyp_size + moov_size

        if declared_size != correct_size:
            patched = text.replace(
                f'BYTERANGE="{declared_size}@0"',
                f'BYTERANGE="{correct_size}@0"',
                1,
            )
            blob.cache_control = "no-store"
            blob.upload_from_string(patched, content_type=CONTENT_TYPE_M3U8)
            print(f"[BYTERANGE] Fixed {manifest_name}: {declared_size} → {correct_size}")
        else:
            print(f"[BYTERANGE] {manifest_name}: {declared_size} correct")


def _rename_manifest_refs(creds, cdn_prefix, master_name, name_map):
    """Replace old sub-manifest filenames inside the master with new slug-prefixed names."""
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{cdn_prefix}/{master_name}")
    if not blob.exists():
        return
    text = blob.download_as_text(encoding="utf-8")
    for old_name, new_name in name_map.items():
        if old_name != master_name:
            text = text.replace(old_name, new_name)
    blob.cache_control = "no-store"
    blob.upload_from_string(text, content_type=CONTENT_TYPE_M3U8)
    print(f"[RENAME] Updated sub-manifest refs in {master_name}")


_RESOLUTION_ORDER = {"720p": 0, "480p": 1, "1080p": 2}

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


def _reorder_streams_in_manifest(creds, cdn_prefix, manifest_name):
    """Download manifest, reorder #EXT-X-STREAM-INF blocks to 720p→480p→1080p, re-upload."""
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{cdn_prefix}/{manifest_name}")
    if not blob.exists():
        print(f"[REORDER] {manifest_name} not found, skipping")
        return

    text = blob.download_as_text(encoding="utf-8")
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

    blob.cache_control = "no-store"
    blob.upload_from_string("\n".join(reordered) + "\n", content_type=CONTENT_TYPE_M3U8)
    print(f"[REORDER] Reordered streams in {manifest_name} to 720p→480p→1080p")


def _fix_audio_name(creds, cdn_prefix, slug, manifest_name):
    """Replace placeholder audio NAME in the codec's master manifest."""
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(CDN_BUCKET)
    blob = bucket.blob(f"{cdn_prefix}/{manifest_name}")
    if not blob.exists():
        return
    text = blob.download_as_text(encoding="utf-8")
    patched = text.replace('NAME="Test Language"', f'NAME="{slug}"')
    if patched != text:
        blob.cache_control = "no-store"
        blob.upload_from_string(patched, content_type=CONTENT_TYPE_M3U8)
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

    mongo_client = pymongo.MongoClient(mongo_uri)
    db = mongo_client["chai_q_lab"]

    _now = datetime.now(timezone.utc)
    folder_ts = _now.strftime("%d%m%Y_%H%M%S")
    cdn_prefix = f"{episode_id}/{folder_ts}"
    now_iso = _now.isoformat()

    episode_slug, _, show_slug, episode_number, video_duration = _get_episode_meta(db, episode_id)

    trailer_match = _TRAILER_ID_RE.match(episode_id)
    if trailer_match:
        trailer_key = trailer_match.group(2)
        slug_prefix = f"{show_slug}_trailer_{trailer_key}_{folder_ts}"
    else:
        slug_prefix = f"{show_slug}_ep_{episode_number}_{folder_ts}"
    name_map = _build_name_map(slug_prefix, codec)
    master_filename = name_map[f"{codec}_master.m3u8"]

    creds = _get_gcp_credentials()
    _copy_to_cdn_bucket(creds, gcs_output_bucket, episode_id, cdn_prefix, codec, name_map)
    _correct_init_byterange(creds, cdn_prefix, name_map)
    _rename_manifest_refs(creds, cdn_prefix, master_filename, name_map)
    _fix_audio_name(creds, cdn_prefix, episode_slug, master_filename)
    _reorder_streams_in_manifest(creds, cdn_prefix, master_filename)

    # --- Subtitle pipeline (only for this codec's manifest) ---
    vtt_urls = _get_subtitle_vtt_urls(episode_id)
    subtitle_tracks = []
    if vtt_urls:
        try:
            subtitle_tracks = _upload_subtitles_to_gcs(creds, cdn_prefix, vtt_urls, video_duration)
            _patch_master_manifest(creds, cdn_prefix, master_filename, subtitle_tracks)
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

    url_value = f"{CDN_BASE}/{cdn_prefix}/{master_filename}"

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

    mongo_client.close()

    print(f"[OK] Finalized HLS for {episode_id} (codec={codec})")
    print(f"  {codec.upper()}: {url_value}")
    print(f"  Subtitles: {len(subtitle_tracks)} tracks")

    return {
        "episode_id": episode_id,
        "h264_master_m3u8_url": h264_url,
        "h265_master_m3u8_url": h265_url,
    }
