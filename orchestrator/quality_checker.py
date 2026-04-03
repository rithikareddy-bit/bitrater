"""
Quality Check Lambda: analyze encoded HLS video for visual artifacts.

Checks 1080p H265 and 1080p H264 streams from the combined manifest.

Checks performed per stream:
- Blocking artifacts (compression macroblocking)
- Blur (soft/degraded frames)
- Frozen frames (stuck/repeated content)
- Black frames (corrupt or dropped content)

Input event:
  { "episode_id": "...", "combined_url": "https://cdn.../combined.m3u8" }
"""

import os
import re
import json
import subprocess
import urllib.request
import pymongo
from datetime import datetime, timezone

FFMPEG  = os.environ.get("FFMPEG_PATH",  "/opt/bin/ffmpeg")
FFPROBE = os.environ.get("FFPROBE_PATH", "/opt/bin/ffprobe")

BLOCK_THRESHOLD = 0.02
BLUR_THRESHOLD  = 0.8


def _fetch_manifest(url):
    """Download a manifest text from a CDN URL."""
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8")


def _extract_1080p_streams(combined_url):
    """
    Parse combined manifest and return (h265_url, h264_url) for 1080p streams.
    Identified by RESOLUTION=1080x1920 and CODECS attribute.
    """
    text = _fetch_manifest(combined_url)
    lines = text.strip().split("\n")
    h265_url = None
    h264_url = None
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF") and "1080x1920" in line:
            uri = lines[i + 1] if i + 1 < len(lines) else ""
            if not uri or uri.startswith("#"):
                continue
            if "hvc1" in line or "hev1" in line or "h265" in uri:
                h265_url = uri
            elif "avc1" in line or "h264" in uri:
                h264_url = uri
    return h265_url, h264_url


def _download_stream(stream_url, out_path):
    """Download an HLS sub-manifest stream to an mp4 file."""
    subprocess.run(
        [FFMPEG, "-y", "-i", stream_url, "-c", "copy", "-t", "300", out_path],
        check=True, capture_output=True,
    )


def _get_duration(path):
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "json", path],
        capture_output=True, text=True, check=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def _parse_metadata(path, key):
    """Parse ffmpeg metadata=mode=print output. Returns [(pts_time, value)]."""
    results = []
    pts_time = None
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("frame:"):
                    m = re.search(r"pts_time:([\d.]+)", line)
                    pts_time = float(m.group(1)) if m else None
                elif line.startswith(key + "=") and pts_time is not None:
                    results.append((pts_time, float(line.split("=", 1)[1])))
                    pts_time = None
    except FileNotFoundError:
        pass
    return results


def _aggregate_per_second(frames, duration):
    n = int(duration) + 1
    buckets = [0.0] * n
    for ts, val in frames:
        idx = min(int(ts), n - 1)
        buckets[idx] = max(buckets[idx], val)
    return buckets


