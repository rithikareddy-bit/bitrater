import os, subprocess, json, sys, re, shutil, urllib.request, pymongo, boto3
from urllib.parse import urlparse, unquote
from datetime import datetime, timezone
from fractions import Fraction

RESOLUTION_MAP = {
    "1080": {"width": 1080, "height": 1920},
    "720":  {"width": 720,  "height": 1280},
    "480":  {"width": 480,  "height": 854},
}

def _get_video_info(path):
    """Get width, height, fps from video via ffprobe. Raises if missing."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate", "-of", "json",
            path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(out.stdout)
    stream = data.get("streams", [{}])[0]
    w = int(stream["width"])
    h = int(stream["height"])
    r = stream.get("r_frame_rate", "30/1")
    return {"width": w, "height": h, "fps_raw": r}

def get_s3_client():
    return boto3.client('s3')

def _download_source(url, dest):
    """Download the source video to `dest`. `S3_URL` is not always S3: Sanity
    dev-store episodes point at public Azure Blob URLs. Dispatch on the host
    (mirrors dashboard/lib/sourceUrl.js) -- the old parser sent every non-path-
    style URL down the virtual-hosted S3 branch, so an Azure host became a bogus
    bucket name and HeadObject 404'd."""
    parsed = urlparse(url.strip())
    host = parsed.hostname or ""
    # S3 keys are stored URL-encoded in some records ("Ep%20-%207"); the S3 API
    # wants the literal key. HTTP origins below get the URL untouched.
    path = unquote(parsed.path.lstrip('/'))
    if parsed.scheme == "s3":
        # s3://bucket/key (orchestrator/lambda_trigger.py)
        bucket, key, region = parsed.netloc, path, None
    elif host.startswith("s3") and host.endswith(".amazonaws.com"):
        # Path-style: https://s3.region.amazonaws.com/bucket/key
        parts = path.split("/", 1)
        bucket, key = parts[0], parts[1] if len(parts) > 1 else ""
        region = host.split(".")[1] if host.count(".") >= 3 else None
    elif host.endswith(".amazonaws.com") and ".s3" in host:
        # Virtual-hosted: https://bucket.s3.region.amazonaws.com/key
        bucket = host.split(".s3")[0]
        key = path
        region = host.split(".s3.")[1].split(".")[0] if ".s3." in host else None
    else:
        # Direct HTTP(S) origin (Azure Blob, CDN) -- stream to disk.
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"Unsupported source URL scheme: {parsed.scheme!r}")
        with urllib.request.urlopen(url.strip(), timeout=60) as resp, open(dest, "wb") as f:
            shutil.copyfileobj(resp, f, length=8 * 1024 * 1024)
        return
    s3 = boto3.client('s3', region_name=region) if region else get_s3_client()
    s3.download_file(bucket, key, dest)

CODEC_TO_CONFIG = {"libx264": "h264", "libx265": "h265"}

# Candidate bitrate ladders + VMAF thresholds for the Parallel Resol binary
# search (LAB_MODE=search only). 1:1 mirror of SEARCH_CONFIG in
# orchestrator/search_orchestrator.py — keep in sync. The serial lab does NOT
# use this (it is handed one BITRATE per job).
SEARCH_CONFIG = {
    "h264": {
        "1080p": {"threshold": 88, "candidates": [1800, 2000, 2300, 2500, 2700, 3000, 3300, 3600, 3900, 4200, 4400, 4600, 4800]},
        "720p":  {"threshold": 75, "candidates": [700, 900, 1100, 1300, 1500, 1700, 1900]},
        "480p":  {"threshold": 48, "candidates": [200, 300, 400, 500, 600]},
    },
    "h265": {
        "1080p": {"threshold": 88, "candidates": [800, 1000, 1200, 1500, 1800, 2100, 2300, 2600, 2900, 3200]},
        "720p":  {"threshold": 75, "candidates": [500, 700, 900, 1200, 1350, 1500, 1650]},
        "480p":  {"threshold": 48, "candidates": [100, 200, 300, 400, 500]},
    },
}

