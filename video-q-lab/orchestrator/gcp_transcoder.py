"""
State 2 of GCP-Orchestrator: Build a dual-codec GCP Transcoder JobConfig
from golden_recipes and submit the job.

Produces six video ElementaryStreams (3 H.264 + 3 H.265), one shared audio
stream, six MuxStreams, and two HLS manifests (h264_master / h265_master).
"""

import os
import json
import boto3
import pymongo
from google.cloud.video import transcoder_v1
from google.cloud.video.transcoder_v1 import types
from google.oauth2 import service_account
from google.protobuf import duration_pb2

_GCP_CREDENTIALS_CACHE = None

PORTRAIT_DIMS = {
    "1080p": (1080, 1920),
    "720p":  (720, 1280),
    "480p":  (480, 854),
}

RESOLUTIONS = ["1080p", "720p", "480p"]


def _get_gcp_credentials():
    """Load GCP credentials from AWS Secrets Manager (cached per container instance)."""
    global _GCP_CREDENTIALS_CACHE
    if _GCP_CREDENTIALS_CACHE is not None:
        return _GCP_CREDENTIALS_CACHE
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    _GCP_CREDENTIALS_CACHE = service_account.Credentials.from_service_account_info(info)
    return _GCP_CREDENTIALS_CACHE


def _build_h264_video_stream(res_tag, bitrate_kbps, width, height):
    """H.264 ElementaryStream — exact parity where API allows."""
    return types.ElementaryStream(
        key=f"{res_tag}_h264",
        video_stream=types.VideoStream(
            h264=types.VideoStream.H264CodecSettings(
                width_pixels=width,
                height_pixels=height,
                bitrate_bps=bitrate_kbps * 1000,
                frame_rate=30,
                profile="high",
                preset="slower",
                gop_duration=duration_pb2.Duration(seconds=2),
            ),
        ),
    )


def _build_h265_video_stream(res_tag, bitrate_kbps, width, height):
    """H.265 (HEVC) ElementaryStream — closest approximation."""
    return types.ElementaryStream(
        key=f"{res_tag}_h265",
        video_stream=types.VideoStream(
            h265=types.VideoStream.H265CodecSettings(
                width_pixels=width,
                height_pixels=height,
                bitrate_bps=bitrate_kbps * 1000,
                frame_rate=30,
                profile="main",
                preset="slower",
                gop_duration=duration_pb2.Duration(seconds=2),
            ),
        ),
    )


def _build_job_config(gcs_input_uri, golden_recipes, output_uri):
    """Construct a full GCP Transcoder JobConfig from golden_recipes."""
    resolutions_data = golden_recipes["resolutions"]

    elementary_streams = []
    mux_streams = []
    h264_mux_keys = []
    h265_mux_keys = []

    for res_tag in RESOLUTIONS:
        width, height = PORTRAIT_DIMS[res_tag]
        res_recipes = resolutions_data.get(res_tag, {})

        h264_recipe = res_recipes.get("h264")
        if h264_recipe:
            elementary_streams.append(
                _build_h264_video_stream(res_tag, h264_recipe["bitrate_kbps"], width, height)
            )
            mux_key = f"mux_{res_tag}_h264"
            mux_streams.append(types.MuxStream(
                key=mux_key,
                container="ts",
                elementary_streams=[f"{res_tag}_h264", "audio_aac"],
                segment_settings=types.SegmentSettings(
                    segment_duration=duration_pb2.Duration(seconds=6),
                ),
            ))
            h264_mux_keys.append(mux_key)

        h265_recipe = res_recipes.get("h265")
        if h265_recipe:
            elementary_streams.append(
                _build_h265_video_stream(res_tag, h265_recipe["bitrate_kbps"], width, height)
            )
            mux_key = f"mux_{res_tag}_h265"
            mux_streams.append(types.MuxStream(
                key=mux_key,
                container="ts",
                elementary_streams=[f"{res_tag}_h265", "audio_aac"],
                segment_settings=types.SegmentSettings(
                    segment_duration=duration_pb2.Duration(seconds=6),
                ),
            ))
            h265_mux_keys.append(mux_key)

    audio_stream = types.ElementaryStream(
        key="audio_aac",
        audio_stream=types.AudioStream(
            codec="aac",
            bitrate_bps=128000,
            channel_count=2,
            sample_rate_hertz=48000,
        ),
    )
    elementary_streams.append(audio_stream)

    manifests = [
        types.Manifest(
            file_name="h264_master.m3u8",
            type_=types.Manifest.ManifestType.HLS,
            mux_streams=h264_mux_keys,
        ),
        types.Manifest(
            file_name="h265_master.m3u8",
            type_=types.Manifest.ManifestType.HLS,
            mux_streams=h265_mux_keys,
        ),
    ]

    return types.JobConfig(
        inputs=[types.Input(key="input0", uri=gcs_input_uri)],
        elementary_streams=elementary_streams,
        mux_streams=mux_streams,
        manifests=manifests,
        output=types.Output(uri=output_uri),
    )


def handler(event, context):
    episode_id = event["episode_id"]
    gcs_input_uri = event["gcs_input_uri"]
    golden_recipes = event["golden_recipes"]
    mongo_uri = os.environ["MONGO_URI"]

    gcp_project = os.environ["GCP_PROJECT"]
    gcp_location = os.environ.get("GCP_LOCATION", "us-central1")
    gcs_output_bucket = os.environ["GCS_OUTPUT_BUCKET"]

    output_uri = f"gs://{gcs_output_bucket}/{episode_id}/"

    job_config = _build_job_config(gcs_input_uri, golden_recipes, output_uri)

    creds = _get_gcp_credentials()
    client = transcoder_v1.TranscoderServiceClient(credentials=creds)

    parent = f"projects/{gcp_project}/locations/{gcp_location}"
    job = types.Job(config=job_config)
    response = client.create_job(parent=parent, job=job)
    job_name = response.name

    print(f"[OK] Submitted GCP Transcoder job: {job_name}")

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "gcp_job_status": "RUNNING",
            "gcp_job_name": job_name,
        }},
    )

    return {
        "episode_id": episode_id,
        "gcp_job_name": job_name,
        "golden_recipes": golden_recipes,
        "output_uri": output_uri,
    }
