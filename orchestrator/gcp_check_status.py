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
        error_msg = getattr(job.error, "message", "Unknown error") if job.error else "Unknown error"
        db.video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {
                "gcp_job_status": "FAILED",
                "gcp_error": error_msg,
                "gcp_finished_at": datetime.now(timezone.utc).isoformat(),
            }},
        )

    return {
        "episode_id": episode_id,
        "gcp_job_name": gcp_job_name,
        "gcp_job_state": state,
        "golden_recipes": event["golden_recipes"],
        "output_uri": event["output_uri"],
    }
