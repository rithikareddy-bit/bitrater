"""
State 2 of GCP-Orchestrator: Build a codec-specific GCP Transcoder JobConfig
from golden_recipes and submit the job.

When codec=h264: produces only H.264 streams and h264_master.m3u8.
When codec=h265: produces only H.265 streams and h265_master.m3u8.
"""

import os
import json
import boto3
import pymongo
from google.cloud.video import transcoder_v1
from google.cloud.video.transcoder_v1 import types
from google.oauth2 import service_account
from google.protobuf import duration_pb2


PORTRAIT_DIMS = {
    "1080p": (1080, 1920),
    "720p":  (720, 1280),
    "480p":  (480, 854),
}

RESOLUTIONS = ["720p", "480p", "1080p"]

SUPPORTED_FPS = {24, 30}


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _build_h264_video_stream(res_tag, bitrate_kbps, width, height, frame_rate):
    """H.264 ElementaryStream — exact parity where API allows."""
    gop = frame_rate * 2
    return types.ElementaryStream(
        key=f"{res_tag}_h264",
        video_stream=types.VideoStream(
            h264=types.VideoStream.H264CodecSettings(
                width_pixels=width,
                height_pixels=height,
                bitrate_bps=bitrate_kbps * 1000,
                frame_rate=frame_rate,
                profile="high",
                preset="slower",
                tune="film",
                gop_duration=duration_pb2.Duration(seconds=2),
                gop_frame_count=gop,
                enable_two_pass=True,
                vbv_size_bits=bitrate_kbps * 1000 * 3,
                vbv_fullness_bits=int(bitrate_kbps * 1000 * 3 * 0.9),
                aq_strength=1.0,
                b_frame_count=3,
            ),
        ),
    )


def _build_h265_video_stream(res_tag, bitrate_kbps, width, height, frame_rate):
    """H.265 (HEVC) ElementaryStream — closest approximation."""
    gop = frame_rate * 2
    return types.ElementaryStream(
        key=f"{res_tag}_h265",
        video_stream=types.VideoStream(
            h265=types.VideoStream.H265CodecSettings(
                width_pixels=width,
                height_pixels=height,
                bitrate_bps=bitrate_kbps * 1000,
                frame_rate=frame_rate,
                profile="main",
                preset="slower",
                gop_duration=duration_pb2.Duration(seconds=2),
                gop_frame_count=gop,
                enable_two_pass=True,
                vbv_size_bits=bitrate_kbps * 1000 * 3,
                vbv_fullness_bits=int(bitrate_kbps * 1000 * 3 * 0.9),
                aq_strength=1.0,
                b_frame_count=4,
            ),
        ),
    )


def _build_job_config(gcs_input_uri, golden_recipes, output_uri, codec, frame_rate):
    """Construct a GCP Transcoder JobConfig for the requested codec."""
    resolutions_data = golden_recipes["resolutions"]

    elementary_streams = []
    mux_streams = []
    manifests = []

    codec_lower = (codec or "h265").lower()

    if codec_lower == "h264":
        h264_video_mux_keys = []
        h264_audio_mux_key = "mux_h264_audio"
        for res_tag in RESOLUTIONS:
            width, height = PORTRAIT_DIMS[res_tag]
            res_recipes = resolutions_data.get(res_tag, {})
            h264_recipe = res_recipes.get("h264")
            if h264_recipe:
                elementary_streams.append(
                    _build_h264_video_stream(res_tag, h264_recipe["bitrate_kbps"], width, height, frame_rate)
                )
                video_mux_key = f"mux_{res_tag}_h264_video"
                mux_streams.append(types.MuxStream(
                    key=video_mux_key,
                    container="fmp4",
                    elementary_streams=[f"{res_tag}_h264"],
                    segment_settings=types.SegmentSettings(
                        segment_duration=duration_pb2.Duration(seconds=2),
                    ),
                ))
                h264_video_mux_keys.append(video_mux_key)
        mux_streams.append(types.MuxStream(
            key=h264_audio_mux_key,
            container="fmp4",
            elementary_streams=["audio_aac"],
            segment_settings=types.SegmentSettings(
                segment_duration=duration_pb2.Duration(seconds=2),
            ),
        ))
        manifests = [
            types.Manifest(
                file_name="h264_master.m3u8",
                type_=types.Manifest.ManifestType.HLS,
                mux_streams=h264_video_mux_keys + [h264_audio_mux_key],
            ),
        ]

    else:
        h265_mux_keys = []
        h265_audio_mux_key = "mux_h265_audio"
        for res_tag in RESOLUTIONS:
            width, height = PORTRAIT_DIMS[res_tag]
            res_recipes = resolutions_data.get(res_tag, {})
            h265_recipe = res_recipes.get("h265")
            if h265_recipe:
                elementary_streams.append(
                    _build_h265_video_stream(res_tag, h265_recipe["bitrate_kbps"], width, height, frame_rate)
                )
                video_mux_key = f"mux_{res_tag}_h265_video"
                mux_streams.append(types.MuxStream(
                    key=video_mux_key,
                    container="fmp4",
                    elementary_streams=[f"{res_tag}_h265"],
                    segment_settings=types.SegmentSettings(
                        segment_duration=duration_pb2.Duration(seconds=2),
                    ),
                ))
                h265_mux_keys.append(video_mux_key)

        mux_streams.append(types.MuxStream(
            key=h265_audio_mux_key,
            container="fmp4",
            elementary_streams=["audio_aac"],
            segment_settings=types.SegmentSettings(
                segment_duration=duration_pb2.Duration(seconds=2),
            ),
        ))
        manifests = [
            types.Manifest(
                file_name="h265_master.m3u8",
                type_=types.Manifest.ManifestType.HLS,
                mux_streams=h265_mux_keys + [h265_audio_mux_key],
            ),
        ]

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
    codec = event.get("codec", "h265")
    source_fps = event.get("source_fps", 24)
    mongo_uri = os.environ["MONGO_URI"]

    if source_fps not in SUPPORTED_FPS:
        raise ValueError(f"source_fps={source_fps} not supported, must be one of {sorted(SUPPORTED_FPS)}")

    gcp_project = os.environ["GCP_PROJECT"]
    gcp_location = os.environ.get("GCP_LOCATION", "us-central1")
    gcs_output_bucket = os.environ["GCS_OUTPUT_BUCKET"]

    output_uri = f"gs://{gcs_output_bucket}/{episode_id}/"

    job_config = _build_job_config(gcs_input_uri, golden_recipes, output_uri, codec, source_fps)

    creds = _get_gcp_credentials()
    client = transcoder_v1.TranscoderServiceClient(credentials=creds)

    parent = f"projects/{gcp_project}/locations/{gcp_location}"
    job = types.Job(config=job_config)
    response = client.create_job(parent=parent, job=job)
    job_name = response.name

    print(f"[OK] Submitted GCP Transcoder job: {job_name} (codec={codec})")

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    codec_key = f"gcp_job_status_{codec}"
    job_name_key = f"gcp_job_name_{codec}"
    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            codec_key: "RUNNING",
            job_name_key: job_name,
        }},
    )

    return {
        "episode_id": episode_id,
        "gcp_job_name": job_name,
        "golden_recipes": golden_recipes,
        "output_uri": output_uri,
        "codec": codec,
        "source_fps": source_fps,
    }
