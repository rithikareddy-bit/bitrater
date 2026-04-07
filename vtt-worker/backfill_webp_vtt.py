"""
WebP VTT backfill: generate WebP sprites + VTT only for episodes that do NOT
already have a vtt_url in MongoDB (no episode_vtt document). Upload to GCS
output/webp/, make public, write vtt_url/sprite_url to Mongo (same places as
the Transcoder pipeline). Designed to run locally or on GCP Cloud Run Jobs.

- Skip logic: we skip an episode if episode_vtt already has a document for that
  video_id (i.e. vtt_url was already written by Transcoder or a previous run).
  We do not check whether the .vtt file exists at the URL.
- No input video in GCS: we stream from S3 URL directly to ffmpeg, so we never
  upload the video to GCS. There is nothing to delete (unlike the Transcoder
  pipeline, which uploads to input/ then optionally deletes). Temp WebP/VTT files
  are in a TemporaryDirectory and are removed automatically after upload.
"""

import argparse
import csv
import os
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sprite_pipeline import (
    generate_webp_vtt_to_dir,
    upload_and_make_public,
    video_id_from_s3_url,
    _normalize_url,
)

# Mongo defaults (match run_sprite_pipeline_from_mongo)
DEFAULT_MONGO_DATABASE = "master"
DEFAULT_MONGO_SHOWCACHE = "showcache"
DEFAULT_EPISODE_COLLECTION = "episode"
DEFAULT_VTT_COLLECTION = "episode_vtt"
DEFAULT_GCS_BUCKET = "media-cdn-poc-466009-sprites"
DEFAULT_GCS_PREFIX = "output/webp/"

LOG_FIELDS = ["show_name", "episode_number", "video_id", "status", "timestamp", "error"]
LOG_HEADER = ",".join(LOG_FIELDS)


def collect_episodes_from_mongo(
    mongo_uri: str,
    database: str,
    showcase_collection: str,
    vtt_collection: str,
    skip_existing: bool,
    limit: Optional[int],
) -> List[Dict[str, Any]]:
    """Query showcache for active docs, flatten episodes. Skip episodes that already have vtt."""
    try:
        from pymongo import MongoClient
    except ImportError:
        raise ImportError("Install pymongo: pip install pymongo")

    client = MongoClient(mongo_uri)
    try:
        db = client[database]
        showcache = db[showcase_collection]
        episode_vtt = db[vtt_collection]

        # Pre-fetch all existing video_ids in one query (avoids N+1 round-trips)
        existing_ids: set = set(episode_vtt.distinct("video_id")) if skip_existing else set()

        seen_video_ids: set = set()
        episodes: List[Dict[str, Any]] = []

        cursor = showcache.find({"active": True}).sort([("title", 1), ("_id", 1)])
        for doc in cursor:
            show_id = doc.get("_id")
            show_name = doc.get("title") or doc.get("slug") or str(show_id) or "unknown"
            show_episodes = sorted(
                doc.get("episodes", []),
                key=lambda e: (e.get("episode_number") is None, e.get("episode_number")),
            )
            for ep in show_episodes:
                s3_url = ep.get("s3_url")
                if not s3_url:
                    continue
                video_id = video_id_from_s3_url(s3_url)
                if video_id in seen_video_ids:
                    continue
                seen_video_ids.add(video_id)
                if video_id in existing_ids:
                    continue
                duration = ep.get("duration")
                if duration is None:
                    duration = 0.0
                episodes.append({
                    "s3_url": s3_url,
                    "duration": float(duration),
                    "episode_id": ep.get("id"),
                    "show_id": show_id,
                    "show_name": show_name,
                    "episode_number": ep.get("episode_number", ""),
                    "video_id": video_id,
                })
                if limit is not None and len(episodes) >= limit:
                    return episodes
    finally:
        client.close()

    return episodes


def write_log_row(
    log_path: str,
    log_lock: threading.Lock,
    row: Dict[str, str],
) -> None:
    with log_lock:
        with open(log_path, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=LOG_FIELDS, extrasaction="ignore")
            w.writerow(row)


