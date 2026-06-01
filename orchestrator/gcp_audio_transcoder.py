"""
Audio State 2: Build an audio-only GCP Transcoder JobConfig and submit it.

Produces a single HE-AAC HLS rendition (64k, capped by the copy step's `ladder`) with
fMP4 segments + one HLS master, written to:
    gs://${GCS_OUTPUT_BUCKET}/output/${episode_id}/

Loudness normalization is done by the Transcoder itself via the per-input
PreprocessingConfig.Audio.lufs setting (target AUDIO_LOUDNESS_LUFS, default -16) — so
there is NO separate ffmpeg normalize step. Reads the raw source.<ext> directly.
No video, no FPS/GOP alignment, no golden_recipes (audio segments are duration-based).
"""

import os
import json

import boto3
import pymongo
from google.cloud.video import transcoder_v1
from google.cloud.video.transcoder_v1 import types
from google.oauth2 import service_account
from google.protobuf import duration_pb2


# BCP-47 normalization is in the shared lang_codes module — no top-level env reads,
# so it's safe to import from any Lambda. Wraps `normalize_lang_code` to return
# the HLS-spec 'und' for empty/unknown instead of 'xx' (which the shared helper uses
# as its sentinel for "no input given").
from lang_codes import normalize_lang_code as _shared_normalize_lang_code


def _normalize_lang_code(source_language: str) -> str:
    code = _shared_normalize_lang_code(source_language)
    return "und" if code == "xx" or not code else code


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _build_job_config(gcs_input_uri, output_uri, ladder, segment_seconds, lufs, lang_code):
    """Audio-only HLS JobConfig: one AAC-LC elementary stream + fMP4 mux per rung,
    all listed in a single HLS master. Loudness normalized to `lufs` on the input.
    `lang_code` is a BCP-47 2-letter code stamped on every AudioStream so the HLS
    EXT-X-MEDIA tag carries the right LANGUAGE attribute (not the default 'und')."""
    elementary_streams = []
    mux_streams = []

    seg = duration_pb2.Duration(seconds=segment_seconds)

    for kbps in ladder:
        # Distinct keys: elementary (es_*) must not collide with mux keys, which double
        # as the output media-playlist filenames (audio_64k.m3u8, ...). Mirrors the video
        # pipeline's separation (audio_aac elementary vs mux_h264_audio mux).
        es_key = f"es_audio_{kbps}k"
        mux_key = f"audio_{kbps}k"
        # Single 64k rung → HE-AAC v1 (mp4a.40.5). ViSQOL-confirmed on a clean WAV source: at
        # 64k HE-AAC beats AAC-LC (4.689 vs 4.629 — SBR helps at low bitrate). The <=64
        # condition is kept so AAC-LC (mp4a.40.2) is still picked automatically if the ladder
        # is ever widened above 64k.
        codec = "aac-he" if kbps <= 64 else "aac"
        elementary_streams.append(
            types.ElementaryStream(
                key=es_key,
                audio_stream=types.AudioStream(
                    codec=codec,
                    bitrate_bps=kbps * 1000,
                    channel_count=2,
                    sample_rate_hertz=48000,
                    language_code=lang_code,
                    display_name=f"Audio {kbps}k",
                ),
            )
        )
        mux_streams.append(
            types.MuxStream(
                key=mux_key,
                container="fmp4",
                elementary_streams=[es_key],
                segment_settings=types.SegmentSettings(segment_duration=seg),
            )
        )

    manifests = [
        types.Manifest(
            file_name="audio_master.m3u8",
            type_=types.Manifest.ManifestType.HLS,
            mux_streams=[f"audio_{kbps}k" for kbps in ladder],
        )
    ]

    return types.JobConfig(
        inputs=[types.Input(
            key="input0",
            uri=gcs_input_uri,
            # GCP Transcoder does the loudness normalization (LUFS) here — no separate
            # ffmpeg step. Range -24..0; -16 = podcast/spoken-word target.
            preprocessing_config=types.PreprocessingConfig(
                audio=types.PreprocessingConfig.Audio(lufs=lufs),
            ),
        )],
        elementary_streams=elementary_streams,
        mux_streams=mux_streams,
        manifests=manifests,
        output=types.Output(uri=output_uri),
    )


