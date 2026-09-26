#!/usr/bin/env python3
"""Seed the shadow DBs from prod (Phase B2). Reads prod; writes ONLY *_shadow DBs.

Copies the chosen shows from master.showcache (+ their episodes' chai_q_lab docs)
into master_shadow / chai_q_lab_shadow, and podcast shows into
master_shadow.podcast_showcache (+ chai_q_lab_shadow.audio_episodes).

Usage: MONGO_URI=... python scripts/parity/seed_shadow.py seedset.json [--apply]
  seedset.json: {"show_slugs": [...], "podcast_slugs": [...]}
Without --apply it only reports what it would copy.
"""
import json
import sys

LAB, MASTER = "chai_q_lab", "master"
LAB_SHADOW, MASTER_SHADOW = "chai_q_lab_shadow", "master_shadow"
LAB_COLLECTIONS_BY_EPISODE = ["video_episodes", "video_vmaf_research"]


# Output URLs point at PROD files (cdn.chaishots.in / prod buckets). Shadow copies drop
# them so every shadow URL is produced by a shadow run (resync, QC, resigner, url-health
# then only ever touch shadow output). Source fields (s3_url, audio_url, s3Url) stay.
# Also drop cloud run ids (lab_execution_arn_*, *gcp_execution_arn_*, batch job ids,
# GCP job names): the dashboard routes describe/stop by id, so a copied prod id
# would make shadow call PROD Step Functions/Batch.
OUTPUT_KEYS = ("signed_playback_url", "signed_playback_expires_at", "gcpUrl", "public_master_url", "video_url",
               "batch_job_id", "job_id")
OUTPUT_SUFFIXES = ("_m3u8_url",)
OUTPUT_SUBSTRINGS = ("execution_arn", "gcp_job_name")


class RefuseWrite(RuntimeError):
    pass


def strip_outputs(value):
    if isinstance(value, dict):
        return {k: strip_outputs(v) for k, v in value.items()
                if k not in OUTPUT_KEYS and not k.endswith(OUTPUT_SUFFIXES)
                and not any(sub in k for sub in OUTPUT_SUBSTRINGS)}
    if isinstance(value, list):
        return [strip_outputs(v) for v in value]
    return value


def shadow_db(client, name):
    """The only way this script obtains a writable DB handle."""
    if not name.endswith("_shadow"):
        raise RefuseWrite(f"refusing to write to non-shadow DB {name!r}")
    return client[name]


def plan(client, seed):
    prod_master, prod_lab = client[MASTER], client[LAB]
    shows = list(prod_master.showcache.find({"slug": {"$in": seed.get("show_slugs", [])}}))
    podcasts = list(prod_master.podcast_showcache.find({"slug": {"$in": seed.get("podcast_slugs", [])}}))
    ep_ids = [e["id"] for s in shows for e in s.get("episodes", []) if e.get("id")]
    ep_ids += [f"trailer_{s['_id']}_{t['_key']}" for s in shows for t in s.get("trailers_playback_urls", []) or []]
    audio_ids = [e["id"] for p in podcasts for e in p.get("episodes", []) if e.get("id")]
    lab = {c: list(prod_lab[c].find({"episode_id": {"$in": ep_ids}})) for c in LAB_COLLECTIONS_BY_EPISODE}
    lab["audio_episodes"] = list(prod_lab.audio_episodes.find({"episode_id": {"$in": audio_ids}}))
    return {"showcache": strip_outputs(shows), "podcast_showcache": strip_outputs(podcasts),
            "lab": {c: strip_outputs(docs) for c, docs in lab.items()}}


def apply(client, p):
    m, l = shadow_db(client, MASTER_SHADOW), shadow_db(client, LAB_SHADOW)
    for doc in p["showcache"]:
        m.showcache.replace_one({"_id": doc["_id"]}, doc, upsert=True)
    for doc in p["podcast_showcache"]:
        m.podcast_showcache.replace_one({"_id": doc["_id"]}, doc, upsert=True)
    for coll, docs in p["lab"].items():
        for doc in docs:
            l[coll].replace_one({"_id": doc["_id"]}, doc, upsert=True)


def main(argv):
    import pymongo
    import os
    seed = json.load(open(argv[0]))
    client = pymongo.MongoClient(os.environ["MONGO_URI"], appName="bitrater-seed-shadow")
    p = plan(client, seed)
    print(json.dumps({"showcache": len(p["showcache"]), "podcast_showcache": len(p["podcast_showcache"]),
                      **{f"lab.{k}": len(v) for k, v in p["lab"].items()}}))
    if "--apply" in argv:
        apply(client, p)
        print("seeded into", MASTER_SHADOW, LAB_SHADOW)
    else:
        print("(dry run — re-run with --apply after approval)")


if __name__ == "__main__":
    main(sys.argv[1:])
