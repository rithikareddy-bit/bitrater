import os, subprocess, json, sys, pymongo, boto3
from urllib.parse import urlparse
from datetime import datetime, timezone

def get_s3_client():
    return boto3.client('s3')

def load_heavy_params(codec):
    config_path = f"configs/{codec.replace('lib', '')}_heavy.json"
    if os.path.exists(config_path):
        with open(config_path) as f:
            return json.load(f)
    return {}

def run_research():
    # Context from environment variables (passed by Step Function)
    s3_url      = os.getenv("S3_URL")
    bitrate     = os.getenv("BITRATE")
    codec       = os.getenv("CODEC")       # 'libx264' or 'libx265'
    episode_id  = os.getenv("EPISODE_ID")
    mongo_uri   = os.getenv("MONGO_URI")

    missing = [k for k, v in {"S3_URL": s3_url, "BITRATE": bitrate, "CODEC": codec,
                               "EPISODE_ID": episode_id, "MONGO_URI": mongo_uri}.items() if not v]
    if missing:
        raise EnvironmentError(f"Missing required env vars: {', '.join(missing)}")

    # 1. Download source from S3
    parsed = urlparse(s3_url)
    bucket, key = parsed.netloc, parsed.path.lstrip('/')
    get_s3_client().download_file(bucket, key, 'source.mp4')

    # 2. Load codec recipe from config (includes full psychovisual params)
    config   = load_heavy_params(codec)
    preset   = config.get("preset", "slower")
    pix_fmt  = config.get("pix_fmt", "yuv420p10le" if codec == "libx265" else "yuv420p")
    params   = config.get("params", "")
    param_key = "-x265-params" if codec == "libx265" else "-x264-params"

    # 3. THE HEAVY ENCODE: Prioritizing clarity in zoomed-out shots
    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", "source.mp4",
        "-c:v", codec, "-preset", preset, "-b:v", f"{bitrate}k",
        "-maxrate", f"{int(bitrate)*2}k", "-bufsize", f"{int(bitrate)*4}k",
        "-pix_fmt", pix_fmt, param_key, params,
        "-vf", "scale=1080:1920:flags=lanczos", "variant.mp4"
    ]
    subprocess.run(ffmpeg_cmd, check=True)

    # 4. VMAF ANALYSIS (Phone Model — predicts human perception on mobile OLEDs)
    vmaf_cmd = [
        "vmaf",
        "-r", "source.mp4",
        "-d", "variant.mp4",
        "--model", "version=vmaf_v0.6.1neg",
        "--json", "-o", "vmaf_results.json"
    ]
    subprocess.run(vmaf_cmd, check=True)

    # 5. STORE IN MONGODB
    with open("vmaf_results.json") as f:
        data = json.load(f)
        vmaf_score = data["pooled_metrics"]["vmaf"]["mean"]

    # Build 1-second VMAF timeline (bucket every 30 frames at 30fps)
    frames = data.get("frames", [])
    FPS = 30
    vmaf_timeline = []
    for i in range(0, len(frames), FPS):
        chunk = frames[i:i + FPS]
        vmaf_timeline.append(round(sum(f["metrics"]["vmaf"] for f in chunk) / len(chunk), 2))

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    db["video_vmaf_research"].insert_one({
        "episode_id":   episode_id,
        "codec":        codec,
        "bitrate_kbps": int(bitrate),
        "vmaf_score":   vmaf_score,
        "vmaf_timeline": vmaf_timeline,
        "preset":       preset,
        "params":       params,
        "timestamp":    datetime.now(timezone.utc).isoformat(),
    })
    print(f"[OK] episode={episode_id} codec={codec} bitrate={bitrate}k vmaf={vmaf_score:.2f}")

def main():
    try:
        run_research()
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