def process_one_episode(
    episode: Dict[str, Any],
    bucket_name: str,
    gcs_prefix: str,
    mongo_uri: str,
    database: str,
    vtt_collection: str,
    episode_collection: str,
    showcache_collection: str,
    quality: int,
    interval_sec: float,
    log_path: str,
    log_lock: threading.Lock,
) -> Tuple[bool, str]:
    """Generate WebP + VTT for one episode, upload to GCS, write Mongo. Returns (success, error_msg)."""
    video_id = episode["video_id"]
    show_name = episode["show_name"]
    episode_number = episode["episode_number"]
    duration_sec = episode["duration"]
    s3_url = _normalize_url(episode["s3_url"])
    episode_id = episode["episode_id"]
    show_id = episode["show_id"]

    def log_status(status: str, error: str = "") -> None:
        write_log_row(
            log_path,
            log_lock,
            {
                "show_name": show_name,
                "episode_number": str(episode_number),
                "video_id": video_id,
                "status": status,
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                "error": error,
            },
        )

    def progress(msg: str) -> None:
        print(f"[{video_id}] {msg}", flush=True)

    try:
        if duration_sec == 0.0:
            progress("No duration in Mongo — will ffprobe from S3 URL.")

        progress("Generating WebP + VTT...")
        sprite_base_url = f"https://storage.googleapis.com/{bucket_name.rstrip('/')}/{gcs_prefix.rstrip('/')}"
        with tempfile.TemporaryDirectory(prefix="we_backfill_") as tmpdir:
            out_dir = Path(tmpdir)
            generate_webp_vtt_to_dir(
                s3_url,
                out_dir,
                video_id,
                duration_sec=duration_sec,
                quality=quality,
                interval_sec=interval_sec,
                sprite_base_url=sprite_base_url,
            )
            progress("Uploading to GCS...")
            uploaded = upload_and_make_public(
                out_dir,
                bucket_name=bucket_name,
                prefix=gcs_prefix,
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

        progress("Writing to Mongo...")
        try:
            from pymongo import MongoClient
        except ImportError:
            raise ImportError("pymongo required for Mongo write")

        client = MongoClient(mongo_uri)
        try:
            db = client[database]
            db[vtt_collection].update_one(
                {"video_id": video_id},
                {
                    "$set": {
                        "video_id": video_id,
                        "episode_id": episode_id,
                        "show_id": show_id,
                        "vtt_url": vtt_url,
                        "sprite_url": sprite_url,
                        "duration_sec": duration_sec,
                        "updated_at": datetime.now(tz=timezone.utc).isoformat(),
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
        finally:
            client.close()

        log_status("complete")
        progress("Complete.")
        return True, ""
    except Exception as e:
        err_msg = str(e)
        log_status("failed", err_msg)
        progress(f"Failed: {err_msg}")
        return False, err_msg


def main() -> None:
    parser = argparse.ArgumentParser(
        description="WebP VTT backfill: generate WebP + VTT for episodes that have no vtt_url yet.",
    )
    parser.add_argument(
        "--mongo-uri",
        default=os.environ.get("MONGO_URI"),
        help="MongoDB connection string (or set MONGO_URI).",
    )
    parser.add_argument(
        "--database",
        default=os.environ.get("MONGO_DATABASE", DEFAULT_MONGO_DATABASE),
        help=f"Mongo database (default: {DEFAULT_MONGO_DATABASE}).",
    )
    parser.add_argument(
        "--showcache",
        default=DEFAULT_MONGO_SHOWCACHE,
        help=f"Showcache collection (default: {DEFAULT_MONGO_SHOWCACHE}).",
    )
    parser.add_argument(
        "--episode-collection",
        default=os.environ.get("MONGO_EPISODE_COLLECTION", DEFAULT_EPISODE_COLLECTION),
        help=f"Episode collection (default: {DEFAULT_EPISODE_COLLECTION}).",
    )
    parser.add_argument(
        "--vtt-collection",
        default=os.environ.get("MONGO_VTT_COLLECTION", DEFAULT_VTT_COLLECTION),
        help=f"VTT metadata collection (default: {DEFAULT_VTT_COLLECTION}).",
    )
    parser.add_argument(
        "--gcs-bucket",
        # Read VTT_GCS_BUCKET first (matches vtt-worker), fall back to GCS_BUCKET
        default=os.environ.get("VTT_GCS_BUCKET") or os.environ.get("GCS_BUCKET", DEFAULT_GCS_BUCKET),
        help=f"GCS bucket (default: {DEFAULT_GCS_BUCKET}). Env: VTT_GCS_BUCKET or GCS_BUCKET.",
    )
    parser.add_argument(
        "--gcs-prefix",
        default=os.environ.get("VTT_GCS_PREFIX") or os.environ.get("GCS_PREFIX", DEFAULT_GCS_PREFIX),
        help=f"GCS prefix for WebP/VTT (default: {DEFAULT_GCS_PREFIX}). Env: VTT_GCS_PREFIX or GCS_PREFIX.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=int(os.environ.get("VTT_BACKFILL_WORKERS", "2")),
        help="Parallel workers (default: 2). Env: VTT_BACKFILL_WORKERS.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process at most N episodes this run.",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=int(os.environ.get("WEBP_QUALITY", "100")),
        help="WebP quality 0-100 (default: 100). Env: WEBP_QUALITY.",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("THUMB_INTERVAL_SEC", "3.0")),
        help="Seconds between thumbnails (default: 3.0). Env: THUMB_INTERVAL_SEC.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only list episodes that would be processed.",
    )
    parser.add_argument(
        "--log",
        default=None,
        help="Log CSV path (default: webp_backfill_YYYYMMDD_HHMMSS.log).",
    )
    args = parser.parse_args()

    if not args.mongo_uri:
        print("Error: --mongo-uri or MONGO_URI is required.", file=sys.stderr)
        sys.exit(1)

    episodes = collect_episodes_from_mongo(
        mongo_uri=args.mongo_uri,
        database=args.database,
        showcase_collection=args.showcache,
        vtt_collection=args.vtt_collection,
        skip_existing=True,
        limit=args.limit,
    )

    if not episodes:
        print("No episodes to process (all already have vtt_url).")
        return

    print(f"Found {len(episodes)} episode(s) without vtt_url.")

    if args.dry_run:
        for ep in episodes:
            print(
                f"  {ep['show_name']} ep={ep['episode_number']} video_id={ep['video_id']} "
                f"s3_url={ep['s3_url'][:60]}..."
            )
        return

    bucket_name = args.gcs_bucket.replace("gs://", "").rstrip("/")
    log_path = args.log
    if not log_path:
        log_path = f"webp_backfill_{datetime.now(tz=timezone.utc).strftime('%Y%m%d_%H%M%S')}.log"
    with open(log_path, "w", newline="", encoding="utf-8") as f:
        f.write(LOG_HEADER + "\n")
    log_lock = threading.Lock()
    print(f"Log file: {log_path}")

    failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                process_one_episode,
                episode=ep,
                bucket_name=bucket_name,
                gcs_prefix=args.gcs_prefix,
                mongo_uri=args.mongo_uri,
                database=args.database,
                vtt_collection=args.vtt_collection,
                episode_collection=args.episode_collection,
                showcache_collection=args.showcache,
                quality=args.quality,
                interval_sec=args.interval,
                log_path=log_path,
                log_lock=log_lock,
            ): ep
            for ep in episodes
        }
        for fut in as_completed(futures):
            ep = futures[fut]
            try:
                ok, err = fut.result()
                if not ok:
                    failed += 1
                    print(f"Failed {ep['video_id']}: {err}")
            except Exception as e:
                failed += 1
                print(f"Failed {ep['video_id']}: {e}")

    print(f"Done. Processed {len(episodes)}, failed {failed}.")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