def load_heavy_params(codec):
    config_path = f"configs/{CODEC_TO_CONFIG.get(codec, codec)}_heavy.json"
    if os.path.exists(config_path):
        with open(config_path) as f:
            return json.load(f)
    return {}

def _two_pass_encode(codec, preset, bitrate, pix_fmt, params, scale_w, scale_h, frame_rate, gop, bframes, episode_id):
    """Run two-pass FFmpeg encode. x264 and x265 use different two-pass mechanisms."""
    bufsize = f"{int(bitrate)*3}k"
    vf = f"scale={scale_w}:{scale_h}:flags=lanczos"

    if codec == "libx264":
        passlogfile = f"/tmp/x264_pass_{episode_id}"
        base = [
            "ffmpeg", "-y", "-i", "source.mp4",
            "-c:v", codec, "-preset", preset, "-tune", "film",
            "-r", str(frame_rate), "-g", str(gop), "-bf", str(bframes),
            "-b:v", f"{bitrate}k",
            "-bufsize", bufsize,
            "-pix_fmt", pix_fmt,
        ]
        if params:
            base += ["-x264-params", params]
        base += ["-vf", vf, "-passlogfile", passlogfile]
        subprocess.run(base + ["-pass", "1", "-an", "-f", "null", "/dev/null"], check=True)
        subprocess.run(base + ["-pass", "2", "variant.mp4"], check=True)
    else:
        stats_file = f"/tmp/x265_pass_{episode_id}.log"
        base = [
            "ffmpeg", "-y", "-i", "source.mp4",
            "-c:v", codec, "-preset", preset,
            "-r", str(frame_rate),
            "-b:v", f"{bitrate}k",
            "-bufsize", bufsize,
            "-pix_fmt", pix_fmt, "-vf", vf,
        ]
        pass_base = f"stats={stats_file}"
        if params:
            pass_base += f":{params}"
        subprocess.run(
            base + ["-x265-params", f"pass=1:{pass_base}", "-an", "-f", "null", "/dev/null"],
            check=True,
        )
        subprocess.run(
            base + ["-x265-params", f"pass=2:{pass_base}", "variant.mp4"],
            check=True,
        )

