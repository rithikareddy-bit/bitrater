"""Called from Step Function Catch when Map or aggregator fails — unblocks /api/push retries."""
import os
import pymongo


def handler(event, context):
    episode_id = event.get("episode_id")
    if not episode_id:
        return {"ok": False, "error": "missing episode_id"}

    cause = event.get("cause") or event.get("error") or "Lab pipeline failed"
    if isinstance(cause, str) and len(cause) > 2000:
        cause = cause[:2000] + "…"

    codec = event.get("codec")
    mongo_uri = os.environ.get("MONGO_URI")
    if not mongo_uri:
        return {"ok": False, "error": "MONGO_URI not set"}

    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    if codec in ("h264", "h265"):
        status_key = f"lab_status_{codec}"
        error_key = f"lab_error_{codec}"
        progress_key = f"search_progress_{codec}"
        db.video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {status_key: "FAILED", error_key: str(cause)}},
            upsert=True,
        )
    else:
        db.video_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {"lab_status": "FAILED", "lab_error": str(cause)}},
            upsert=True,
        )
    return {"ok": True, "episode_id": episode_id}
