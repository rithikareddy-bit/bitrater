"""
Cloud Run / local HTTP entrypoint for single-episode WebP + VTT generation.

GCS: only thumbnail sprite + VTT objects (output/webp/…). Not used for HLS/transcoder
input/output buckets (those stay chai-q-transcoder-* / Terraform).

Env: prefer VTT_* in .env.deploy alongside MONGO_URI so sprite GCS + SA JSON never
clobber transcoder GOOGLE_APPLICATION_CREDENTIALS / GCS_* used by other tools.
"""
import os
import sys
from typing import Optional

from flask import Flask, jsonify, request

from sprite_pipeline import process_one_episode, video_id_from_s3_url

DEFAULT_VTT_SPRITES_GCS_BUCKET = "media-cdn-poc-466009-sprites"
DEFAULT_VTT_GCS_PREFIX = "output/webp/"

# Prefer VTT-specific SA JSON locally so one .env.deploy can list both transcoder and VTT keys.
_vtt_gac = os.environ.get("VTT_GOOGLE_APPLICATION_CREDENTIALS")
if _vtt_gac:
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = _vtt_gac

app = Flask(__name__)


def _vtt_gcs_bucket() -> str:
    return (
        os.environ.get("VTT_GCS_BUCKET")
        or os.environ.get("GCS_BUCKET")
        or DEFAULT_VTT_SPRITES_GCS_BUCKET
    ).replace("gs://", "").rstrip("/")


def _vtt_gcs_prefix() -> str:
    return os.environ.get("VTT_GCS_PREFIX") or os.environ.get("GCS_PREFIX") or DEFAULT_VTT_GCS_PREFIX


def _mongo_uri() -> Optional[str]:
    return os.environ.get("VTT_MONGO_URI") or os.environ.get("MONGO_URI")


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.post("/process")
def process():
    expected = os.environ.get("VTT_WORKER_SECRET")
    if expected:
        got = request.headers.get("X-VTT-Worker-Secret")
        if got != expected:
            return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    episode_id = data.get("episode_id")
    s3_url = data.get("s3_url")
    if not episode_id or not s3_url:
        return jsonify({"error": "episode_id and s3_url are required"}), 400

    video_id = data.get("video_id") or video_id_from_s3_url(s3_url)
    duration_sec = float(data.get("duration_sec") or 0)
    show_id = data.get("show_id")
    episode_mongo_id = data.get("episode_mongo_id", episode_id)

    mongo_uri = _mongo_uri()
    if not mongo_uri:
        return jsonify({"error": "MONGO_URI or VTT_MONGO_URI not set on worker"}), 500

    database = os.environ.get("MONGO_DATABASE", "master")
    episode_collection = os.environ.get("MONGO_EPISODE_COLLECTION", "episode")
    vtt_collection = os.environ.get("MONGO_VTT_COLLECTION", "episode_vtt")
    showcache_collection = os.environ.get("MONGO_SHOWCACHE_COLLECTION", "showcache")
    bucket_name = _vtt_gcs_bucket()
    gcs_prefix = _vtt_gcs_prefix()

    quality = int(os.environ.get("WEBP_QUALITY", "65"))
    interval_sec = float(os.environ.get("THUMB_INTERVAL_SEC", "3"))

    try:
        result = process_one_episode(
            mongo_uri=mongo_uri,
            database=database,
            episode_collection=episode_collection,
            vtt_collection=vtt_collection,
            showcache_collection=showcache_collection,
            bucket_name=bucket_name,
            gcs_prefix=gcs_prefix,
            episode_id=episode_id,
            s3_url=s3_url,
            video_id=video_id,
            duration_sec=duration_sec,
            show_id=show_id,
            episode_mongo_id=episode_mongo_id,
            quality=quality,
            interval_sec=interval_sec,
        )
    except Exception as e:
        print(f"[vtt-worker] process_one_episode failed: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500

    return jsonify(
        {
            "ok": True,
            "vtt_url": result.get("vtt_url"),
            "sprite_url": result.get("sprite_url"),
            "message": "Thumbnail VTT generation complete",
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