def run_research():
    s3_url      = os.getenv("S3_URL")
    bitrate     = os.getenv("BITRATE")
    codec       = os.getenv("CODEC")
    episode_id  = os.getenv("EPISODE_ID")
    mongo_uri   = os.getenv("MONGO_URI")
    resolution  = os.getenv("RESOLUTION", "1080")

    missing = [k for k, v in {"S3_URL": s3_url, "BITRATE": bitrate, "CODEC": codec,
                               "EPISODE_ID": episode_id, "MONGO_URI": mongo_uri}.items() if not v]
    if missing:
        raise EnvironmentError(f"Missing required env vars: {', '.join(missing)}")

    res_dims = RESOLUTION_MAP.get(resolution)
    if not res_dims:
        raise ValueError(f"Unsupported RESOLUTION '{resolution}'. Must be one of: {list(RESOLUTION_MAP)}")
    scale_w, scale_h = res_dims["width"], res_dims["height"]
    resolution_tag = f"{resolution}p"

    _download_source(s3_url, 'source.mp4')

    info = _get_video_info("source.mp4")
    w, h = info["width"], info["height"]
    source_fps = Fraction(info["fps_raw"])
    fps_float  = float(source_fps)

    config   = load_heavy_params(codec)
    preset   = config.get("preset", "slower")
    pix_fmt  = config.get("pix_fmt", "yuv420p")
    params   = config.get("params", "")
    bframes  = config.get("bframes", 3)

    frame_rate = info["fps_raw"]
    gop        = round(fps_float * 2)
    if 'keyint=' in params:
        params = re.sub(r'keyint=\d+', f'keyint={gop}', params)
    elif codec == "libx265":
        params = f"keyint={gop}:{params}" if params else f"keyint={gop}"

    _two_pass_encode(codec, preset, bitrate, pix_fmt, params, scale_w, scale_h, frame_rate, gop, bframes, episode_id)

    vmaf_filter = (
        f"[0:v]setpts=PTS-STARTPTS[ref];"
        f"[1:v]scale={w}:{h}:flags=lanczos,setpts=PTS-STARTPTS[dist];"
        f"[ref][dist]libvmaf=model=version=vmaf_v0.6.1neg"
        f":log_path=vmaf_results.json:log_fmt=json:n_threads=4"
    )
    subprocess.run(
        [
            "ffmpeg", "-i", "source.mp4", "-i", "variant.mp4",
            "-lavfi", vmaf_filter, "-f", "null", "-",
        ],
        check=True,
    )

    with open("vmaf_results.json") as f:
        data = json.load(f)
        vmaf_score = data["pooled_metrics"]["vmaf"]["mean"]

    frames = data.get("frames", [])
    vmaf_timeline = []
    fps_int = round(fps_float)
    for i in range(0, len(frames), fps_int):
        chunk = frames[i:i + fps_int]
        if chunk:  # guard against empty trailing chunk
            vmaf_timeline.append(round(sum(f["metrics"]["vmaf"] for f in chunk) / len(chunk), 2))

    mongo_client = pymongo.MongoClient(mongo_uri)
    try:
        db = mongo_client["chai_q_lab"]
        lab_run_id = os.getenv("LAB_RUN_ID")
        doc = {
            "episode_id":    episode_id,
            "codec":         codec,
            "bitrate_kbps":  int(bitrate),
            "resolution":    resolution_tag,
            "vmaf_score":    vmaf_score,
            "vmaf_timeline": vmaf_timeline,
            "preset":        preset,
            "params":        params,
            "timestamp":     datetime.now(timezone.utc).isoformat(),
        }
        if lab_run_id:
            doc["lab_run_id"] = lab_run_id
        try:
            db["video_vmaf_research"].insert_one(doc)
        except Exception as e:
            raise RuntimeError(f"Failed to write VMAF result to MongoDB: {e}") from e
        db["video_episodes"].update_one(
            {"episode_id": episode_id},
            {"$set": {"source_fps": round(fps_float, 4)}},
            upsert=True,
        )
    finally:
        mongo_client.close()
    print(f"[OK] episode={episode_id} codec={codec} res={resolution_tag} bitrate={bitrate}k vmaf={vmaf_score:.2f}")


