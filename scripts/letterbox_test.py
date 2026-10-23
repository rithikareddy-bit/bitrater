#!/usr/bin/env python3
"""One-off: transcode ONE episode with black bars top+bottom, separate h264/h265.

Manual test job (not part of the pipeline). Same ladder as prod — reuses
orchestrator/gcp_transcoder._build_job_config with the episode's golden_recipes
and source_fps — plus a preprocessing pad that ADDS --bar-px of black above and
below the SOURCE frame. The picture itself is untouched (no crop, no shrink): a
1080x1920 source becomes 1080x2400, and each rung's height grows to match
(1080x2400, 720x1600, 480x1066), so the bars scale with the rendition.

Writes ONLY under a scratch prefix, never the episode's live paths:
  source  -> gs://chai-q-transcoder-input/_letterbox_test/<episode>/source.mp4
  outputs -> gs://chai-q-transcoder-output/_letterbox_test/<episode>/<codec>/
No Mongo writes, no CDN copy, no finalize, no combined master, no showcache.
Mongo is only read (golden_recipes, source_fps, s3_url).

Dry run by default (prints the job config). --submit actually runs it:

  source .env.deploy
  .venv/bin/python scripts/letterbox_test.py --episode-id <id> \
      --from-secret arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd \
      --submit
"""
import argparse
import json
import os
import sys
import tempfile
import time
import urllib.request

import pymongo

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "orchestrator"))

from gcp_transcoder import _build_job_config  # noqa: E402
from google.cloud.video.transcoder_v1 import types  # noqa: E402

INPUT_BUCKET = "chai-q-transcoder-input"
OUTPUT_BUCKET = "chai-q-transcoder-output"
SCRATCH = "_letterbox_test"
GCP_LOCATION = "asia-south1"


def load_creds(secret_arn):
    """Service-account JSON from AWS Secrets Manager, held only in memory."""
    import boto3
    from google.oauth2 import service_account

    region = secret_arn.split(":")[3]
    info = json.loads(boto3.client("secretsmanager", region_name=region)
                      .get_secret_value(SecretId=secret_arn)["SecretString"])
    return service_account.Credentials.from_service_account_info(info), info["project_id"]


def with_bars(job_config, bar_px, src_w, src_h):
    """Pad bar_px of black above and below the source, and grow every rung's
    height by the same ratio so the picture keeps its exact aspect."""
    inp = job_config.inputs[0]
    pre = inp.preprocessing_config if "preprocessing_config" in inp else types.PreprocessingConfig()
    pre.pad = types.PreprocessingConfig.Pad(top_pixels=bar_px, bottom_pixels=bar_px)
    inp.preprocessing_config = pre
    padded_h = src_h + 2 * bar_px
    for es in job_config.elementary_streams:
        if "video_stream" not in es:
            continue
        vs = es.video_stream.h264 if "h264" in es.video_stream else es.video_stream.h265
        # even height, same width/height ratio as the padded source
        vs.height_pixels = round(vs.width_pixels * padded_h / src_w / 2) * 2
    return job_config


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episode-id", required=True)
    ap.add_argument("--codecs", default="h264,h265")
    ap.add_argument("--bar-px", type=int, default=240, help="black strip height at source resolution")
    ap.add_argument("--src-size", default="1080x1920", help="source WxH (ffprobe it)")
    ap.add_argument("--from-secret", help="AWS Secrets Manager ARN of the GCP SA (needed for --submit)")
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--download-dir", default="/tmp/letterbox_test")
    args = ap.parse_args()
    ep = args.episode_id
    codecs = [c.strip() for c in args.codecs.split(",")]
    src_w, src_h = map(int, args.src_size.split("x"))

    db = pymongo.MongoClient(os.environ["MONGO_URI"])
    lab = db["chai_q_lab"].video_episodes.find_one({"episode_id": ep}, {"golden_recipes": 1, "source_fps": 1})
    show = db["master"].showcache.find_one({"episodes.id": ep}, {"slug": 1, "episodes.$": 1})
    if not lab or not lab.get("golden_recipes") or not lab.get("source_fps"):
        sys.exit(f"{ep}: no golden_recipes/source_fps in chai_q_lab")
    s3_url = show["episodes"][0]["s3_url"]
    has_audio = True

    source_uri = f"gs://{INPUT_BUCKET}/{SCRATCH}/{ep}/source.mp4"
    configs = {}
    for codec in codecs:
        out = f"gs://{OUTPUT_BUCKET}/{SCRATCH}/{ep}/{codec}/"
        cfg = _build_job_config(source_uri, lab["golden_recipes"], out, codec, lab["source_fps"], has_audio)
        configs[codec] = with_bars(cfg, args.bar_px, src_w, src_h)
        rungs = {r: v[codec]["bitrate_kbps"] for r, v in lab["golden_recipes"]["resolutions"].items() if codec in v}
        print(f"[{codec}] {show['slug']} {ep} rungs(kbps)={rungs} fps={lab['source_fps']} -> {out}")

    if not args.submit:
        for codec, cfg in configs.items():
            print(f"\n--- {codec} JobConfig (dry run) ---")
            print(type(cfg).to_json(cfg))
        print("\nDry run only. Re-run with --submit --from-secret <arn> to execute.")
        return

    if not args.from_secret:
        sys.exit("--submit needs --from-secret")
    from google.cloud import storage as gcs
    from google.cloud.video import transcoder_v1

    creds, project = load_creds(args.from_secret)
    storage = gcs.Client(credentials=creds, project=project)
    client = transcoder_v1.TranscoderServiceClient(credentials=creds)

    src_blob = storage.bucket(INPUT_BUCKET).blob(f"{SCRATCH}/{ep}/source.mp4")
    if not src_blob.exists():
        with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
            print(f"[SRC] downloading {s3_url}")
            urllib.request.urlretrieve(s3_url, tmp.name)
            src_blob.upload_from_filename(tmp.name, content_type="video/mp4")
        print(f"[SRC] uploaded {source_uri}")

    parent = f"projects/{project}/locations/{GCP_LOCATION}"
    jobs = {c: client.create_job(parent=parent, job=types.Job(config=cfg)).name for c, cfg in configs.items()}
    for c, name in jobs.items():
        print(f"[{c}] submitted {name}")

    pending = dict(jobs)
    while pending:
        time.sleep(20)
        for c, name in list(pending.items()):
            job = client.get_job(name=name)
            state = job.state.name
            if state in ("SUCCEEDED", "FAILED"):
                print(f"[{c}] {state} {job.error.message if state == 'FAILED' else ''}")
                pending.pop(c)

    for c in jobs:
        prefix = f"{SCRATCH}/{ep}/{c}/"
        dest = os.path.join(args.download_dir, ep, c)
        os.makedirs(dest, exist_ok=True)
        for b in storage.list_blobs(OUTPUT_BUCKET, prefix=prefix):
            b.download_to_filename(os.path.join(dest, b.name[len(prefix):]))
        print(f"[{c}] downloaded -> {dest}/{c}_master.m3u8  (play: ffplay or VLC)")


if __name__ == "__main__":
    main()
