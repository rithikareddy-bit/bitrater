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

def load_heavy_params(codec):
    config_path = f"configs/{codec.replace('lib', '')}_heavy.json"
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
            "-pix_fmt", pix_fmt, "-x264-params", params,
            "-vf", vf, "-passlogfile", passlogfile,
        ]
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
        pass1_params = f"pass=1:stats={stats_file}:{params}"
        subprocess.run(
            base + ["-x265-params", pass1_params, "-an", "-f", "null", "/dev/null"],
            check=True,
        )
        pass2_params = f"pass=2:stats={stats_file}:{params}"
        subprocess.run(
            base + ["-x265-params", pass2_params, "variant.mp4"],
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
    bucket, key = parsed.netloc, parsed.path.lstrip('/')
    get_s3_client().download_file(bucket, key, 'source.mp4')

    config   = load_heavy_params(codec)
    preset   = config.get("preset", "slower")
    pix_fmt  = config.get("pix_fmt", "yuv420p10le" if codec == "libx265" else "yuv420p")
    params   = config.get("params", "")

    _two_pass_encode(codec, preset, bitrate, pix_fmt, params, scale_w, scale_h)

    info = _get_video_info("source.mp4")
    w, h, fps = info["width"], info["height"], info["fps"]

    subprocess.run(
        [
            "ffmpeg", "-y", "-i", "source.mp4",
            "-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe",
            "ref.y4m",
        ],
        check=True,
        capture_output=True,
    )

    subprocess.run(
        [
            "ffmpeg", "-y", "-i", "variant.mp4",
            "-vf", f"scale={w}:{h}:flags=lanczos",
            "-pix_fmt", "yuv420p", "-r", str(fps), "-f", "yuv4mpegpipe",
            "dist.y4m",
        ],
        check=True,
        capture_output=True,
    )

    vmaf_cmd = [
        "vmaf",
        "-r", "ref.y4m",
        "-d", "dist.y4m",
        "--model", "version=vmaf_v0.6.1neg",
        "--json", "-o", "vmaf_results.json",
    ]
    subprocess.run(vmaf_cmd, check=True)

    with open("vmaf_results.json") as f:
        data = json.load(f)
        vmaf_score = data["pooled_metrics"]["vmaf"]["mean"]

    frames = data.get("frames", [])
    FPS = 30
    vmaf_timeline = []
    for i in range(0, len(frames), FPS):
        chunk = frames[i:i + FPS]
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
