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
    quality: int = 100,
    interval_sec: float = 3.0,
    sprite_base_url: str,
) -> Tuple[Path, Path]:
    """
    Stream from URL, write {video_id}-sprite.webp and {video_id}-thumbnails.vtt under out_dir.
    """
    url = _normalize_url(s3_url)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if duration_sec <= 0:
        duration_sec = _ffprobe_duration_sec(url)

    total_frames = max(1, int(duration_sec / interval_sec))
    cols = min(5, max(1, int(math.ceil(math.sqrt(total_frames)))))
    rows = int(math.ceil(total_frames / cols))

    sprite_path = out_dir / f"{video_id}-sprite.webp"
    vtt_path = out_dir / f"{video_id}-thumbnails.vtt"

    vf = (
        f"trim=start={interval_sec},setpts=PTS-STARTPTS,"
        f"fps=1/{interval_sec},trim=end_frame={total_frames},"
        f"scale=320:-2,tile={cols}x{rows}"
    )
    q = min(100, max(0, int(quality)))
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
    sw = int(streams[0].get("width") or (320 * cols))
    sh = int(streams[0].get("height") or 1)
    cell_w = max(sw // cols, 1)
    cell_h = max(sh // rows, 1)

    def fmt_ts(ts: float) -> str:
        hh = int(ts // 3600)
        mm = int((ts % 3600) // 60)
        ss = ts % 60
        return f"{hh:02d}:{mm:02d}:{ss:06.3f}"

    lines = ["WEBVTT", ""]
    base_file = f"{video_id}-sprite.webp"
    for i in range(total_frames):
        r = i // cols
        c = i % cols
        x0 = c * cell_w
        y0 = r * cell_h
        t0 = i * interval_sec
        t1 = (i + 1) * interval_sec if i < total_frames - 1 else duration_sec
        frag = f"{sprite_base_url.rstrip('/')}/{base_file}#xywh={x0},{y0},{cell_w},{cell_h}"
        lines.append(f"{fmt_ts(t0)} --> {fmt_ts(t1)}")
        lines.append(frag)
        lines.append("")

    vtt_path.write_text("\n".join(lines), encoding="utf-8")
    return sprite_path, vtt_path


def upload_and_make_public(
    out_dir: Path,
    *,
    bucket_name: str,
    prefix: str,
) -> List[Tuple[str, str]]:
    """Upload all files in out_dir to GCS; return [(filename, public_url), ...]."""
    client = gcs_storage.Client()
    bucket = client.bucket(bucket_name.rstrip("/"))
    base = prefix.rstrip("/") + "/"
    uploaded: List[Tuple[str, str]] = []
    for p in sorted(out_dir.iterdir()):
        if not p.is_file():
            continue
        blob_name = base + p.name
        blob = bucket.blob(blob_name)
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
    quality: int = 100,
    interval_sec: float = 3.0,
) -> Dict[str, Any]:
    sprite_base_url = f"https://storage.googleapis.com/{bucket_name.rstrip('/')}/{gcs_prefix.rstrip('/')}"

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

    vtt_url = None
    sprite_url = None
    base_url = f"https://storage.googleapis.com/{bucket_name.rstrip('/')}/{gcs_prefix.rstrip('/')}"
    for name, url in uploaded:
        if name.endswith(".vtt"):
            vtt_url = url
        if name.endswith(".webp") and sprite_url is None:
            sprite_url = url
    if not vtt_url:
        vtt_url = f"{base_url}/{video_id}-thumbnails.vtt"
    if not sprite_url:
        sprite_url = f"{base_url}/{video_id}-sprite.webp"

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

    return {"vtt_url": vtt_url, "sprite_url": sprite_url, "ok": True}
