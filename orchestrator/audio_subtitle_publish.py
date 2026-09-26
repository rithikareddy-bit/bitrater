"""
Audio subtitle publishing: fetch VTTs from podcast_subtitles, upload to the
public audio bucket alongside the rendition files, and patch audio_master.m3u8
to advertise the subtitle tracks.

Mirrors the subtitle pipeline in gcp_finalize_hls.py (video) but:
  - Reads from db=gld2sqs, collection=podcast_subtitles (not `subtitles`)
  - Targets the public audio bucket (gs://${AUDIO_PUBLIC_BUCKET}/<episode_id>/)
  - Patches audio_master.m3u8 in-place

VTTs are read as raw bytes and strictly decoded as UTF-8 (W3C WebVTT spec) so
Telugu/Kannada/etc. cue text isn't mangled by HTTP charset guessing. GCS objects
are uploaded with explicit `charset=utf-8` Content-Type for the same reason.

Best-effort by design: any failure here is caught by the caller and surfaced as
`subtitle_publish_error` on the audio_episodes row — the transcode itself stays
SUCCEEDED so the audio URL is still usable without subtitles.
"""

import os

import pymongo
import requests
from google.cloud import storage as gcs

from lang_codes import LANG_CODE_NAMES, ROMANIZED_DISPLAY_NAMES, normalize_lang_code
import runtime_config


CONTENT_TYPE_VTT = "text/vtt; charset=utf-8"
CONTENT_TYPE_M3U8 = "application/x-mpegURL; charset=utf-8"

SUBTITLE_PLAYLIST_TEMPLATE = """\
#EXTM3U
#EXT-X-TARGETDURATION:86400
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:86400.0,
{vtt_filename}
#EXT-X-ENDLIST
"""


def _build_subtitle_langs(source_language: str) -> dict:
    """Per-episode mapping from VTT field name → (LANGUAGE code, display NAME).
    Same scheme as the video pipeline so the front-end's per-show language
    config keeps working: english→`en-<showcode>`, native→`<showcode>`,
    romanized→`<romanized_name>` (e.g. kanglish, tinglish).
    """
    code = normalize_lang_code(source_language)
    native_name = LANG_CODE_NAMES.get(code, code.title() if code != "xx" else "Native")
    rom_name = ROMANIZED_DISPLAY_NAMES.get(code, f"{native_name} (Latin)")
    rom_code = rom_name.lower() if code in ROMANIZED_DISPLAY_NAMES else f"{code}-latn"
    english_code = f"en-{code}" if code not in ("xx", "en") else "en"
    return {
        "english_translation_final": (english_code, "English"),
        "native_script_final":       (code, native_name),
        "reviewed_romanized":        (rom_code, rom_name),
    }


