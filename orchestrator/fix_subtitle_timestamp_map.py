"""
Scan every subtitle_*.vtt blob in GCS, fix any missing X-TIMESTAMP-MAP header.

Approach: reads/writes directly from GCS (not CDN) — no master m3u8 parsing,
no CDN round-trips. Fast: ~5-10 minutes with threading vs 6-12 hours via CDN.

Flow:
  1. List all subtitle_*.vtt blobs in chai-shots-manifests bucket
  2. For each blob: download, check for X-TIMESTAMP-MAP
  3. If missing: insert after WEBVTT line, re-upload to GCS
  4. Collect fixed prefixes → invalidate CDN sequentially at end

Required env:
    GCP_CREDENTIALS_JSON       — path to GCP service account JSON file
                                  OR GCP_CREDENTIALS_SECRET_ARN to pull from
                                  AWS Secrets Manager

Optional env:
    CDN_BASE          (default: https://cdn.chaishots.in)
    CDN_BUCKET        (default: chai-shots-manifests)
    WORKERS           (default: 20) — parallel GCS threads
    DRY_RUN=1         — check only, do not re-upload
    SKIP_CDN_INVALIDATION=1
"""

import os
import sys
import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from google.auth.transport.requests import AuthorizedSession
from google.cloud import storage as gcs
from google.oauth2 import service_account

CDN_BASE   = os.environ.get("CDN_BASE", "https://cdn.chaishots.in").rstrip("/")
CDN_BUCKET = os.environ.get("CDN_BUCKET", "chai-shots-manifests")
DRY_RUN    = os.environ.get("DRY_RUN", "0") == "1"
WORKERS    = int(os.environ.get("WORKERS", "20"))

MEDIA_CDN_PROJECT  = os.environ.get("MEDIA_CDN_PROJECT", "media-cdn-poc-466009")
MEDIA_CDN_SERVICE  = os.environ.get("MEDIA_CDN_SERVICE", "chai-shorts-media-cdn")
MEDIA_CDN_LOCATION = os.environ.get("MEDIA_CDN_LOCATION", "global")
NETWORK_SERVICES_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

TIMESTAMP_MAP_LINE = "X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000"
CONTENT_TYPE_VTT   = "text/vtt; charset=utf-8"

_print_lock = threading.Lock()


def _log(msg):
    with _print_lock:
        print(msg, flush=True)


def _get_gcp_credentials():
    json_path = os.environ.get("GCP_CREDENTIALS_JSON")
    if json_path:
        with open(json_path) as f:
            info = json.load(f)
        return service_account.Credentials.from_service_account_info(info)

    secret_arn = os.environ.get("GCP_CREDENTIALS_SECRET_ARN")
    if secret_arn:
        import boto3
        sm = boto3.client("secretsmanager")
        secret = sm.get_secret_value(SecretId=secret_arn)
        info = json.loads(secret["SecretString"])
        return service_account.Credentials.from_service_account_info(info)

    raise RuntimeError(
        "Set GCP_CREDENTIALS_JSON (path to service account JSON) "
        "or GCP_CREDENTIALS_SECRET_ARN"
    )


def _add_timestamp_map(vtt_text: str) -> str:
    """Insert X-TIMESTAMP-MAP immediately after the WEBVTT line."""
    lines = vtt_text.replace("\r\n", "\n").split("\n")
    out = []
    inserted = False
    for line in lines:
        out.append(line)
        if not inserted and line.strip().upper().startswith("WEBVTT"):
            out.append(TIMESTAMP_MAP_LINE)
            inserted = True
    return "\n".join(out)


def _invalidate_cdn_prefix(session, cdn_prefix: str) -> None:
    if os.environ.get("SKIP_CDN_INVALIDATION") == "1":
        _log(f"  [CDN] skipped invalidation for {cdn_prefix}")
        return
    service_path = (
        f"projects/{MEDIA_CDN_PROJECT}/locations/{MEDIA_CDN_LOCATION}"
        f"/edgeCacheServices/{MEDIA_CDN_SERVICE}"
    )
    url = f"https://networkservices.googleapis.com/v1/{service_path}:invalidateCache"
    path_pattern = f"/{cdn_prefix.strip('/')}/*"
    resp = session.post(url, json={"path": path_pattern})
    if resp.status_code >= 300:
        _log(f"  [CDN] FAILED {path_pattern}: {resp.status_code} {resp.text[:120]}")
    else:
        _log(f"  [CDN] queued  {path_pattern}")


def _process_blob(bucket, blob_name: str):
    """
    Download one VTT blob, check for X-TIMESTAMP-MAP, fix if missing.
    Returns: 'ok' | 'fixed' | 'error'
    """
    try:
        blob = bucket.blob(blob_name)
        content = blob.download_as_text(encoding="utf-8")

        if TIMESTAMP_MAP_LINE in content:
            return "ok", blob_name, None

        if DRY_RUN:
            _log(f"  [DRY] would fix  gs://{CDN_BUCKET}/{blob_name}")
            return "fixed", blob_name, None

        fixed = _add_timestamp_map(content)
        blob.cache_control = "public, max-age=2592000"
        blob.upload_from_string(fixed, content_type=CONTENT_TYPE_VTT)
        _log(f"  [FIXED] {blob_name}")
        return "fixed", blob_name, None

    except Exception as e:
        _log(f"  [ERROR] {blob_name}: {e}")
        return "error", blob_name, str(e)


def main():
    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds)
    bucket = gcs_client.bucket(CDN_BUCKET)

    print(f"{'[DRY RUN] ' if DRY_RUN else ''}Listing subtitle_*.vtt blobs in gs://{CDN_BUCKET} ...")

    blobs = [
        b.name for b in gcs_client.list_blobs(CDN_BUCKET)
        if b.name.endswith(".vtt") and "/subtitle_" in b.name
    ]

    print(f"Found {len(blobs)} subtitle VTT blobs. Processing with {WORKERS} workers...\n")

    already_ok = 0
    fixed      = 0
    errors     = 0
    fixed_prefixes = set()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_process_blob, bucket, name): name for name in blobs}
        done = 0
        for future in as_completed(futures):
            done += 1
            status, blob_name, _ = future.result()
            if status == "ok":
                already_ok += 1
            elif status == "fixed":
                fixed += 1
                prefix = blob_name.rsplit("/", 1)[0]
                fixed_prefixes.add(prefix)
            else:
                errors += 1
            if done % 100 == 0:
                with _print_lock:
                    print(f"  progress: {done}/{len(blobs)} blobs checked ...", flush=True)

    print(f"\n{'=' * 55}")
    print(f"Total VTT blobs      : {len(blobs)}")
    print(f"Already correct      : {already_ok}")
    print(f"Fixed                : {fixed}{'  (dry run — not uploaded)' if DRY_RUN else ''}")
    print(f"Errors               : {errors}")

    if fixed_prefixes and not DRY_RUN:
        print(f"\nInvalidating CDN cache for {len(fixed_prefixes)} prefix(es)...")
        scoped = creds.with_scopes([NETWORK_SERVICES_SCOPE])
        session = AuthorizedSession(scoped)
        for prefix in sorted(fixed_prefixes):
            _invalidate_cdn_prefix(session, prefix)

    print("\nDone.")


if __name__ == "__main__":
    main()
