"""
State 1 of GCP-Orchestrator: Copy source video from S3 to GCS.

GCP Transcoder requires GCS input. The source lives in S3 (us-east-1) but the
GCS buckets live in asia-south1 (Mumbai). A single serial upload stream over
that ~200ms transcontinental RTT is TCP-window-limited (throughput ~= window /
RTT) regardless of Lambda bandwidth, so large sources couldn't finish inside
the 900s Lambda ceiling.

Fix: transfer the source in PARALLEL. Split it into fixed-size byte ranges,
run up to MAX_WORKERS concurrent S3-range -> GCS-part uploads, then GCS-compose
the parts into the final source.mp4. Many streams defeat the single-window
limit; aggregate throughput is capped only by the Lambda's (memory-scaled)
network allocation. Small sources take a simple single-shot path to avoid the
compose overhead.
"""

import os
import json
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from google.cloud import storage as gcs
from google.oauth2 import service_account

# Each part is buffered in memory (S3 streams aren't seekable, and a seekable
# buffer is required for a safely-retryable GCS upload). Peak memory ~=
# PART_SIZE * MAX_WORKERS, so keep the product well under the Lambda's memory.
PART_SIZE = 64 * 1024 * 1024        # 64 MiB
MAX_WORKERS = 16                    # 16 * 64MiB = ~1 GiB peak buffer
GCS_COMPOSE_MAX = 32               # GCS allows <=32 sources per compose call
PART_RETRIES = 3
PARTS_SUBDIR = ".copyparts"        # temp parts live here, cleaned up after


def _get_gcp_credentials():
    """Load GCP credentials from AWS Secrets Manager."""
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _parse_s3_url(s3_url):
    """Return (bucket, key, region) for both path- and virtual-hosted URLs."""
    parsed = urlparse(s3_url)
    host = parsed.netloc
    path = parsed.path.lstrip("/")
    if host.startswith("s3") and host.endswith(".amazonaws.com"):
        parts = path.split("/", 1)
        s3_bucket = parts[0]
        s3_key = parts[1] if len(parts) > 1 else ""
        region = host.split(".")[1] if host.count(".") >= 3 else None
    else:
        s3_bucket = host.split(".s3")[0]
        s3_key = path
        region = host.split(".s3.")[1].split(".")[0] if ".s3." in host else None
    return s3_bucket, s3_key, region


def _upload_one_part(s3, s3_bucket, s3_key, bucket, part_name, start, end):
    """Fetch a single S3 byte range and upload it as an independent GCS blob.

    The range is held as an immutable bytes object (one copy) so the upload is
    fully retryable. `end` is inclusive (S3 Range semantics).
    """
    length = end - start + 1
    last_err = None
    for attempt in range(1, PART_RETRIES + 1):
        try:
            resp = s3.get_object(
                Bucket=s3_bucket, Key=s3_key, Range=f"bytes={start}-{end}"
            )
            data = resp["Body"].read()
            if len(data) != length:
                raise IOError(
                    f"short read on {part_name}: got {len(data)}, expected {length}"
                )
            bucket.blob(part_name).upload_from_string(data, content_type="video/mp4")
            return part_name
        except Exception as e:  # transient S3/GCS errors -> retry the range
            last_err = e
            print(f"[PART] {part_name} attempt {attempt}/{PART_RETRIES} failed: {e}")
    raise RuntimeError(f"part {part_name} failed after {PART_RETRIES} attempts: {last_err}")


def _compose_iterative(bucket, part_blobs, final_blob, parts_prefix):
    """Compose an arbitrary number of parts into final_blob.

    GCS caps a single compose at 32 sources, so fold in groups of 32 until one
    object remains (composites-of-composites, exactly how gsutil parallel
    composite uploads work). Returns the intermediate blobs created, so the
    caller can delete them.
    """
    intermediates = []
    level = list(part_blobs)
    tmp_idx = 0
    while len(level) > GCS_COMPOSE_MAX:
        next_level = []
        for i in range(0, len(level), GCS_COMPOSE_MAX):
            group = level[i:i + GCS_COMPOSE_MAX]
            if len(group) == 1:
                next_level.append(group[0])
                continue
            comp = bucket.blob(f"{parts_prefix}/_c{tmp_idx}")
            tmp_idx += 1
            comp.compose(group)
            intermediates.append(comp)
            next_level.append(comp)
        level = next_level
    final_blob.content_type = "video/mp4"
    final_blob.compose(level)
    return intermediates


