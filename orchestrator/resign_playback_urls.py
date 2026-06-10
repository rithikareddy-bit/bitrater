"""Sync canonical CDN URLs into showcache (signing removed).

Two invocation modes (one handler):
  event == {}                              → full sweep of master.showcache
  event == {"episode_id", "canonical_url"} → update one episode/trailer (from sync route)
"""

import os
import re

import boto3
import pymongo
from bson import ObjectId
from datetime import datetime, timezone


CDN_BASE = os.environ["CDN_BASE"]
COMBINED_MARKER = "_combined.m3u8"
TRAILER_ID_RE = re.compile(r"^trailer_([a-f0-9]{24})_(.+)$")
MAX_WORKERS = 64


def _write_showcache(mongo_client, episode_id: str, url: str) -> bool:
    """Write canonical URL into master.showcache. Returns True iff a document matched."""
    master = mongo_client["master"]["showcache"]

    trailer_match = TRAILER_ID_RE.match(episode_id)
    if trailer_match:
        show_id_hex, trailer_key = trailer_match.group(1), trailer_match.group(2)
        result = master.update_one(
            {"_id": ObjectId(show_id_hex)},
            {"$set": {"trailers_playback_urls.$[t].gcpUrl": url},
             "$unset": {"trailers_playback_urls.$[t].signed_playback_expires_at": ""}},
            array_filters=[{"t._key": trailer_key}],
        )
    else:
        result = master.update_one(
            {"episodes.id": episode_id},
            {"$set": {"episodes.$[ep].signed_playback_url": url},
             "$unset": {"episodes.$[ep].signed_playback_expires_at": ""}},
            array_filters=[{"ep.id": episode_id}],
        )
    return result.matched_count > 0


def _collect_sweep_targets(mongo_client) -> list:
    showcache = mongo_client["master"]["showcache"]
    targets = []
    cursor = showcache.find(
        {},
        {"_id": 1, "episodes.id": 1, "episodes.signed_playback_url": 1,
         "trailers_playback_urls._key": 1, "trailers_playback_urls.gcpUrl": 1},
    )
    for show in cursor:
        for ep in show.get("episodes") or []:
            url = ep.get("signed_playback_url")
            if url and COMBINED_MARKER in url:
                targets.append({
                    "episode_id": ep["id"],
                    "canonical": url.split("?", 1)[0],
                })
        for t in show.get("trailers_playback_urls") or []:
            url = t.get("gcpUrl")
            if url and COMBINED_MARKER in url:
                targets.append({
                    "episode_id": f"trailer_{show['_id']}_{t['_key']}",
                    "canonical": url.split("?", 1)[0],
                })
    return targets


def handler(event, context):
    mongo_client = pymongo.MongoClient(os.environ["MONGO_URI"])

    try:
        if event and event.get("episode_id"):
            canonical = event["canonical_url"].split("?", 1)[0]
            _write_showcache(mongo_client, event["episode_id"], canonical)
            return {"episode_id": event["episode_id"], "signed_url": canonical}

        # Full sweep — strip signing params from all URLs in showcache
        started_at = datetime.now(timezone.utc)
        targets = _collect_sweep_targets(mongo_client)
        updated = skipped = 0
        for t in targets:
            if _write_showcache(mongo_client, t["episode_id"], t["canonical"]):
                updated += 1
            else:
                skipped += 1

        finished_at = datetime.now(timezone.utc)
        run_doc = {
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_s": (finished_at - started_at).total_seconds(),
            "updated_count": updated,
            "skipped_count": skipped,
            "errors": [],
            "signing_disabled": True,
        }
        mongo_client["chai_q_lab"]["playback_resign_runs"].insert_one(dict(run_doc))
        run_doc["started_at"] = run_doc["started_at"].isoformat()
        run_doc["finished_at"] = run_doc["finished_at"].isoformat()
        return run_doc
    finally:
        mongo_client.close()
