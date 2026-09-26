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
import runtime_config
import secret_store


def _get_gcp_credentials():
    secret_arn = os.environ["GCP_CREDENTIALS_SECRET_ARN"]
    info = secret_store.get_json(secret_arn)
    return service_account.Credentials.from_service_account_info(info)


def _publish_to_public_bucket(creds, episode_id):
    """Copy gs://${GCS_OUTPUT_BUCKET}/output/<id>/* → gs://${AUDIO_PUBLIC_BUCKET}/<id>/*
    and return the public master playlist URL. The public bucket is renditions-only
    (no source masters) and world-readable, so the URL opens in a browser."""
    out_bucket = os.environ.get("AUDIO_GCS_BUCKET") or os.environ["GCS_OUTPUT_BUCKET"]  # AUDIO_GCS_BUCKET: Azure runs audio + video in one app (shared GCS_* names)
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


# Media CDN origin bucket (serves cdn.chaishots.in). Hardcoded, mirroring the video pipeline
# (gcp_finalize_hls.CDN_BUCKET). Audio is delivered UNSIGNED via the CDN's `/hls/` route
# (signedRequestMode=DISABLED), so renditions go under `hls/audio/<id>/<ts>/` — a versioned,
# `/hls/`-prefixed (=unsigned) path. No signing, no URL rewriting (audio masters use relative URIs).
CDN_BUCKET = runtime_config.CDN_BUCKET


def _publish_to_cdn(creds, episode_id, ts):
    """Copy the SUBTITLED rendition set from the public bucket into a versioned CDN folder on
    chai-shots-manifests, and return the unsigned CDN playback URL.

    Sources from AUDIO_PUBLIC_BUCKET (NOT the output bucket) on purpose: the subtitle files and
    the subtitle-patched master only exist in the public bucket (audio_subtitle_publish patches
    the public copy). Copying from `output/` would drop subtitles. The `<ts>` version folder means
    re-transcodes never collide with cached segments (same approach as gcp_finalize_hls)."""
    pub_bucket = os.environ["AUDIO_PUBLIC_BUCKET"]
    cdn_base = os.environ["CDN_BASE"].rstrip("/")
    client = gcs.Client(credentials=creds, project=os.environ["GCP_PROJECT"])
    src = client.bucket(pub_bucket)
    dst = client.bucket(CDN_BUCKET)
    src_prefix = f"{episode_id}/"
    dst_prefix = f"hls/audio/{episode_id}/{ts}/"
    n = 0
    for blob in src.list_blobs(prefix=src_prefix):
        name = blob.name[len(src_prefix):]                 # strip "<id>/"
        if not name:
            continue
        new_name = f"{dst_prefix}{name}"
        dst_blob = src.copy_blob(blob, dst, new_name=new_name)
        dst_blob.reload()
        if dst_blob.size != blob.size:                     # partial-copy guard (like video finalize)
            raise RuntimeError(
                f"Partial CDN copy: {blob.name} expected {blob.size} bytes, got {dst_blob.size}"
            )
        # Manifests must stay fresh; segments/VTTs are immutable within a versioned <ts> folder.
        dst_blob.cache_control = "public, max-age=2592000"
        dst_blob.patch()
        n += 1
    print(f"[CDN] copied {n} objects → gs://{CDN_BUCKET}/{dst_prefix}")
    return f"{cdn_base}/hls/audio/{episode_id}/{ts}/audio_master.m3u8"


def _stamp_failed(episode_id, message):
    """Best-effort: mark the row FAILED so the dashboard doesn't show a ghost
    RUNNING when the poll itself crashed. Mirrors the helper in the transcoder."""
    try:
        from datetime import datetime, timezone as _tz
        pymongo.MongoClient(os.environ["MONGO_URI"])[runtime_config.DB_LAB].audio_episodes.update_one(
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
        db = pymongo.MongoClient(os.environ["MONGO_URI"])[runtime_config.DB_LAB]
        now = datetime.now(timezone.utc).isoformat()
        if state == "SUCCEEDED":
            fields = {
                "gcp_job_status": "SUCCEEDED",
                "gcp_finished_at": now,
                "output_uri": event.get("output_uri"),
            }
            try:
                gcs_url = _publish_to_public_bucket(creds, episode_id)
                fields["gcs_master_url"] = gcs_url          # public-bucket URL (fallback / debug)
                fields["public_master_url"] = gcs_url        # default; repointed to the CDN URL below
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

                # CDN delivery: copy the (now subtitled) public set into a versioned, /hls/-prefixed
                # CDN folder and repoint public_master_url to the UNSIGNED CDN URL. Best-effort: on
                # failure, public_master_url stays at the public-bucket URL (still playable), and we
                # record cdn_publish_error. Runs AFTER subtitles so the patched master is included.
                try:
                    ts = datetime.now(timezone.utc).strftime("%d%m%Y_%H%M%S")
                    fields["public_master_url"] = _publish_to_cdn(creds, episode_id, ts)
                    fields["cdn_ts"] = ts
                except Exception as e:
                    print(f"[WARN] CDN publish failed for {episode_id}: {e}")
                    fields["cdn_publish_error"] = str(e)

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
