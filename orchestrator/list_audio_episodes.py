"""
Audio batch State 0: list a show's episodes for the per-show Map fan-out.

Reads master.podcast_showcache for one show (by slug), emits one item per episode
that has an audio_url. Skips episodes already SUCCEEDED (per chai_q_lab.audio_episodes)
unless force=true, so re-running "Run pipeline" doesn't re-encode the whole show.

Returns { slug, count, episodes: [ {episode_id, audio_url}, ... ] }
"""

import os

import pymongo


def handler(event, context):
    slug = event["slug"]
    force = bool(event.get("force", False))

    client = pymongo.MongoClient(os.environ["MONGO_URI"])
    show = client["master"]["podcast_showcache"].find_one(
        {"slug": slug}, {"episodes": 1}
    )
    if not show:
        raise ValueError(f"Podcast not found in podcast_showcache: slug={slug}")

    episodes = show.get("episodes") or []

    # Skip episodes already done OR currently in-flight (so re-pressing "Run pipeline"
    # mid-batch doesn't start a duplicate conversion for the same episode). force overrides
    # AND clears any stale RUNNING/COPYING row so the new run isn't accidentally re-skipped
    # by a downstream check or surfaced as "still running" in the dashboard.
    ids = [e["id"] for e in episodes if e.get("id")]
    skip = set()
    if not force:
        # Best-effort skip lookup: on a transient Mongo blip, fall through and let the
        # batch proceed — downstream copy/transcoder will re-stamp these rows anyway.
        # Worst case is we re-encode an already-SUCCEEDED episode, not data loss.
        try:
            cur = client["chai_q_lab"]["audio_episodes"].find(
                {
                    "episode_id": {"$in": ids},
                    "gcp_job_status": {"$in": ["SUCCEEDED", "COPYING", "RUNNING"]},
                },
                {"episode_id": 1},
            )
            skip = {d["episode_id"] for d in cur}
        except Exception as e:
            print(f"[LIST][WARN] slug={slug} skip-set lookup failed, proceeding without skip: {e}")
    else:
        # On force, wipe every per-run field — not just status/job_name — so the new
        # run starts from a clean row. Otherwise a previous run's gcp_finished_at,
        # publish_error, etc. would linger and mislead the dashboard. If the unset
        # fails (transient Mongo), fail loudly — silently proceeding would leave the
        # stale fields the user is explicitly asking us to clear.
        try:
            client["chai_q_lab"]["audio_episodes"].update_many(
                {"episode_id": {"$in": ids}},
                {"$unset": {
                    "gcp_job_status": "",
                    "gcp_job_name": "",
                    "gcp_finished_at": "",
                    "gcp_error": "",
                    "output_uri": "",
                    "public_master_url": "",
                    "publish_error": "",
                    "ladder": "",
                    "lufs": "",
                    "language_code": "",
                    "subtitle_tracks": "",
                    "subtitle_publish_error": "",
                }},
            )
        except Exception as e:
            raise RuntimeError(
                f"force-clear of stale fields failed for slug={slug} "
                f"({len(ids)} episode(s)); aborting before stale state misleads the dashboard: {e}"
            ) from e

    items = []
    for ep in episodes:
        eid = ep.get("id")
        url = ep.get("audio_url")
        if not eid or not url:
            continue
        if eid in skip:
            continue
        items.append({"episode_id": eid, "audio_url": url})

    print(f"[LIST] {slug}: {len(items)} episode(s) to convert "
          f"(skipped {len(skip)} done/in-flight, force={force})")

    return {"slug": slug, "count": len(items), "episodes": items}
