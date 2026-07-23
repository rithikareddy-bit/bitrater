"""
State 4 of GCP-Orchestrator: Poll GCP Transcoder job status.
Returns the current state so the Step Function Choice can decide next action.
"""

import os
import json
import boto3
import pymongo
from datetime import datetime, timezone
from google.cloud.video import transcoder_v1
from google.oauth2 import service_account


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)




# ---------------------------------------------------------------------------
# Audio-Video field namespace
# ---------------------------------------------------------------------------
# Runs started from the /audio-video page write their status and master URLs
# under an `av_` prefix, so a classic Lab/GCP run on the same episode keeps its
# own records.

def _field_prefix(golden_recipes):
    """Field namespace for this run.

    "av_" only when the run was started from the /audio-video page, which marks
    its Step Function payload with `av_run`. NOT derived from the ladder: the
    show pipeline and the episode page must keep writing the classic fields for
    every episode — including one that happens to have an Audio-Video ladder
    saved — or their polling of gcp_job_status_* would never see completion.
    """
    return "av_" if (golden_recipes or {}).get("av_run") is True else ""


def handler(event, context):
    gcp_job_name = event["gcp_job_name"]
    episode_id = event["episode_id"]

    creds = _get_gcp_credentials()
    client = transcoder_v1.TranscoderServiceClient(credentials=creds)

    job = client.get_job(name=gcp_job_name)
    state = transcoder_v1.Job.ProcessingState(job.state).name

    print(f"[CHECK] Job {gcp_job_name} state: {state}")

    if state == "FAILED":
        mongo_uri = os.environ["MONGO_URI"]
        db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
        codec = event.get("codec", "h265")
        pfx = _field_prefix(event.get("golden_recipes"))
        status_key = f"{pfx}gcp_job_status_{codec}"
        error_key = f"{pfx}gcp_error_{codec}"
        finished_key = f"{pfx}gcp_finished_at_{codec}"
        error_msg = getattr(job.error, "message", "Unknown error") if job.error else "Unknown error"
        db.video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {
                status_key: "FAILED",
                error_key: error_msg,
                finished_key: datetime.now(timezone.utc).isoformat(),
            }},
        )

    return {
        "episode_id": episode_id,
        "gcp_job_name": gcp_job_name,
        "gcp_job_state": state,
        "golden_recipes": event["golden_recipes"],
        "output_uri": event["output_uri"],
        "codec": event.get("codec"),
    }
