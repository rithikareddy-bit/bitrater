"""
Quality Check Lambda: analyze encoded HLS video for visual artifacts.

Checks the 1080p H264 stream from the per-codec H264 master.

Checks performed:
- Blocking artifacts (compression macroblocking)
- Blur (soft/degraded frames)
- Frozen frames (stuck/repeated content)
- Black frames (corrupt or dropped content)

Input event:
  { "episode_id": "..." }

The master URL is NOT passed in. It is read from chai_q_lab.video_episodes
(`h264_master_m3u8_url`), the same field the dashboard reads — not from
master.showcache. That URL is unsigned, and only `*_combined.m3u8` is token-
enforced at the edge, so the per-codec master and its children fetch openly.
This decouples QC from publish/sync state and from token enforcement.

Note: unlike the combined master, a per-codec master lists its variants as
RELATIVE URIs, so extracted URIs must be resolved against the master's base.
"""

import os
import re
import shutil
import tempfile
import json
import subprocess
import urllib.request
import pymongo
from datetime import datetime, timezone
import runtime_config

FFMPEG  = os.environ.get("FFMPEG_PATH",  "/opt/bin/ffmpeg")
FFPROBE = os.environ.get("FFPROBE_PATH", "/opt/bin/ffprobe")

BLOCK_THRESHOLD = 0.02
BLUR_THRESHOLD  = 0.8

CDN_BASE = os.environ.get("CDN_BASE", "https://cdn.chaishots.in")


def _fetch_manifest(url):
    """Download a manifest text from a CDN URL (HLS is UTF-8)."""
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8-sig")


# The 1080p rung is identified by its SHORT edge (min of WxH) being ~1080, NOT a
# literal "1080x1920". Using the short edge makes this orientation-agnostic
# (portrait 1080x1920, landscape 1920x1080) and tolerant of codec-padded widths
# (e.g. 1088x1920). 720p's short edge is 720, so a 1000px floor cleanly separates
# the top rung from 720p/480p.
_MIN_1080P_SHORT_EDGE = 1000


def _extract_1080p_h264(master_url):
    """
    Parse the H264 master and return an absolute URL for the 1080p H264 rung.

    The rung is matched by resolution (short edge >= 1000) and codec, so it works
    for any aspect ratio — not just exactly-portrait 1080x1920. When there is more
    than one 1080p variant, the highest-BANDWIDTH one is chosen. Returns None if
    the master has no 1080p H264 rung.
    """
    text = _fetch_manifest(master_url)
    lines = text.strip().split("\n")
    best_bw, best_uri = -1, None
    for i, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF"):
            continue
        m = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
        if not m:
            continue
        short_edge = min(int(m.group(1)), int(m.group(2)))
        if short_edge < _MIN_1080P_SHORT_EDGE:
            continue
        uri = lines[i + 1] if i + 1 < len(lines) else ""
        if not uri or uri.startswith("#"):
            continue
        if not ("avc1" in line or "h264" in uri):
            continue
        bw_m = re.search(r"BANDWIDTH=(\d+)", line)
        bw = int(bw_m.group(1)) if bw_m else 0
        if bw > best_bw:
            best_bw, best_uri = bw, uri
    if not best_uri:
        return None
    return _to_absolute(best_uri, master_url.rsplit("/", 1)[0])


def _to_absolute(uri, base_url):
    """Resolve a (possibly relative) URI against base_url."""
    if uri.startswith(("http://", "https://")):
        return uri
    return f"{base_url}/{uri}"


def _rewrite_variant_manifest(text, base_url):
    """Rewrite every segment + URI-attribute reference in a variant manifest to
    an absolute URL so ffmpeg can fetch segments without a base URL context.
    """
    out_lines = []
    for line in text.split("\n"):
        m = re.search(r'URI="([^"]+)"', line) if line.startswith("#") else None
        if m:
            old = m.group(1)
            new = _to_absolute(old, base_url)
            line = line.replace(f'URI="{old}"', f'URI="{new}"')
        elif line and not line.startswith("#"):
            line = _to_absolute(line, base_url)
        out_lines.append(line)
    return "\n".join(out_lines)


