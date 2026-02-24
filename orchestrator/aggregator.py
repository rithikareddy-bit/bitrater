import pymongo
import os

def handler(event, context):
    episode_id = event.get("episode_id")
    client = pymongo.MongoClient(os.environ["MONGO_URI"])
    db = client.chai_q_lab
    
    # Target VMAF for "Premium" mobile experience
    TARGET_VMAF = 93.5
    
    results = list(db.vmaf_research.find({"episode_id": episode_id}))
    
    def find_best(codec):
        codec_results = sorted([r for r in results if r['codec'] == codec], key=lambda x: x['bitrate_kbps'])
        # Find the lowest bitrate that meets the target
        winner = next((r for r in codec_results if r['vmaf_score'] >= TARGET_VMAF), codec_results[-1])
        return winner

    h265_gold = find_best('libx265')
    h264_gold = find_best('libx264')

    db.episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "status": "READY",
            "golden_configs": {
                "h265": h265_gold,
                "h264": h264_gold
            }
        }},
        upsert=True
    )
    
    return {"status": "success", "episode_id": episode_id}