def _stamp_failed(episode_id, message):
    """Best-effort: mark the audio_episodes row FAILED so the dashboard doesn't
    leave it stuck at the prior status (COPYING/RUNNING). Swallows its own errors
    so the caller's re-raise still surfaces the real failure to Step Functions."""
    try:
        pymongo.MongoClient(os.environ["MONGO_URI"])["chai_q_lab"].audio_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {"gcp_job_status": "FAILED", "gcp_error": message}},
            upsert=True,
        )
    except Exception as e:
        print(f"[WARN] _stamp_failed itself errored: {e}")


def handler(event, context):
    episode_id = event["episode_id"]
    # Wrap the whole handler so any pre-create_job failure (creds fetch, Mongo lookup,
    # config build) also stamps FAILED instead of leaving the row at COPYING. The narrow
    # create_job try/except inside is redundant but kept for the more specific error
    # message; the outer except is the safety net.
    try:
        gcs_input_uri = event["gcs_input_uri"]  # raw source.<ext>
        # Static ladder from env (no ffmpeg/ffprobe probe). All-GCP: Transcoder encodes these
        # rungs and normalizes loudness via lufs. (No per-source upsample-cap for now.)
        ladder = event.get("ladder") or [
            int(x) for x in os.environ.get("AUDIO_LADDER_KBPS", "64").split(",") if x.strip()
        ]

        gcp_project = os.environ["GCP_PROJECT"]
        gcp_location = os.environ.get("GCP_LOCATION", "asia-south1")
        gcs_output_bucket = os.environ["GCS_OUTPUT_BUCKET"]
        segment_seconds = int(os.environ.get("AUDIO_SEGMENT_SECONDS", "6"))
        lufs = float(os.environ.get("AUDIO_LOUDNESS_LUFS", "-16"))

        output_uri = f"gs://{gcs_output_bucket}/output/{episode_id}/"

        # Look up the show's source language from podcast_showcache (top-level `language`
        # on the show doc containing this episode). Normalized to BCP-47 (e.g. 'kn').
        # Falls back to 'und' if the show/language isn't found — HLS spec-valid default.
        mongo_uri = os.environ["MONGO_URI"]
        mclient = pymongo.MongoClient(mongo_uri)
        show_doc = mclient["master"]["podcast_showcache"].find_one(
            {"episodes.id": episode_id},
            {"language": 1},
        )
        lang_code = _normalize_lang_code((show_doc or {}).get("language") or "")

        job_config = _build_job_config(
            gcs_input_uri, output_uri, ladder, segment_seconds, lufs, lang_code
        )

        creds = _get_gcp_credentials()
        client = transcoder_v1.TranscoderServiceClient(credentials=creds)
        parent = f"projects/{gcp_project}/locations/{gcp_location}"
        try:
            response = client.create_job(parent=parent, job=types.Job(config=job_config))
        except Exception as e:
            print(f"[ERROR] create_job failed for {episode_id}: {e}")
            _stamp_failed(episode_id, f"create_job: {e}")
            raise
        job_name = response.name
    except Exception as e:
        # Outer safety net for everything other than create_job (creds fetch, Mongo
        # lookup, config build, env parse). Skip restamping if the inner create_job
        # except already stamped (its message starts with "create_job:").
        if "create_job:" not in str(e):
            _stamp_failed(episode_id, f"submit: {e}")
        raise

    print(f"[OK] Submitted audio Transcoder job: {job_name} (ladder={ladder})")

    mclient["chai_q_lab"].audio_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "gcp_job_status": "RUNNING",
            "gcp_job_name": job_name,
            "ladder": ladder,
            "lufs": lufs,
            "language_code": lang_code,
        }},
        upsert=True,
    )

    return {
        "episode_id": episode_id,
        "gcp_job_name": job_name,
        "output_uri": output_uri,
        "ladder": ladder,
    }
