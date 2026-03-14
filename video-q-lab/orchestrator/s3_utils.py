"""Shared S3 URL parser used by orchestrator Lambdas."""

from urllib.parse import urlparse
import boto3


def parse_s3_url(s3_url):
    """
    Parse an S3 URL (https virtual-hosted, https path-style, or s3://) into
    (bucket, key, region).  region may be None if not derivable from the URL.
    """
    parsed = urlparse(s3_url)
    if parsed.scheme == "s3":
        bucket = parsed.netloc
        key = parsed.path.lstrip("/")
        return bucket, key, None

    host = parsed.netloc
    path = parsed.path.lstrip("/")
    if host.startswith("s3") and host.endswith(".amazonaws.com"):
        # Path-style: https://s3.region.amazonaws.com/bucket/key
        parts = path.split("/", 1)
        bucket = parts[0]
        key = parts[1] if len(parts) > 1 else ""
        region = host.split(".")[1] if host.count(".") >= 3 else None
    else:
        # Virtual-hosted: https://bucket.s3.region.amazonaws.com/key
        bucket = host.split(".s3")[0]
        key = path
        region = host.split(".s3.")[1].split(".")[0] if ".s3." in host else None
    return bucket, key, region


def s3_client_for(region=None):
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")
