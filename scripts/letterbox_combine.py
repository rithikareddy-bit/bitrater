#!/usr/bin/env python3
"""One-off follow-up to letterbox_test.py: publish its h264+h265 outputs to the
CDN under a scratch folder and build a combined master for them.

Copies GCS->GCS from gs://chai-q-transcoder-output/_letterbox_test/ into the CDN
bucket chai-shots-manifests (nothing else touched), like gcp_finalize_hls:
  _letterbox_test/<episode>/h264/*    _letterbox_test/<episode>/h265/*
  _letterbox_test/<episode>/<slug>_ep_<n>_letterbox_test_combined.m3u8

The combined master is built with the same parse/sort/audio-group rules as
orchestrator/gcp_create_combined_master.py (H265 group first, 720→480→1080).
It is named *_combined.m3u8 like the real masters, so Media CDN enforces the
edge-cache-token on it; the printed URL is signed the same way the resigner
signs live combined URLs (token, FullPath), valid for --ttl-hours.
Sub-manifest init BYTERANGEs are corrected like gcp_finalize_hls does.
No Mongo writes, no showcache.

  source .env.deploy
  .venv/bin/python scripts/letterbox_combine.py --episode-id <id> --slug love-wifi --episode-number 10 \
      --from-secret arn:aws:secretsmanager:...:chai-q-gcp-credentials-0IwMJd
      [--signing-secret chai-q/media-cdn-signing-key --ttl-hours 168]
"""
import argparse
import os
import re
import struct
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "orchestrator"))
sys.path.insert(0, os.path.join(REPO, "scripts"))
os.environ.setdefault("CDN_BASE", "https://cdn.chaishots.in")

from gcp_create_combined_master import _order_map, _parse_manifest, _sort_key  # noqa: E402
from letterbox_test import OUTPUT_BUCKET, SCRATCH, load_creds  # noqa: E402
import media_cdn_signer  # noqa: E402

CDN_BASE = os.environ["CDN_BASE"]
CDN_BUCKET = "chai-shots-manifests"
M3U8 = "application/x-mpegURL; charset=utf-8"
CACHE = "public, max-age=300"  # short: scratch test files may be re-published


def fix_init_byterange(folder, manifest):
    """Same correction as gcp_finalize_hls._correct_init_byterange, on local files."""
    path = os.path.join(folder, manifest)
    text = open(path, encoding="utf-8").read()
    m = re.search(r'#EXT-X-MAP:URI="([^"]+)",BYTERANGE="(\d+)@0"', text)
    if not m:
        return
    with open(os.path.join(folder, m.group(1)), "rb") as f:
        head = f.read(4096)
    ftyp = struct.unpack(">I", head[0:4])[0]
    correct = ftyp + struct.unpack(">I", head[ftyp:ftyp + 4])[0]
    if int(m.group(2)) != correct:
        open(path, "w", encoding="utf-8").write(text.replace(f'BYTERANGE="{m.group(2)}@0"', f'BYTERANGE="{correct}@0"'))
        print(f"[FIX] {manifest}: BYTERANGE {m.group(2)} -> {correct}")


def fix_init_byterange_gcs(bucket, folder, manifest):
    """gcp_finalize_hls._correct_init_byterange, for one sub-manifest in the CDN bucket."""
    blob = bucket.blob(f"{folder}/{manifest}")
    text = blob.download_as_text(encoding="utf-8")
    m = re.search(r'#EXT-X-MAP:URI="([^"]+)",BYTERANGE="(\d+)@0"', text)
    if not m:
        return
    head = bucket.blob(f"{folder}/{m.group(1)}").download_as_bytes(start=0, end=4095)
    ftyp = struct.unpack(">I", head[0:4])[0]
    correct = ftyp + struct.unpack(">I", head[ftyp:ftyp + 4])[0]
    if int(m.group(2)) != correct:
        blob.cache_control = CACHE
        blob.upload_from_string(text.replace(f'BYTERANGE="{m.group(2)}@0"', f'BYTERANGE="{correct}@0"'),
                                content_type=M3U8)
        print(f"[FIX] {manifest}: BYTERANGE {m.group(2)} -> {correct}")


