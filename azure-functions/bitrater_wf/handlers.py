"""Run an unchanged orchestrator/<module>.py handler the way Lambda did.

Failures are returned (not raised) as the Lambda error payload
{"errorMessage", "errorType", "stackTrace"}, so orchestrators and /api/invoke
can reproduce SFN catch causes and Lambda FunctionError responses exactly.
"""
import importlib
import traceback

import runtime_config

from .sfn import ERROR_KEY

# Only these modules may be run (activity input and /api/invoke are not free-form).
ALLOWED_MODULES = {
    "search_orchestrator", "aggregator", "mark_lab_failed",
    "gcp_copy_s3_to_gcs", "gcp_transcoder", "gcp_check_status", "gcp_finalize_hls",
    "gcp_create_combined_master", "quality_checker", "resync_subtitles", "resign_playback_urls",
    "gcp_copy_audio_to_gcs", "gcp_audio_transcoder", "gcp_check_audio_status", "list_audio_episodes",
    "url_health_checker",
}

# /api/invoke/<fn> -> module (the dashboard's function keys, see dashboard/lib/invoke.js)
INVOKE_FUNCTIONS = {
    "create-combined-master": "gcp_create_combined_master",
    "quality-checker": "quality_checker",
    "resync-subtitles": "resync_subtitles",
    "resign-playback-urls": "resign_playback_urls",
}


def lambda_error(exc: BaseException) -> dict:
    return {
        "errorMessage": str(exc),
        "errorType": type(exc).__name__,
        "stackTrace": traceback.format_tb(exc.__traceback__),
    }


def run(module: str, event):
    if module not in ALLOWED_MODULES:
        return {ERROR_KEY: {"errorMessage": f"module not allowed: {module}", "errorType": "ValueError", "stackTrace": []}}
    try:
        runtime_config.assert_isolation()  # shadow stamp: refuse before touching anything
        return importlib.import_module(module).handler(event, None)
    except Exception as exc:  # noqa: BLE001 - reported like a Lambda function error
        return {ERROR_KEY: lambda_error(exc)}
