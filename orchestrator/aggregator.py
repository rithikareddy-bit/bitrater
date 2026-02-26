import pymongo
import os
import json

def handler(event, context):
    # 'episode_id' is passed from the Step Function input
    episode_id = event.get("episode_id")
    mongo_uri = os.environ.get("MONGO_URI")
    
    client = pymongo.MongoClient(mongo_uri)
    db = client.chai_q_lab
    
    # 1. Fetch all research results for this episode
    results = list(db.video_vmaf_research.find({"episode_id": episode_id}))
    
    if not results:
        return {"status": "error", "message": "No research data found."}

    # 2. Define the 'Premium' Target
    # For OTT vertical mobile, 93.5 is the point where humans stop seeing artifacts
    TARGET_VMAF = 93.5

    def find_winner(codec_name):
        # Filter and sort by bitrate
        subset = sorted(
            [r for r in results if r['codec'] == codec_name], 
            key=lambda x: x['bitrate_kbps']
        )
        if not subset: return None
        
        # Find the lowest bitrate that crosses our VMAF target
        winner = next((r for r in subset if r['vmaf_score'] >= TARGET_VMAF), subset[-1])
        return {
            "bitrate_kbps": winner['bitrate_kbps'],
            "vmaf_attained": winner['vmaf_score'],
            "params": winner['params']
        }

    # 3. Pick winners for both tracks
    h265_recipe = find_winner('libx265')
    h264_recipe = find_winner('libx264')

    # 4. Finalize the Episode Record
    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {"$set": {
            "status": "ANALYSIS_COMPLETE",
            "golden_recipes": {
                "h265": h265_recipe,
                "h264": h264_recipe
            },
            "efficiency_gain": f"{round((1 - (h265_recipe['bitrate_kbps']/h264_recipe['bitrate_kbps']))*100, 2)}%" if h265_recipe and h264_recipe else "0%"
        }},
        upsert=True
    )

    return {
        "statusCode": 200,
        "episode_id": episode_id,
        "h265_target": h265_recipe['bitrate_kbps']
    }