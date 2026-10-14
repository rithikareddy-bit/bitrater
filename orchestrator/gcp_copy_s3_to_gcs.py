"""
State 1 of GCP-Orchestrator: Copy source video from S3 (or a direct HTTP(S)
origin, e.g. Azure Blob) to GCS.

GCP Transcoder requires GCS input. The source usually lives in S3 (us-east-1)
but the GCS buckets live in asia-south1 (Mumbai). A single serial upload
stream over that ~200ms transcontinental RTT is TCP-window-limited (throughput
~= window / RTT) regardless of Lambda bandwidth, so large sources couldn't
finish inside the 900s Lambda ceiling.

Fix: transfer the source in PARALLEL. Split it into fixed-size byte ranges,
run up to MAX_WORKERS concurrent range -> GCS-part uploads, then GCS-compose
the parts into the final source.mp4. Many streams defeat the single-window
limit; aggregate throughput is capped only by the Lambda's (memory-scaled)
network allocation. Small sources take a simple single-shot path to avoid the
compose overhead.

Some `s3_url` values are not actually S3 (e.g. Sanity dev-store episodes
uploaded to Azure Blob Storage). Those are public, range-capable HTTPS
origins, so a plain `urllib` HEAD/ranged-GET fetcher covers them without any
new credentials — only the byte-fetching layer differs; ranging, retries,
parallelism, and GCS compose are identical for both sources. See `_S3Source`
and `_HttpSource` below.
"""

import io
import os
import json
import urllib.request
import boto3
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, unquote
from google.cloud import storage as gcs
from google.oauth2 import service_account
import secret_store

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
    info = secret_store.get_json(secret_arn)
    return service_account.Credentials.from_service_account_info(info)


class _S3Source:
    """Fetches ranges from a private S3 object via the S3 API (SigV4 auth)."""

    def __init__(self, bucket, key, region):
        self.bucket = bucket
        self.key = key
        self.client = boto3.client("s3", region_name=region) if region else boto3.client("s3")
        self.label = f"s3://{bucket}/{key}"

    def content_length(self):
        return self.client.head_object(Bucket=self.bucket, Key=self.key)["ContentLength"]

    def get_range(self, start, end):
        """Inclusive [start, end], S3 Range semantics."""
        resp = self.client.get_object(
            Bucket=self.bucket, Key=self.key, Range=f"bytes={start}-{end}"
        )
        return resp["Body"].read()

    def open_stream(self):
        return self.client.get_object(Bucket=self.bucket, Key=self.key)["Body"]


class _HttpSource:
    """Fetches ranges from a direct, range-capable HTTPS origin (no auth) --
    e.g. Azure Blob Storage. Same Range-header semantics as S3: [start, end]
    inclusive, so no other call site needs to know which source it's talking to.
    """

    def __init__(self, url):
        self.url = url
        self.label = url

    def content_length(self):
        req = urllib.request.Request(self.url, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as resp:
            length = resp.getheader("Content-Length")
            if length is None:
                raise IOError(f"no Content-Length header from {self.url}")
            return int(length)

    def get_range(self, start, end):
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status not in (200, 206):
                raise IOError(f"unexpected status {resp.status} fetching range from {self.url}")
            return resp.read()

    def open_stream(self):
        # GCS's resumable upload calls stream.tell() up front to check
        # position (it supports resuming a partial upload). A raw
        # http.client.HTTPResponse has no tell()/seek() -- only botocore's
        # StreamingBody (used by _S3Source) happens to support that. Buffer
        # into BytesIO instead; this path is only used below PART_SIZE
        # (64 MiB), consistent with the in-memory part buffers used elsewhere
        # in this module.
        with urllib.request.urlopen(self.url, timeout=60) as resp:
            return io.BytesIO(resp.read())


def _parse_source_url(s3_url):
    """Classify `s3_url` and return a fetcher exposing content_length()/
    get_range()/open_stream(). S3 URLs (path- or virtual-hosted style) get a
    real S3 client; everything else is treated as a direct HTTPS origin (e.g.
    Azure Blob) and fetched with plain ranged HTTP -- same interface, so the
    copy logic below never branches on provider.
    """
    s3_url = s3_url.strip()
    parsed = urlparse(s3_url)
    host = parsed.hostname or ""
    # S3 keys are stored URL-encoded in some records ("Ep%20-%207"); the S3 API
    # wants the literal key. _HttpSource keeps the URL as-is.
    path = unquote(parsed.path.lstrip("/"))

    if parsed.scheme == "s3":
        # s3://bucket/key (orchestrator/lambda_trigger.py)
        return _S3Source(parsed.netloc, path, None)

    if host.startswith("s3") and host.endswith(".amazonaws.com"):
        parts = path.split("/", 1)
        bucket = parts[0]
        key = parts[1] if len(parts) > 1 else ""
        region = host.split(".")[1] if host.count(".") >= 3 else None
        return _S3Source(bucket, key, region)

    if host.endswith(".amazonaws.com") and ".s3" in host:
        bucket = host.split(".s3")[0]
        region = host.split(".s3.")[1].split(".")[0] if ".s3." in host else None
        return _S3Source(bucket, path, region)

    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"unsupported source url scheme: {parsed.scheme!r} ({s3_url})")
    return _HttpSource(s3_url)


