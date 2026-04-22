"""
Generate WebP sprite + WEBVTT from a remote video URL (e.g. S3 HTTPS), upload to GCS, update Mongo.
"""
from __future__ import annotations

import json
import math
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from google.cloud import storage as gcs_storage
from pymongo import MongoClient


def video_id_from_s3_url(s3_url: str) -> str:
    base = s3_url.rstrip("/").split("/")[-1]
    return base.rsplit(".", 1)[0] if "." in base else base


def _normalize_url(url: str) -> str:
    url = url.strip()
    if url.startswith("https:/") and not url.startswith("https://"):
        url = "https://" + url[7:]
    elif url.startswith("http:/") and not url.startswith("http://"):
        url = "http://" + url[6:]
    return url


def _ffprobe_duration_sec(url: str) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        url,
    ]
    out = subprocess.check_output(cmd, text=True)
    data = json.loads(out)
    d = float(data.get("format", {}).get("duration") or 0)
    return max(d, 0.1)


def _run_ffmpeg(args: List[str]) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def generate_webp_vtt_to_dir(
    s3_url: str,
    out_dir: Path,
    video_id: str,
    *,
    duration_sec: float,
    quality: int = 65,
    interval_sec: float = 3.0,
    sprite_base_url: str,
) -> Tuple[Path, Path]:
    """
    Stream from URL, generate 5x5 sprite sheets and a single VTT covering the full video.
    Filenames use the stable pattern (video_id is already unique from S3 source naming):
      {video_id}-sprite-0.webp, {video_id}-sprite-1.webp, ...
      {video_id}-thumbnails.vtt
    Cache-staleness is handled at upload time via Cache-Control on the blobs.
    """
    url = _normalize_url(s3_url)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if duration_sec <= 0:
        duration_sec = _ffprobe_duration_sec(url)

    # Fixed 5x5 grid per sprite sheet
    cols = 5
    rows = 5
    frames_per_sheet = cols * rows  # 25

    # Total frames needed to cover the full video
    # Frames at interval_sec, 2*interval_sec, ... (first frame at interval_sec, not 0)
    available = max(0, duration_sec - interval_sec)
    total_frames = max(1, int(available / interval_sec) + 1)
    num_sheets = math.ceil(total_frames / frames_per_sheet)

    q = min(100, max(0, int(quality or 65)))
    sprite_paths: List[Path] = []

    # Cell dimensions (determined from first sheet, reused for all)
    cell_w = 0
    cell_h = 0

    for sheet_idx in range(num_sheets):
        frame_offset = sheet_idx * frames_per_sheet
        sheet_frames = min(frames_per_sheet, total_frames - frame_offset)
        # Time offset for this sheet's first frame
        trim_start = interval_sec + frame_offset * interval_sec

        sprite_path = out_dir / f"{video_id}-sprite-{sheet_idx}.webp"
        sprite_paths.append(sprite_path)

        vf = (
            f"trim=start={trim_start},setpts=PTS-STARTPTS,"
            f"fps=1/{interval_sec}:round=up,trim=end_frame={sheet_frames},"
            f"scale=120:-1,tile={cols}x{rows}"
        )
        _run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-i",
                url,
                "-vf",
                vf,
                "-frames:v",
                "1",
                "-c:v",
                "libwebp",
                "-q:v",
                str(q),
                str(sprite_path),
            ]
        )

        # Get cell dimensions from the first sheet
        if sheet_idx == 0:
            probe = subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=width,height",
                    "-of",
                    "json",
                    str(sprite_path),
                ],
                text=True,
            )
            pinfo = json.loads(probe)
            streams = pinfo.get("streams") or [{}]
            sw = int(streams[0].get("width") or (120 * cols))
            sh = int(streams[0].get("height") or 1)
            cell_w = max(sw // cols, 1)
            cell_h = max(sh // rows, 1)

    # Build single VTT referencing all sheets
    def fmt_ts(ts: float) -> str:
        hh = int(ts // 3600)
        mm = int((ts % 3600) // 60)
        ss = ts % 60
        return f"{hh:02d}:{mm:02d}:{ss:06.3f}"

    vtt_path = out_dir / f"{video_id}-thumbnails.vtt"
    lines = ["WEBVTT", ""]
    for i in range(total_frames):
        sheet_idx = i // frames_per_sheet
        pos_in_sheet = i % frames_per_sheet
        r = pos_in_sheet // cols
        c = pos_in_sheet % cols
        x0 = c * cell_w
        y0 = r * cell_h
        t0 = i * interval_sec
        t1 = (i + 1) * interval_sec if i < total_frames - 1 else max(duration_sec, t0 + 0.001)
        sprite_file = f"{video_id}-sprite-{sheet_idx}.webp"
        frag = f"{sprite_base_url.rstrip('/')}/{sprite_file}#xywh={x0},{y0},{cell_w},{cell_h}"
        lines.append(str(i + 1))
        lines.append(f"{fmt_ts(t0)} --> {fmt_ts(t1)}")
        lines.append(frag)
        lines.append("")

    vtt_path.write_text("\n".join(lines), encoding="utf-8")
    return sprite_paths[0], vtt_path


def list_existing_sprite_blob_names(
    *,
    bucket_name: str,
    prefix: str,
    video_id: str,
) -> List[str]:
    """Return GCS blob names for existing sprite/VTT objects of this video_id, so we can
    safely delete them AFTER the new generation + Mongo write succeeds (no data loss on failure)."""
    client = gcs_storage.Client()
    base = prefix.rstrip("/") + "/"
    names: List[str] = []
    for pat in (f"{base}{video_id}-sprite", f"{base}{video_id}-thumbnails"):
        for blob in client.list_blobs(bucket_name.rstrip("/"), prefix=pat):
            names.append(blob.name)
    return names


def delete_blobs_by_name(
    *,
    bucket_name: str,
    names: List[str],
) -> int:
    """Delete GCS blobs by exact name. Returns count successfully deleted."""
    if not names:
        return 0
    client = gcs_storage.Client()
    bucket = client.bucket(bucket_name.rstrip("/"))
    deleted = 0
    for name in names:
        try:
            bucket.blob(name).delete()
            deleted += 1
        except Exception:
            pass
    return deleted


def upload_and_make_public(
    out_dir: Path,
    *,
    bucket_name: str,
    prefix: str,
) -> List[Tuple[str, str]]:
    """Upload all files in out_dir to GCS; return [(filename, public_url), ...].

    Sets `Cache-Control: no-cache, max-age=0` so clients always revalidate with GCS
    before reusing cached bytes — since filenames are stable across reruns, the URL
    itself doesn't change, and we rely on ETag revalidation to deliver fresh content.
    """
    client = gcs_storage.Client()
    bucket = client.bucket(bucket_name.rstrip("/"))
    base = prefix.rstrip("/") + "/"
    uploaded: List[Tuple[str, str]] = []
    for p in sorted(out_dir.iterdir()):
        if not p.is_file():
            continue
        blob_name = base + p.name
        blob = bucket.blob(blob_name)
        blob.cache_control = "no-cache, max-age=0"
        blob.upload_from_filename(str(p))
        try:
            blob.make_public()
        except Exception:
            pass
        url = f"https://storage.googleapis.com/{bucket_name.rstrip('/')}/{blob_name}"
        uploaded.append((p.name, url))
    return uploaded


def process_one_episode(
    *,
    mongo_uri: str,
    database: str,
    episode_collection: str,
    vtt_collection: str,
    showcache_collection: str,
    bucket_name: str,
    gcs_prefix: str,
    episode_id: str,
    s3_url: str,
    video_id: str,
    duration_sec: float,
    show_id: Any,
    episode_mongo_id: Any,
    quality: int = 65,
    interval_sec: float = 3.0,
) -> Dict[str, Any]:
    sprite_base_url = f"https://storage.googleapis.com/{bucket_name.rstrip('/')}/{gcs_prefix.rstrip('/')}"

    # Snapshot existing stable-named blobs so we can clean up pre-`c9ace3b` orphans
    # (`{video_id}-sprite.webp` with no sheet index) and any sheets beyond the new
    # regeneration's sheet count. Uploading over identical names is an overwrite, so
    # only files whose names we *don't* regenerate need deletion.
    try:
        stale_blob_names = list_existing_sprite_blob_names(
            bucket_name=bucket_name, prefix=gcs_prefix, video_id=video_id
        )
    except Exception as e:
        print(f"[vtt-worker] stale-blob listing failed (continuing): {e}")
        stale_blob_names = []

    with tempfile.TemporaryDirectory(prefix="webp_vtt_") as tmp:
        out_dir = Path(tmp)
        generate_webp_vtt_to_dir(
            s3_url,
            out_dir,
            video_id,
            duration_sec=duration_sec,
            quality=quality,
            interval_sec=interval_sec,
            sprite_base_url=sprite_base_url,
        )
        uploaded = upload_and_make_public(
            out_dir, bucket_name=bucket_name, prefix=gcs_prefix
        )

    uploaded_names = {name for name, _ in uploaded}
    vtt_url = None
    sprite_urls = []
    base_url = f"https://storage.googleapis.com/{bucket_name.rstrip('/')}/{gcs_prefix.rstrip('/')}"
    for name, url in uploaded:
        if name.endswith(".vtt"):
            vtt_url = url
        if name.endswith(".webp"):
            sprite_urls.append(url)
    if not vtt_url:
        vtt_url = f"{base_url}/{video_id}-thumbnails.vtt"
    if not sprite_urls:
        sprite_urls = [f"{base_url}/{video_id}-sprite-0.webp"]
    sprite_url = sprite_urls[0]

    now = datetime.now(tz=timezone.utc).isoformat()
    mc = MongoClient(mongo_uri)
    db = mc[database]
    db[vtt_collection].update_one(
        {"video_id": video_id},
        {
            "$set": {
                "video_id": video_id,
                "episode_id": episode_mongo_id,
                "show_id": show_id,
                "vtt_url": vtt_url,
                "sprite_url": sprite_url,
                "sprite_urls": sprite_urls,
                "duration_sec": float(duration_sec),
                "updated_at": now,
            }
        },
        upsert=True,
    )
    if episode_id:
        db[episode_collection].update_one(
            {"id": episode_id},
            {"$set": {"vtt_url": vtt_url}},
        )
        db[showcache_collection].update_one(
            {"episodes.id": episode_id},
            {"$set": {"episodes.$.vtt_url": vtt_url}},
        )

    # Post-success cleanup: drop any stale blob whose name wasn't overwritten by this
    # run. With stable filenames, most blobs are overwrites, so we only delete the
    # diff — e.g. old single-sheet `sprite.webp` or extra sheets left from a longer
    # previous generation that the new (shorter) run didn't cover.
    base = gcs_prefix.rstrip("/") + "/"
    uploaded_blob_names = {base + n for n in uploaded_names}
    orphan_names = [n for n in stale_blob_names if n not in uploaded_blob_names]
    try:
        delete_blobs_by_name(bucket_name=bucket_name, names=orphan_names)
    except Exception as e:
        print(f"[vtt-worker] orphan cleanup failed (harmless, extra files remain): {e}")

    return {"vtt_url": vtt_url, "sprite_url": sprite_url, "ok": True}
