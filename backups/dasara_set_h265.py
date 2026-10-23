# Set Dasara golden h265 bitrate_kbps = h264 - 100 per resolution.
# Skips episodes with a RUNNING lab; guards each update on the current h264 values.
import os, pymongo

c = pymongo.MongoClient(os.environ["MONGO_URI"], serverSelectionTimeoutMS=15000)
col = c.chai_q_lab.video_episodes
s = c.master.showcache.find_one({"slug": "dasara"}, {"episodes.id": 1, "episodes.episode_number": 1})
for e in sorted(s["episodes"], key=lambda e: e["episode_number"]):
    if not 20 <= e["episode_number"] <= 22:
        continue
    l = col.find_one({"episode_id": e["id"]}, {"golden_recipes": 1, "lab_status_h264": 1, "lab_status_h265": 1})
    if "RUNNING" in (l.get("lab_status_h264"), l.get("lab_status_h265")):
        print(e["episode_number"], "SKIP (lab running)")
        continue
    sets, filt = {}, {"_id": l["_id"]}
    for res, v in l["golden_recipes"]["resolutions"].items():
        h4 = v["h264"]["bitrate_kbps"]
        assert h4 - 100 > 0, (e["episode_number"], res, h4)
        sets[f"golden_recipes.resolutions.{res}.h265.bitrate_kbps"] = h4 - 100
        filt[f"golden_recipes.resolutions.{res}.h264.bitrate_kbps"] = h4
    r = col.update_one(filt, {"$set": sets})
    print(e["episode_number"], "matched", r.matched_count, "modified", r.modified_count,
          {k.split(".")[2]: v for k, v in sets.items()})
