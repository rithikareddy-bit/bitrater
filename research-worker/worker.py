import os, subprocess, json, sys, pymongo, boto3
from urllib.parse import urlparse
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
    fps = float(Fraction(r)) if "/" in r else float(r)
    return {"width": w, "height": h, "fps": fps}

def get_s3_client():
    return boto3.client('s3')

CODEC_TO_CONFIG = {"libx264": "h264", "libx265": "h265"}

def load_heavy_params(codec):
    config_path = f"configs/{CODEC_TO_CONFIG.get(codec, codec)}_heavy.json"
    if os.path.exists(config_path):
        with open(config_path) as f:
            return json.load(f)
    return {}

def _two_pass_encode(codec, preset, bitrate, pix_fmt, params, scale_w, scale_h):
    """Run two-pass FFmpeg encode. x264 and x265 use different two-pass mechanisms."""
    maxrate = f"{int(bitrate)*2}k"
    bufsize = f"{int(bitrate)*4}k"
    vf = f"scale={scale_w}:{scale_h}:flags=lanczos"

    if codec == "libx264":
        passlogfile = "/tmp/x264_pass"
        base = [
            "ffmpeg", "-y", "-i", "source.mp4",
            "-c:v", codec, "-preset", preset, "-b:v", f"{bitrate}k",
            "-maxrate", maxrate, "-bufsize", bufsize,
            "-pix_fmt", pix_fmt,
        ]
        if params:
            base += ["-x264-params", params]
        base += ["-vf", vf, "-passlogfile", passlogfile]
        subprocess.run(base + ["-pass", "1", "-an", "-f", "null", "/dev/null"], check=True)
        subprocess.run(base + ["-pass", "2", "variant.mp4"], check=True)
    else:
        stats_file = "/tmp/x265_pass.log"
        base = [
            "ffmpeg", "-y", "-i", "source.mp4",
            "-c:v", codec, "-preset", preset, "-b:v", f"{bitrate}k",
            "-maxrate", maxrate, "-bufsize", bufsize,
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

    parsed = urlparse(s3_url)
    host = parsed.netloc
    path = parsed.path.lstrip('/')
    if host.startswith("s3") and host.endswith(".amazonaws.com"):
        # Path-style: https://s3.region.amazonaws.com/bucket/key
        parts = path.split("/", 1)
        bucket, key = parts[0], parts[1] if len(parts) > 1 else ""
        region = host.split(".")[1] if host.count(".") >= 3 else None
    else:
        # Virtual-hosted: https://bucket.s3.region.amazonaws.com/key
        bucket = host.split(".s3")[0]
        key = path
        region = host.split(".s3.")[1].split(".")[0] if ".s3." in host else None
    s3 = boto3.client('s3', region_name=region) if region else get_s3_client()
    s3.download_file(bucket, key, 'source.mp4')

    config   = load_heavy_params(codec)
    preset   = config.get("preset", "slower")
    pix_fmt  = config.get("pix_fmt", "yuv420p10le" if codec == "libx265" else "yuv420p")
    params   = config.get("params", "")

    _two_pass_encode(codec, preset, bitrate, pix_fmt, params, scale_w, scale_h)

    info = _get_video_info("source.mp4")
    w, h = info["width"], info["height"]
    source_fps = max(1, round(info["fps"]))

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
    for i in range(0, len(frames), source_fps):
        chunk = frames[i:i + source_fps]
        vmaf_timeline.append(round(sum(f["metrics"]["vmaf"] for f in chunk) / len(chunk), 2))

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    db["video_vmaf_research"].insert_one({
        "episode_id":    episode_id,
        "codec":         codec,
        "bitrate_kbps":  int(bitrate),
        "resolution":    resolution_tag,
        "vmaf_score":    vmaf_score,
        "vmaf_timeline": vmaf_timeline,
        "preset":        preset,
        "params":        params,
        "timestamp":     datetime.now(timezone.utc).isoformat(),
    })
    print(f"[OK] episode={episode_id} codec={codec} res={resolution_tag} bitrate={bitrate}k vmaf={vmaf_score:.2f}")

def main():
    try:
        run_research()
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
