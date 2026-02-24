import os, subprocess, json, pymongo, boto3
from urllib.parse import urlparse

def get_s3_client():
    return boto3.client('s3')

def run_research():
    # Context from environment variables (passed by Step Function)
    s3_url = os.getenv("S3_URL")
    bitrate = os.getenv("BITRATE")
    codec = os.getenv("CODEC") # 'libx264' or 'libx265'
    episode_id = os.getenv("EPISODE_ID")
    mongo_uri = os.getenv("MONGO_URI")
    
    # 1. Download source from S3
    parsed = urlparse(s3_url)
    bucket, key = parsed.netloc, parsed.path.lstrip('/')
    get_s3_client().download_file(bucket, key, 'source.mp4')

    # 2. THE HEAVY ENCODE: Prioritizing clarity in zoomed-out shots
    # We use 'slower' and high-quality psychovisual params
    if codec == 'libx265':
        # Main10 (10-bit) + AQ-Mode 3 for background textures
        params = "aq-mode=3:aq-strength=1.2:psy-rd=2.0:psy-rdoq=1.0:rd=4"
        pix_fmt = "yuv420p10le"
        param_key = "-x265-params"
    else:
        # High Profile H.264 + Film tuning for fallback
        params = "aq-mode=2:aq-strength=1.3:psy-rd=1.5,0.15"
        pix_fmt = "yuv420p"
        param_key = "-x264-params"

    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", "source.mp4",
        "-c:v", codec, "-preset", "slower", "-b:v", f"{bitrate}k",
        "-maxrate", f"{int(bitrate)*2}k", "-bufsize", f"{int(bitrate)*4}k",
        "-pix_fmt", pix_fmt, param_key, params,
        "-vf", "scale=1080:1920:flags=lanczos", "variant.mp4"
    ]
    subprocess.run(ffmpeg_cmd, check=True)

    # 3. VMAF ANALYSIS (Phone Model)
    # Note: VMAF requires ref and dist to be same resolution
    vmaf_cmd = [
        "vmaf", 
        "-r", "source.mp4", 
        "-d", "variant.mp4",
        "--model", "version=vmaf_v0.6.1neg", 
        "--json", "-o", "vmaf_results.json"
    ]
    subprocess.run(vmaf_cmd, check=True)

    # 4. STORE IN MONGODB
    with open("vmaf_results.json") as f:
        data = json.load(f)
        score = data["pooled_metrics"]["vmaf"]["mean"]