"""
State 1 of GCP-Orchestrator: Copy source video from S3 to GCS.

GCP Transcoder requires GCS input. This Lambda streams the source file
from S3 directly to GCS without writing to /tmp to avoid the 512MB limit.
"""

import os
import json
import boto3
from google.cloud import storage as gcs
from google.oauth2 import service_account


def _get_gcp_credentials():
    """Load GCP credentials from AWS Secrets Manager."""
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def handler(event, context):
    episode_id = event["episode_id"]
    s3_url = event["s3_url"]
    gcs_input_bucket = os.environ["GCS_INPUT_BUCKET"]

    from urllib.parse import urlparse
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

    if region:
        s3 = boto3.client("s3", region_name=region)
    else:
        s3 = boto3.client("s3")
    obj = s3.get_object(Bucket=s3_bucket, Key=s3_key)

    creds = _get_gcp_credentials()
    gcs_client = gcs.Client(credentials=creds, project=os.environ["GCP_PROJECT"])
    bucket = gcs_client.bucket(gcs_input_bucket)
    blob = bucket.blob(f"{episode_id}/source.mp4")

    blob.upload_from_file(obj["Body"], content_type="video/mp4")

    gcs_uri = f"gs://{gcs_input_bucket}/{episode_id}/source.mp4"
    print(f"[OK] Copied s3://{s3_bucket}/{s3_key} → {gcs_uri}")

    return {
        "episode_id": episode_id,
        "gcs_input_uri": gcs_uri,
        "golden_recipes": event["golden_recipes"],
    }
