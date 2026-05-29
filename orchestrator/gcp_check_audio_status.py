"""
Audio State 4: Poll the audio GCP Transcoder job and report state to the Choice.

On SUCCEEDED: copy the renditions from the private output bucket into the public preview
bucket (AUDIO_PUBLIC_BUCKET) and stamp audio_episodes with status + output_uri +
public_master_url (a browser-openable https://storage.googleapis.com/... URL).
On FAILED: stamp the error.
"""

import os
import json
from datetime import datetime, timezone

import boto3
import pymongo
from google.cloud import storage as gcs
from google.cloud.video import transcoder_v1
from google.oauth2 import service_account


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = sm.get_secret_value(SecretId=secret_arn)
    info = json.loads(secret["SecretString"])
    return service_account.Credentials.from_service_account_info(info)


def _publish_to_public_bucket(creds, episode_id):
    """Copy gs://${GCS_OUTPUT_BUCKET}/output/<id>/* → gs://${AUDIO_PUBLIC_BUCKET}/<id>/*
    and return the public master playlist URL. The public bucket is renditions-only
    (no source masters) and world-readable, so the URL opens in a browser."""
    out_bucket = os.environ["GCS_OUTPUT_BUCKET"]
    pub_bucket = os.environ["AUDIO_PUBLIC_BUCKET"]
    client = gcs.Client(credentials=creds, project=os.environ["GCP_PROJECT"])
    src = client.bucket(out_bucket)
    dst = client.bucket(pub_bucket)
    prefix = f"output/{episode_id}/"
    n = 0
    for blob in src.list_blobs(prefix=prefix):
        name = blob.name[len(prefix):]                 # strip "output/<id>/"
        if not name:
            continue
        src.copy_blob(blob, dst, new_name=f"{episode_id}/{name}")
        n += 1
    print(f"[PUBLISH] copied {n} objects → gs://{pub_bucket}/{episode_id}/")
    return f"https://storage.googleapis.com/{pub_bucket}/{episode_id}/audio_master.m3u8"


def _stamp_failed(episode_id, message):
    """Best-effort: mark the row FAILED so the dashboard doesn't show a ghost
    RUNNING when the poll itself crashed. Mirrors the helper in the transcoder."""
    try:
        from datetime import datetime, timezone as _tz
        pymongo.MongoClient(os.environ["MONGO_URI"])["chai_q_lab"].audio_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {
                "gcp_job_status": "FAILED",
                "gcp_error": message,
                "gcp_finished_at": datetime.now(_tz.utc).isoformat(),
            }},
            upsert=True,
        )
    except Exception as e:
        print(f"[WARN] _stamp_failed itself errored: {e}")


def handler(event, context):
    gcp_job_name = event["gcp_job_name"]
    episode_id = event["episode_id"]

    # If creds fetch or get_job throws, stamp FAILED so the row doesn't stay RUNNING
    # forever (SF Catch routes to JobFailed but doesn't touch Mongo).
    try:
        creds = _get_gcp_credentials()
        client = transcoder_v1.TranscoderServiceClient(credentials=creds)
        job = client.get_job(name=gcp_job_name)
        state = transcoder_v1.Job.ProcessingState(job.state).name
    except Exception as e:
        print(f"[ERROR] get_job failed for {episode_id}: {e}")
        _stamp_failed(episode_id, f"check: {e}")
        raise

    print(f"[CHECK] Audio job {gcp_job_name} state: {state}")

    if state in ("SUCCEEDED", "FAILED"):
        db = pymongo.MongoClient(os.environ["MONGO_URI"])["chai_q_lab"]
        now = datetime.now(timezone.utc).isoformat()
        if state == "SUCCEEDED":
            fields = {
                "gcp_job_status": "SUCCEEDED",
                "gcp_finished_at": now,
                "output_uri": event.get("output_uri"),
            }
            try:
                fields["public_master_url"] = _publish_to_public_bucket(creds, episode_id)
            except Exception as e:  # publish is best-effort; don't fail the job over it
                print(f"[WARN] public publish failed: {e}")
                fields["publish_error"] = str(e)

            # Subtitles: best-effort. Run only if the rendition copy succeeded,
            # otherwise audio_master.m3u8 isn't in the public bucket yet to patch.
            if "public_master_url" in fields:
                try:
                    from audio_subtitle_publish import publish_subtitles
                    fields.update(publish_subtitles(creds, episode_id))
                except Exception as e:
                    print(f"[WARN] subtitle publish failed for {episode_id}: {e}")
                    fields["subtitle_publish_error"] = str(e)

            db.audio_episodes.update_one({"episode_id": episode_id}, {"$set": fields})
        else:
            error_msg = getattr(job.error, "message", "Unknown error") if job.error else "Unknown error"
            db.audio_episodes.update_one(
                {"episode_id": episode_id},
                {"$set": {
                    "gcp_job_status": "FAILED",
                    "gcp_error": error_msg,
                    "gcp_finished_at": now,
                }},
            )

    return {
        "episode_id": episode_id,
        "gcp_job_name": gcp_job_name,
        "gcp_job_state": state,
        "output_uri": event.get("output_uri"),
        "ladder": event.get("ladder"),
    }