def _run_all_checks(path, tag):
    """
    Single FFmpeg pass: blockdetect + blurdetect + freezedetect + blackdetect.
    Returns (block_frames, blur_frames, freeze_events, black_events).
    """
    block_meta = f"/tmp/block_{tag}.txt"
    blur_meta  = f"/tmp/blur_{tag}.txt"

    vf = (
        f"split=2[a][b];"
        f"[a]blockdetect=period_min=3:period_max=24,"
        f"metadata=mode=print:file={block_meta}:direct=1[block_out];"
        f"[b]blurdetect=high=0.1,"
        f"metadata=mode=print:file={blur_meta}:direct=1,"
        f"freezedetect=noise=0.001:duration=0.5,"
        f"blackdetect=d=0.1:pix_th=0.10[blur_out]"
    )

    result = subprocess.run(
        [FFMPEG, "-y", "-i", path,
         "-filter_complex", vf,
         "-map", "[block_out]", "-map", "[blur_out]",
         "-f", "null", "-", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    stderr = result.stderr

    freeze_events = []
    starts = list(re.finditer(r"freeze_start: ([\d.]+)", stderr))
    ends   = list(re.finditer(r"freeze_end: ([\d.]+)", stderr))
    durs   = list(re.finditer(r"freeze_duration: ([\d.]+)", stderr))
    for i, s in enumerate(starts):
        ev = {"start": float(s.group(1))}
        if i < len(ends):
            ev["end"] = float(ends[i].group(1))
        if i < len(durs):
            ev["duration"] = float(durs[i].group(1))
        freeze_events.append(ev)

    black_events = []
    for m in re.finditer(
        r"black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)", stderr
    ):
        black_events.append({
            "start":    float(m.group(1)),
            "end":      float(m.group(2)),
            "duration": float(m.group(3)),
        })

    block_frames = _parse_metadata(block_meta, "lavfi.block")
    blur_frames  = _parse_metadata(blur_meta,  "lavfi.blur")
    return block_frames, blur_frames, freeze_events, black_events


def _build_stream_result(path, tag):
    """Download, analyze, and return result dict for one stream."""
    duration = _get_duration(path)
    block_frames, blur_frames, freeze_events, black_events = _run_all_checks(path, tag)

    block_per_sec = _aggregate_per_second(block_frames, duration)
    blur_per_sec  = _aggregate_per_second(blur_frames, duration)

    issues = []
    for sec, val in enumerate(block_per_sec):
        if val > BLOCK_THRESHOLD:
            issues.append({"type": "blocking", "timestamp": sec, "score": round(val, 4)})
    for sec, val in enumerate(blur_per_sec):
        if val > BLUR_THRESHOLD:
            issues.append({"type": "blur", "timestamp": sec, "score": round(val, 4)})
    for ev in freeze_events:
        issues.append({"type": "freeze", "timestamp": round(ev.get("start", 0), 2),
                       "duration": round(ev.get("duration", 0), 2)})
    for ev in black_events:
        issues.append({"type": "black_frame", "timestamp": round(ev.get("start", 0), 2),
                       "duration": round(ev.get("duration", 0), 2)})
    issues.sort(key=lambda x: x["timestamp"])

    return {
        "duration":      round(duration, 1),
        "block_per_sec": [round(v, 4) for v in block_per_sec],
        "blur_per_sec":  [round(v, 4) for v in blur_per_sec],
        "freeze_events": freeze_events,
        "black_events":  black_events,
        "issues":        issues,
        "overall":       "PASS" if not issues else "ISSUES_FOUND",
    }


def handler(event, context):
    episode_id   = event["episode_id"]
    combined_url = event["combined_url"]
    mongo_uri    = os.environ["MONGO_URI"]

    print(f"[QC] Starting quality check for {episode_id}")

    h265_url, h264_url = _extract_1080p_streams(combined_url)
    if not h265_url and not h264_url:
        raise ValueError("Could not find 1080p streams in combined manifest")

    streams = {}
    if h265_url:
        print(f"[QC] Downloading 1080p H265...")
        _download_stream(h265_url, "/tmp/h265_1080p.mp4")
        streams["h265_1080p"] = _build_stream_result("/tmp/h265_1080p.mp4", "h265")
        print(f"[QC] H265 done — {streams['h265_1080p']['overall']}")

    if h264_url:
        print(f"[QC] Downloading 1080p H264...")
        _download_stream(h264_url, "/tmp/h264_1080p.mp4")
        streams["h264_1080p"] = _build_stream_result("/tmp/h264_1080p.mp4", "h264")
        print(f"[QC] H264 done — {streams['h264_1080p']['overall']}")

    all_issues = (
        streams.get("h265_1080p", {}).get("issues", []) +
        streams.get("h264_1080p", {}).get("issues", [])
    )
    overall = "PASS" if not all_issues else "ISSUES_FOUND"

    result = {
        "episode_id": episode_id,
        "streams":    streams,
        "overall":    overall,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }

    mongo_client = pymongo.MongoClient(mongo_uri)
    try:
        mongo_client["chai_q_lab"].video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {"quality_check": result}},
        )
    finally:
        mongo_client.close()

    print(f"[QC] Done. Overall: {overall}")
    return result