def _upload_one_part(source, bucket, part_name, start, end):
    """Fetch a single byte range from `source` and upload it as an
    independent GCS blob.

    The range is held as an immutable bytes object (one copy) so the upload is
    fully retryable. `end` is inclusive.
    """
    length = end - start + 1
    last_err = None
    for attempt in range(1, PART_RETRIES + 1):
        try:
            data = source.get_range(start, end)
            if len(data) != length:
                raise IOError(
                    f"short read on {part_name}: got {len(data)}, expected {length}"
                )
            bucket.blob(part_name).upload_from_string(data, content_type="video/mp4")
            return part_name
        except Exception as e:  # transient source/GCS errors -> retry the range
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

    source = _parse_source_url(s3_url)

    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds, project=os.environ["GCP_PROJECT"])

    # H.264 and H.265 runs of one episode execute in parallel, so everything
    # this step touches is scoped to the run's codec: clearing the whole
    # episode would delete the other codec's in-flight transcoder output, and
    # a shared parts dir / source object lets one run delete or replace the
    # other's (404 on compose). Transcoder output names always contain the
    # codec (finalize filters on it too). No codec → legacy shared names.
    codec = event.get("codec")
    run_tag = f"_{codec}" if codec else ""

    # Clear stale output objects from a prior run (unrelated output bucket).
    gcs_output_bucket = os.environ.get("GCS_OUTPUT_BUCKET")
    if gcs_output_bucket:
        out_bucket = gcs_client.bucket(gcs_output_bucket)
        old_blobs = [
            b for b in out_bucket.list_blobs(prefix=f"{episode_id}/")
            if not codec or codec in b.name
        ]
        if old_blobs:
            out_bucket.delete_blobs(old_blobs)
            print(f"[CLEAR] Deleted {len(old_blobs)} stale objects from gs://{gcs_output_bucket}/{episode_id}/")

    bucket = gcs_client.bucket(gcs_input_bucket)
    final_name = f"{episode_id}/source{run_tag}.mp4"
    final_blob = bucket.blob(final_name)

    total_size = source.content_length()

    if total_size <= PART_SIZE:
        # Small source: a single stream is already fast enough; skip the
        # parts/compose machinery entirely.
        final_blob.upload_from_file(source.open_stream(), content_type="video/mp4")
        print(f"[OK] Copied {total_size} bytes (single-stream) → gs://{gcs_input_bucket}/{final_name}")
    else:
        parts_prefix = f"{episode_id}/{PARTS_SUBDIR}" + (f"/{codec}" if codec else "")
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
                        _upload_one_part, source, bucket,
                        part_names[i], start, end
                    )
                    for (i, start, end) in ranges
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
    print(f"[OK] Copied {source.label} → {gcs_uri}")

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