def run_search():
    """Parallel Resol worker (LAB_MODE=search): binary-search ONE resolution's
    bitrate ladder for ONE codec, in-container. Downloads the source once, writes
    every trial to video_vmaf_research; the aggregator picks the winner. No
    BITRATE env — the ladder is chosen here. Separate code path from the serial
    lab's run_research() above, which is untouched."""
    s3_url      = os.getenv("S3_URL")
    codec       = os.getenv("CODEC")
    episode_id  = os.getenv("EPISODE_ID")
    mongo_uri   = os.getenv("MONGO_URI")
    resolution  = os.getenv("RESOLUTION", "1080")
    lab_run_id  = os.getenv("LAB_RUN_ID")

    missing = [k for k, v in {"S3_URL": s3_url, "CODEC": codec,
                               "EPISODE_ID": episode_id, "MONGO_URI": mongo_uri}.items() if not v]
    if missing:
        raise EnvironmentError(f"Missing required env vars: {', '.join(missing)}")

    res_dims = RESOLUTION_MAP.get(resolution)
    if not res_dims:
        raise ValueError(f"Unsupported RESOLUTION '{resolution}'. Must be one of: {list(RESOLUTION_MAP)}")
    scale_w, scale_h = res_dims["width"], res_dims["height"]
    resolution_tag = f"{resolution}p"

    config_name = CODEC_TO_CONFIG.get(codec)
    search_cfg = SEARCH_CONFIG.get(config_name, {}).get(resolution_tag)
    if not search_cfg:
        raise ValueError(f"No search config for codec={codec} resolution={resolution_tag}")
    candidates = search_cfg["candidates"]
    threshold = search_cfg["threshold"]

    # Download source ONCE (same helper as run_research).
    _download_source(s3_url, 'source.mp4')

    info = _get_video_info("source.mp4")
    w, h = info["width"], info["height"]
    fps_float = float(Fraction(info["fps_raw"]))
    frame_rate = info["fps_raw"]

    config   = load_heavy_params(codec)
    preset   = config.get("preset", "slower")
    pix_fmt  = config.get("pix_fmt", "yuv420p")
    params   = config.get("params", "")
    bframes  = config.get("bframes", 3)

    gop = round(fps_float * 2)
    if 'keyint=' in params:
        params = re.sub(r'keyint=\d+', f'keyint={gop}', params)
    elif codec == "libx265":
        params = f"keyint={gop}:{params}" if params else f"keyint={gop}"

    fps_int = round(fps_float)
    mongo_client = pymongo.MongoClient(mongo_uri)
    try:
        db = mongo_client["chai_q_lab"]
        # Idempotent on Batch retry: drop this (episode,codec,resolution)'s trials.
        db["video_vmaf_research"].delete_many(
            {"episode_id": episode_id, "codec": codec, "resolution": resolution_tag}
        )
        db["video_episodes"].update_one(
            {"episode_id": episode_id},
            {"$set": {"source_fps": round(fps_float, 4)}},
            upsert=True,
        )

        def _score(bitrate):
            # Unique passlog key per bitrate so sequential two-pass trials in this
            # one container never reuse a stale first-pass log.
            _two_pass_encode(codec, preset, bitrate, pix_fmt, params, scale_w, scale_h,
                             frame_rate, gop, bframes, f"{episode_id}_{bitrate}")
            vmaf_filter = (
                f"[0:v]setpts=PTS-STARTPTS[ref];"
                f"[1:v]scale={w}:{h}:flags=lanczos,setpts=PTS-STARTPTS[dist];"
                f"[ref][dist]libvmaf=model=version=vmaf_v0.6.1neg"
                f":log_path=vmaf_results.json:log_fmt=json:n_threads=4"
            )
            subprocess.run(
                ["ffmpeg", "-i", "source.mp4", "-i", "variant.mp4", "-lavfi", vmaf_filter, "-f", "null", "-"],
                check=True,
            )
            with open("vmaf_results.json") as f:
                data = json.load(f)
            vmaf_score = data["pooled_metrics"]["vmaf"]["mean"]
            frames = data.get("frames", [])
            vmaf_timeline = []
            for i in range(0, len(frames), fps_int):
                chunk = frames[i:i + fps_int]
                if chunk:
                    vmaf_timeline.append(round(sum(f["metrics"]["vmaf"] for f in chunk) / len(chunk), 2))
            doc = {
                "episode_id":    episode_id,
                "codec":         codec,
                "bitrate_kbps":  int(bitrate),
                "resolution":    resolution_tag,
                "vmaf_score":    vmaf_score,
                "vmaf_timeline": vmaf_timeline,
                "preset":        preset,
                "params":        params,
                "timestamp":     datetime.now(timezone.utc).isoformat(),
            }
            if lab_run_id:
                doc["lab_run_id"] = lab_run_id
            db["video_vmaf_research"].insert_one(doc)
            print(f"[trial] episode={episode_id} codec={codec} res={resolution_tag} bitrate={bitrate}k vmaf={vmaf_score:.2f}")
            return vmaf_score

        # Binary search (port of search_orchestrator._advance_binary).
        left, right = 0, len(candidates) - 1
        best_pass = None            # lowest bitrate that met threshold
        best_any = None             # (vmaf, bitrate) highest-VMAF fallback
        while left <= right:
            mid = (left + right) // 2
            bitrate = candidates[mid]
            vmaf = _score(bitrate)
            if best_any is None or vmaf > best_any[0]:
                best_any = (vmaf, bitrate)
            if vmaf >= threshold:
                best_pass = bitrate if best_pass is None else min(best_pass, bitrate)
                right = mid - 1
            else:
                left = mid + 1
        winner = best_pass if best_pass is not None else best_any[1]
    finally:
        mongo_client.close()
    print(f"[OK-search] episode={episode_id} codec={codec} res={resolution_tag} winner={winner}k")


def main():
    try:
        # Parallel Resol sets LAB_MODE=search -> in-container binary search.
        # The serial lab never sets LAB_MODE, so it takes the original
        # single-encode path (run_research) UNCHANGED.
        if os.getenv("LAB_MODE") == "search":
            run_search()
        else:
            run_research()
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