def _decode_utf8_vtt_bytes(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        head = raw[: min(160, len(raw))]
        print(
            "[SUBS][AUDIO] VTT decode failed: file is not valid UTF-8. "
            "Re-export the source .vtt as UTF-8 (no Windows-1252 / Latin-1). "
            f"First {len(head)} bytes (hex): {head.hex()}"
        )
        raise


def _warn_if_missing_webvtt_header(text: str, lang_key: str) -> None:
    sample = text.lstrip("﻿").strip()
    first_line = sample.split("\n", 1)[0] if sample else ""
    if not first_line.upper().startswith("WEBVTT"):
        print(
            f"[SUBS][AUDIO] Warning ({lang_key}): expected WEBVTT header; "
            f"first line was {first_line[:120]!r}"
        )


def _get_subtitle_vtt_urls(episode_id: str):
    """Return ({vtt_field: url}, source_language) for the episode, from
    podcast_subtitles. Returns ({}, "") if SUBTITLE_MONGO_URI isn't configured
    or no record exists — caller treats that as "no subtitles, skip silently."
    """
    subtitle_uri = os.environ.get("SUBTITLE_MONGO_URI")
    if not subtitle_uri:
        print("[SUBS][AUDIO] SUBTITLE_MONGO_URI not configured, skipping subtitles")
        return {}, ""

    client = pymongo.MongoClient(subtitle_uri)
    try:
        doc = client[runtime_config.DB_SUBTITLES]["podcast_subtitles"].find_one(
            {"episodes.episode_id": episode_id},
            {"episodes.$": 1, "source_language": 1},
        )
        if not doc or not doc.get("episodes"):
            print(f"[SUBS][AUDIO] No subtitle record for episode {episode_id}")
            return {}, ""

        source_language = doc.get("source_language") or ""
        vtt_files = doc["episodes"][0].get("vtt_files", {}) or {}
        result = {
            k: v for k, v in vtt_files.items()
            if k in ("english_translation_final", "native_script_final", "reviewed_romanized") and v
        }
        for k in ("english_translation_final", "native_script_final", "reviewed_romanized"):
            if k not in result:
                print(f"[SUBS][AUDIO] Missing {k} VTT for episode {episode_id}")
        print(f"[SUBS][AUDIO] Found {len(result)} subtitle URL(s) for {episode_id} "
              f"(source_language={source_language!r})")
        return result, source_language
    finally:
        client.close()


def _download_vtt(url: str) -> str:
    resp = requests.get(
        url,
        timeout=30,
        headers={"Accept": "text/vtt, text/*;q=0.9, */*;q=0.8"},
    )
    resp.raise_for_status()
    return _decode_utf8_vtt_bytes(resp.content)


def _upload_subtitles(creds, public_bucket_name: str, episode_id: str,
                      vtt_urls: dict, subtitle_langs: dict):
    """Download each VTT, upload it + a single-segment .m3u8 playlist to the
    public bucket under <episode_id>/. Iterates in canonical order
    (english → native → romanized) so DEFAULT=YES lands on English deterministically.
    Returns list of (lang_code, display_name, playlist_filename).
    """
    client = gcs.Client(credentials=creds)
    bucket = client.bucket(public_bucket_name)
    uploaded = []

    for lang_key, (lang_code, display_name) in subtitle_langs.items():
        url = vtt_urls.get(lang_key)
        if not url:
            continue
        vtt_filename = f"subtitle_{lang_code}.vtt"
        playlist_filename = f"subtitle_{lang_code}.m3u8"
        try:
            vtt_content = _download_vtt(url)
            _warn_if_missing_webvtt_header(vtt_content, lang_key)
            utf8_bytes = len(vtt_content.encode("utf-8"))
            print(f"[SUBS][AUDIO] Downloaded {lang_key}: {utf8_bytes} UTF-8 bytes")

            vtt_blob = bucket.blob(f"{episode_id}/{vtt_filename}")
            vtt_blob.cache_control = "public, max-age=2592000"
            vtt_blob.upload_from_string(vtt_content, content_type=CONTENT_TYPE_VTT)

            playlist_blob = bucket.blob(f"{episode_id}/{playlist_filename}")
            playlist_blob.cache_control = "public, max-age=2592000"
            playlist_blob.upload_from_string(
                SUBTITLE_PLAYLIST_TEMPLATE.format(vtt_filename=vtt_filename),
                content_type=CONTENT_TYPE_M3U8,
            )

            uploaded.append((lang_code, display_name, playlist_filename))
            print(f"[SUBS][AUDIO] Uploaded {vtt_filename} + {playlist_filename}")
        except Exception as e:
            # One bad track shouldn't drop the others — log and continue.
            print(f"[SUBS][AUDIO] Failed to process {lang_key}: {e}")

    return uploaded


def _patch_audio_master(creds, public_bucket_name: str, episode_id: str,
                       subtitle_tracks: list) -> None:
    """Inject #EXT-X-MEDIA:TYPE=SUBTITLES entries into audio_master.m3u8 and
    add SUBTITLES="subtitles" to every #EXT-X-STREAM-INF line. Re-uploads with
    explicit UTF-8 Content-Type."""
    if not subtitle_tracks:
        return

    client = gcs.Client(credentials=creds)
    bucket = client.bucket(public_bucket_name)
    blob = bucket.blob(f"{episode_id}/audio_master.m3u8")

    if not blob.exists():
        print(f"[SUBS][AUDIO] audio_master.m3u8 missing for {episode_id}; skipping patch")
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
    saw_stream_inf = False
    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF"):
            saw_stream_inf = True
            if not header_done:
                patched.extend(subtitle_lines)
                header_done = True
            if "SUBTITLES=" not in line:
                line = line.rstrip() + ',SUBTITLES="subtitles"'
            patched.append(line)
        else:
            patched.append(line)

    # Fallback: pure audio masters from some transcoder configs use only
    # #EXT-X-MEDIA:TYPE=AUDIO entries with no #EXT-X-STREAM-INF lines. In that
    # case insert subtitle MEDIA tags right after #EXTM3U so players still
    # discover them.
    if not saw_stream_inf:
        patched = []
        inserted = False
        for line in lines:
            patched.append(line)
            if not inserted and line.strip().upper().startswith("#EXTM3U"):
                patched.extend(subtitle_lines)
                inserted = True

    patched_text = "\n".join(patched) + "\n"
    blob.cache_control = "public, max-age=2592000"
    blob.upload_from_string(patched_text, content_type=CONTENT_TYPE_M3U8)
    print(f"[SUBS][AUDIO] Patched audio_master.m3u8 with {len(subtitle_tracks)} subtitle track(s)")


def publish_subtitles(creds, episode_id: str) -> dict:
    """Top-level entry point. Returns a dict suitable for $set on audio_episodes:
        - on success with tracks: {'subtitle_tracks': [...]}
        - on no-op (no record / no URI): {}
    Raises on hard failures (Mongo down, bucket auth, etc.) so the caller can
    record the message in `subtitle_publish_error`.
    """
    public_bucket = os.environ["AUDIO_PUBLIC_BUCKET"]

    vtt_urls, source_language = _get_subtitle_vtt_urls(episode_id)
    if not vtt_urls:
        return {}

    subtitle_langs = _build_subtitle_langs(source_language)
    uploaded = _upload_subtitles(creds, public_bucket, episode_id, vtt_urls, subtitle_langs)
    if not uploaded:
        return {}

    _patch_audio_master(creds, public_bucket, episode_id, uploaded)

    return {
        "subtitle_tracks": [
            {"lang": code, "name": name, "playlist": pl}
            for (code, name, pl) in uploaded
        ],
    }
