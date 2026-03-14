import pymongo
import os
import json
from datetime import datetime, timezone

VMAF_THRESHOLDS = {
    "1080p": 88,
    "720p":  75,
    "480p":  48,
}

RESOLUTIONS = ["1080p", "720p", "480p"]
CODECS = ["libx265", "libx264"]


def handler(event, context):
    episode_id = event.get("episode_id")
    mongo_uri = os.environ.get("MONGO_URI")

    client = pymongo.MongoClient(mongo_uri)
    db = client.chai_q_lab

    results = list(db.video_vmaf_research.find({"episode_id": episode_id}))

    if not results:
        return {"status": "error", "message": "No research data found."}

    def find_winner(subset, threshold):
        """Lowest bitrate >= threshold, or highest VMAF below threshold."""
        subset = sorted(subset, key=lambda x: x["bitrate_kbps"])
        if not subset:
            return None
        above = [r for r in subset if r["vmaf_score"] >= threshold]
        if above:
            winner = above[0]
        else:
            winner = max(subset, key=lambda x: x["vmaf_score"])
        return {
            "bitrate_kbps": winner["bitrate_kbps"],
            "vmaf_attained": winner["vmaf_score"],
            "params": winner["params"],
        }

    resolutions_data = {}
    efficiency_gain = {}

    for res in RESOLUTIONS:
        threshold = VMAF_THRESHOLDS[res]
        res_results = [r for r in results if r.get("resolution") == res]
        codec_winners = {}

        for codec in CODECS:
            codec_key = "h265" if codec == "libx265" else "h264"
            subset = [r for r in res_results if r["codec"] == codec]
            winner = find_winner(subset, threshold)
            if winner:
                codec_winners[codec_key] = winner

        resolutions_data[res] = codec_winners

        h265_w = codec_winners.get("h265")
        h264_w = codec_winners.get("h264")
        if h265_w and h264_w and h264_w["bitrate_kbps"] > 0:
            gain = round((1 - h265_w["bitrate_kbps"] / h264_w["bitrate_kbps"]) * 100, 2)
            efficiency_gain[res] = f"{gain}%"
        else:
            efficiency_gain[res] = "N/A"

    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "status": "ANALYSIS_COMPLETE",
            "lab_status": "COMPLETE",
            "lab_finished_at": datetime.now(timezone.utc).isoformat(),
            "golden_recipes": {"resolutions": resolutions_data},
            "efficiency_gain": efficiency_gain,
        }},
        upsert=True,
    )

    return {
        "statusCode": 200,
        "episode_id": episode_id,
        "golden_recipes": {"resolutions": resolutions_data},
    }