def combine(h264_text, h265_text, h264_base, h265_base):
    """gcp_create_combined_master.handler's manifest assembly (no subtitles here)."""
    def absolutize(line, base):
        return re.sub(r'URI="(?!https?://)([^"]+)"', lambda m: f'URI="{base}/{m.group(1)}"', line)

    h264_media, h264_streams = _parse_manifest(h264_text)
    h265_media, h265_streams = _parse_manifest(h265_text)
    h264_streams = [(inf, f"{h264_base}/{uri}") for inf, uri in h264_streams]
    h265_streams = [(inf, f"{h265_base}/{uri}") for inf, uri in h265_streams]
    audio = (
        [re.sub(r'GROUP-ID="[^"]+"', 'GROUP-ID="audio-h265"', absolutize(l, h265_base)) for l in h265_media if "TYPE=AUDIO" in l]
        + [re.sub(r'GROUP-ID="[^"]+"', 'GROUP-ID="audio-h264"', absolutize(l, h264_base)) for l in h264_media if "TYPE=AUDIO" in l]
    )
    order = _order_map([inf for inf, _ in h265_streams + h264_streams])
    h265_streams.sort(key=lambda b: _sort_key(b[0], order))
    h264_streams.sort(key=lambda b: _sort_key(b[0], order))

    out = ["#EXTM3U", "#EXT-X-VERSION:7", *audio]
    for inf, uri in h265_streams + h264_streams:
        group = "audio-h265" if "h265" in uri else "audio-h264"
        inf = re.sub(r'AUDIO="[^"]+"', f'AUDIO="{group}"', inf) if "AUDIO=" in inf else f'{inf},AUDIO="{group}"'
        out += [inf, uri]
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episode-id", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--episode-number", required=True)
    ap.add_argument("--from-secret", required=True)
    ap.add_argument("--signing-secret", default="chai-q/media-cdn-signing-key")
    ap.add_argument("--ttl-hours", type=int, default=168)
    ap.add_argument("--codecs", default="h264,h265", help="publish these; combined is built only when both")
    args = ap.parse_args()
    ep = args.episode_id
    codecs = [c.strip() for c in args.codecs.split(",")]

    from google.cloud import storage as gcs
    creds, project = load_creds(args.from_secret)
    client = gcs.Client(credentials=creds, project=project)
    bucket = client.bucket(CDN_BUCKET)
    src_bucket = client.bucket(OUTPUT_BUCKET)
    prefix = f"{SCRATCH}/{ep}"

    texts = {}
    for codec in codecs:
        # Server-side GCS->GCS copy from the transcoder output, as gcp_finalize_hls does.
        src_prefix = f"{prefix}/{codec}/"
        blobs = list(client.list_blobs(OUTPUT_BUCKET, prefix=src_prefix))
        if not blobs:
            sys.exit(f"nothing at gs://{OUTPUT_BUCKET}/{src_prefix} — run letterbox_test.py first")
        for b in blobs:
            name = b.name[len(src_prefix):]
            dst = src_bucket.copy_blob(b, bucket, f"{prefix}/{codec}/{name}")
            dst.cache_control = CACHE
            dst.content_type = M3U8 if name.endswith(".m3u8") else "video/iso.segment"
            dst.patch()
        for b in blobs:
            name = b.name[len(src_prefix):]
            if name.endswith(".m3u8") and "master" not in name:
                fix_init_byterange_gcs(bucket, f"{prefix}/{codec}", name)
        print(f"[{codec}] copied {len(blobs)} files -> gs://{CDN_BUCKET}/{prefix}/{codec}/")
        texts[codec] = bucket.blob(f"{prefix}/{codec}/{codec}_master.m3u8").download_as_text(encoding="utf-8")

    for codec in codecs:
        print(f"[{codec}] {CDN_BASE}/{prefix}/{codec}/{codec}_master.m3u8")
    if set(codecs) != {"h264", "h265"}:
        return

    combined = combine(texts["h264"], texts["h265"], f"{CDN_BASE}/{prefix}/h264", f"{CDN_BASE}/{prefix}/h265")
    name = f"{args.slug}_ep_{args.episode_number}_letterbox_test_combined.m3u8"
    blob = bucket.blob(f"{prefix}/{name}")
    blob.cache_control = CACHE
    blob.upload_from_string(combined, content_type=M3U8)
    print(combined)
    url = f"{CDN_BASE}/{prefix}/{name}"
    import boto3, json
    key = json.loads(boto3.client("secretsmanager", region_name="us-east-1")
                     .get_secret_value(SecretId=args.signing_secret)["SecretString"])
    expires = int(time.time()) + args.ttl_hours * 3600
    qs = media_cdn_signer.sign_token_fullpath(url, expires, key["private_key_b64url"])
    print(f"[COMBINED] {media_cdn_signer.append_signing_params(url, qs)}")


if __name__ == "__main__":
    main()