def _plan_ranges(total_size, part_size=PART_SIZE):
    """Split [0, total_size) into contiguous inclusive byte ranges.

    Returns a list of (index, start, end) with end inclusive (S3 Range
    semantics). Ranges are contiguous, gap-free, and cover exactly total_size.
    """
    ranges = []
    start = 0
    idx = 0
    while start < total_size:
        end = min(start + part_size - 1, total_size - 1)
        ranges.append((idx, start, end))
        start = end + 1
        idx += 1
    return ranges


def _delete_quietly(blobs):
    for b in blobs:
        try:
            b.delete()
        except Exception as e:
            print(f"[CLEANUP] could not delete {b.name}: {e}")


def handler(event, context):
    episode_id = event["episode_id"]
    s3_url = event["s3_url"]
    gcs_input_bucket = os.environ["GCS_INPUT_BUCKET"]

    s3_bucket, s3_key, region = _parse_s3_url(s3_url)
    s3 = boto3.client("s3", region_name=region) if region else boto3.client("s3")

    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds, project=os.environ["GCP_PROJECT"])

    # Clear stale output objects from a prior run (unrelated output bucket).
    gcs_output_bucket = os.environ.get("GCS_OUTPUT_BUCKET")
    if gcs_output_bucket:
        out_bucket = gcs_client.bucket(gcs_output_bucket)
        old_blobs = list(out_bucket.list_blobs(prefix=f"{episode_id}/"))
        if old_blobs:
            out_bucket.delete_blobs(old_blobs)
            print(f"[CLEAR] Deleted {len(old_blobs)} stale objects from gs://{gcs_output_bucket}/{episode_id}/")

    bucket = gcs_client.bucket(gcs_input_bucket)
    final_name = f"{episode_id}/source.mp4"
    final_blob = bucket.blob(final_name)

    total_size = s3.head_object(Bucket=s3_bucket, Key=s3_key)["ContentLength"]

    if total_size <= PART_SIZE:
        # Small source: a single stream is already fast enough; skip the
        # parts/compose machinery entirely.
        obj = s3.get_object(Bucket=s3_bucket, Key=s3_key)
        final_blob.upload_from_file(obj["Body"], content_type="video/mp4")
        print(f"[OK] Copied {total_size} bytes (single-stream) → gs://{gcs_input_bucket}/{final_name}")
    else:
        parts_prefix = f"{episode_id}/{PARTS_SUBDIR}"
        # Remove leftover parts from any previous failed run.
        _delete_quietly(list(bucket.list_blobs(prefix=f"{parts_prefix}/")))

        ranges = _plan_ranges(total_size)
        part_names = [f"{parts_prefix}/part_{i:05d}" for i, _, _ in ranges]

        print(f"[COPY] {total_size} bytes → {len(ranges)} parts × {PART_SIZE} "
              f"({MAX_WORKERS} workers) → gs://{gcs_input_bucket}/{final_name}")

        intermediates = []
        try:
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                futures = [
                    pool.submit(
                        _upload_one_part, s3, s3_bucket, s3_key, bucket,
                        part_names[i], s, e
                    )
                    for (i, s, e) in ranges
                ]
                for fut in as_completed(futures):
                    fut.result()  # re-raise any part failure

            # Compose in strict part order (byte order matters).
            part_blobs = [bucket.blob(name) for name in part_names]
            intermediates = _compose_iterative(bucket, part_blobs, final_blob, parts_prefix)
            final_blob.reload()
            if final_blob.size != total_size:
                raise RuntimeError(
                    f"composed size {final_blob.size} != source {total_size}"
                )
            print(f"[OK] Composed {len(ranges)} parts → gs://{gcs_input_bucket}/{final_name}")
        finally:
            _delete_quietly([bucket.blob(n) for n in part_names] + intermediates)

    gcs_uri = f"gs://{gcs_input_bucket}/{final_name}"
    print(f"[OK] Copied s3://{s3_bucket}/{s3_key} → {gcs_uri}")

    if "source_fps" not in event:
        raise ValueError("Missing source_fps in event payload")

    return {
        "episode_id": episode_id,
        "gcs_input_uri": gcs_uri,
        "golden_recipes": event["golden_recipes"],
        "codec": event.get("codec"),
        "source_fps": event["source_fps"],
        "has_audio": event.get("has_audio", True),
    }