def _download_stream(stream_url, out_path):
    """Download an HLS variant stream to an mp4 file."""
    variant_text = _fetch_manifest(stream_url)
    variant_base = stream_url.rsplit("/", 1)[0]
    rewritten = _rewrite_variant_manifest(variant_text, variant_base)

    local_manifest = out_path + ".m3u8"
    with open(local_manifest, "w") as f:
        f.write(rewritten)

    cmd = [
        FFMPEG, "-y",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        "-i", local_manifest,
        "-c", "copy", "-t", "300", out_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or "")[-1500:]
        raise RuntimeError(
            f"ffmpeg variant download failed (exit {result.returncode}) for {stream_url}: ...{tail}"
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
    work = os.path.dirname(path)  # per-call dir (see handler)
    block_meta = os.path.join(work, f"block_{tag}.txt")
    blur_meta  = os.path.join(work, f"blur_{tag}.txt")

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


def _get_h264_master_url(mongo_uri, episode_id):
    """Return the unsigned H264 master URL from chai_q_lab.video_episodes — the
    same field the dashboard reads. Trailers live in this collection too (their
    episode_id is the `trailer_<show>_<key>` string), so they need no special
    case. Returns None if the episode has no H264 master yet (transcode for that
    codec hasn't succeeded), so the caller can record ERROR.
    """
    client = pymongo.MongoClient(mongo_uri)
    try:
        doc = client[runtime_config.DB_LAB].video_episodes.find_one(
            {"episode_id": episode_id},
            {"h264_master_m3u8_url": 1},
        )
        return (doc or {}).get("h264_master_m3u8_url")
    finally:
        client.close()


def _save_quality_check(mongo_uri, episode_id, quality_check):
    """Write the quality_check doc to chai_q_lab.video_episodes."""
    client = pymongo.MongoClient(mongo_uri)
    try:
        client[runtime_config.DB_LAB].video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {"quality_check": quality_check}},
        )
    finally:
        client.close()


def handler(event, context):
    episode_id = event["episode_id"]
    mongo_uri  = os.environ["MONGO_URI"]

    print(f"[QC] Starting quality check for {episode_id}")
    # Own dir per call: on Azure several activities share one process/filesystem.
    workdir = tempfile.mkdtemp(prefix="qc-")
    stream_path = os.path.join(workdir, "h264_1080p.mp4")

    try:
        master_url = _get_h264_master_url(mongo_uri, episode_id)
        if not master_url:
            raise ValueError(
                "Episode has no h264_master_m3u8_url in chai_q_lab.video_episodes "
                "— H264 transcode hasn't succeeded yet"
            )
        print(f"[QC] Using H264 master: {master_url}")
        h264_url = _extract_1080p_h264(master_url)
        if not h264_url:
            raise ValueError("Could not find a 1080p H264 stream in the H264 master")

        streams = {}
        print(f"[QC] Downloading 1080p H264...")
        _download_stream(h264_url, stream_path)
        streams["h264_1080p"] = _build_stream_result(stream_path, "h264")
        print(f"[QC] H264 done — {streams['h264_1080p']['overall']}")

        all_issues = streams["h264_1080p"]["issues"]
        overall = "PASS" if not all_issues else "ISSUES_FOUND"

        result = {
            "episode_id": episode_id,
            "streams":    streams,
            "overall":    overall,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

        _save_quality_check(mongo_uri, episode_id, result)
        print(f"[QC] Done. Overall: {overall}")
        return result

    except Exception as e:
        err_msg = f"{type(e).__name__}: {e}"[:500]
        print(f"[QC] ERROR for {episode_id}: {err_msg}")
        try:
            _save_quality_check(mongo_uri, episode_id, {
                "episode_id": episode_id,
                "streams":    {},
                "overall":    "ERROR",
                "error":      err_msg,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as write_err:
            print(f"[QC] Failed to write ERROR result to Mongo: {write_err}")
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
