#!/usr/bin/env python3
"""Read-only fingerprint of prod collections (gate B: before == after seeding / shadow runs).

Usage: MONGO_URI=... python scripts/parity/snapshot_prod.py > before.json ; ... ; diff before.json after.json
"""
import hashlib
import json
import os
import sys

TARGETS = {
    "master": ["showcache", "podcast_showcache", "episode_vtt"],
    "chai_q_lab": ["video_episodes", "video_vmaf_research", "audio_episodes", "pipeline_runs",
                   "playback_resign_runs", "url_health_runs"],
}


def fingerprint(client):
    out = {}
    for db, colls in TARGETS.items():
        for c in colls:
            col = client[db][c]
            last = col.find_one({}, sort=[("_id", -1)], projection={"_id": 1})
            out[f"{db}.{c}"] = {"count": col.estimated_document_count(), "max_id": str(last["_id"]) if last else None}
    out["master.showcache.playback_urls_sha256"] = playback_hash(client)
    return out


def playback_hash(client) -> str:
    """Hash of every canonical (query-stripped) playback URL in prod showcache.

    Detects in-place overwrites (the main shadow-leak risk) that count/max_id cannot.
    Query strings are dropped because the AWS resigner legitimately re-signs every 2 h.
    """
    rows = []
    proj = {"episodes.id": 1, "episodes.signed_playback_url": 1, "trailers_playback_urls._key": 1,
            "trailers_playback_urls.gcpUrl": 1}
    for show in client["master"]["showcache"].find({}, proj).sort("_id", 1):
        for ep in show.get("episodes") or []:
            rows.append(f"{ep.get('id')}={(ep.get('signed_playback_url') or '').split('?', 1)[0]}")
        for t in show.get("trailers_playback_urls") or []:
            rows.append(f"{show['_id']}/{t.get('_key')}={(t.get('gcpUrl') or '').split('?', 1)[0]}")
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


if __name__ == "__main__":
    import pymongo
    json.dump(fingerprint(pymongo.MongoClient(os.environ["MONGO_URI"], readPreference="secondaryPreferred")),
              sys.stdout, indent=2, sort_keys=True)
