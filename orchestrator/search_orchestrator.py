import os
import uuid
from datetime import datetime, timezone

import boto3
import pymongo


RESOLUTION_ORDER = ["1080p", "720p", "480p"]

SEARCH_CONFIG = {
    "h264": {
        "ffmpeg_codec": "libx264",
        "resolutions": {
            "1080p": {
                "threshold": 88,
                "job_timeout_seconds": 3000,
                "candidates": [1800, 2000, 2300, 2500, 2700, 3000, 3300, 3600, 3900, 4200, 4400, 4600, 4800],
            },
            "720p": {
                "threshold": 75,
                "job_timeout_seconds": 1800,
                "candidates": [700, 900, 1100, 1300, 1500, 1700, 1900],
            },
            "480p": {
                "threshold": 48,
                "job_timeout_seconds": 1200,
                "candidates": [200, 300, 400, 500, 600],
            },
        },
    },
    "h265": {
        "ffmpeg_codec": "libx265",
        "resolutions": {
            "1080p": {
                "threshold": 88,
                "job_timeout_seconds": 3000,
                "candidates": [800, 1000, 1200, 1500, 1800, 2100, 2300, 2600, 2900, 3200],
            },
            "720p": {
                "threshold": 75,
                "job_timeout_seconds": 1800,
                "candidates": [500, 700, 900, 1200, 1350, 1500, 1650],
            },
            "480p": {
                "threshold": 48,
                "job_timeout_seconds": 1200,
                "candidates": [100, 200, 300, 400, 500],
            },
        },
    },
}

LEGACY_TO_NEW_PHASE = {
    "PROBING": "SEARCHING",
    "LOWER_SEARCH": "SEARCHING",
    "HIGHER_SEARCH": "SEARCHING",
    "SEARCHING": "SEARCHING",
    "PENDING": "PENDING",
    "FINAL": "FINAL",
}


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def _to_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value):
    try:
        return float(value)
    except Exception:
        return None


def _normalize_state(search_state, codec):
    if not isinstance(search_state, dict):
        search_state = {}
    resolutions = search_state.get("resolutions")
    if not isinstance(resolutions, dict):
        resolutions = {}

    cfg = SEARCH_CONFIG[codec]["resolutions"]
    normalized = {}
    for res in RESOLUTION_ORDER:
        existing = resolutions.get(res) or {}
        cands = list(cfg[res]["candidates"])
        tested = existing.get("tested") or {}
        legacy_phase = existing.get("phase")
        if legacy_phase in LEGACY_TO_NEW_PHASE:
            phase = LEGACY_TO_NEW_PHASE[legacy_phase]
        else:
            phase = "SEARCHING" if res == RESOLUTION_ORDER[0] else "PENDING"
        normalized[res] = {
            "phase": phase,
            "candidates": cands,
            "tested": tested,
            "left": existing.get("left", 0),
            "right": existing.get("right", len(cands) - 1),
            "best_pass": existing.get("best_pass"),
            "winner": existing.get("winner"),
            "winner_vmaf_delta": existing.get("winner_vmaf_delta"),
            "test_count": _count_non_discarded(tested),
        }

    return {
        "codec": codec,
        "active_resolution": search_state.get("active_resolution") or RESOLUTION_ORDER[0],
        "resolutions": normalized,
    }


def _build_initial_state(codec):
    cfg = SEARCH_CONFIG[codec]["resolutions"]
    resolutions = {}
    for res in RESOLUTION_ORDER:
        cands = list(cfg[res]["candidates"])
        resolutions[res] = {
            "phase": "PENDING",
            "candidates": cands,
            "tested": {},
            "left": 0,
            "right": len(cands) - 1,
            "best_pass": None,
            "winner": None,
            "winner_vmaf_delta": None,
            "test_count": 0,
        }
    return {
        "codec": codec,
        "active_resolution": RESOLUTION_ORDER[0],
        "resolutions": resolutions,
    }


def _count_non_discarded(tested):
    return sum(1 for entry in tested.values() if entry.get("status") != "DISCARDED")


def _pending_bitrates(tested):
    out = []
    for k, entry in tested.items():
        if entry.get("status") == "PENDING":
            out.append(_to_int(k))
    return sorted(out)


def _is_pass(vmaf_score, threshold):
    if vmaf_score is None or vmaf_score < threshold:
        return False
    return True


def _resolution_env_value(resolution_tag):
    return resolution_tag.replace("p", "")


def _describe_jobs(batch_client, job_ids):
    if not job_ids:
        return {}
    try:
        resp = batch_client.describe_jobs(jobs=job_ids[:100])
    except Exception:
        return {}
    out = {}
    for job in resp.get("jobs", []):
        out[job.get("jobId")] = job
    return out


def _find_latest_vmaf_doc(db, episode_id, codec_lib, resolution_tag, bitrate, run_id=None):
    query = {
        "episode_id": episode_id,
        "codec": codec_lib,
        "resolution": resolution_tag,
        "bitrate_kbps": int(bitrate),
    }
    if run_id:
        query["lab_run_id"] = run_id
    doc = db.video_vmaf_research.find_one(
        query,
        sort=[("timestamp", -1), ("_id", -1)],
    )
    if not doc and run_id:
        # Fallback: worker image may not have written lab_run_id (older build).
        # Safe to query without it because push API deletes all prior docs before each run.
        doc = db.video_vmaf_research.find_one(
            {
                "episode_id": episode_id,
                "codec": codec_lib,
                "resolution": resolution_tag,
                "bitrate_kbps": int(bitrate),
            },
            sort=[("timestamp", -1), ("_id", -1)],
        )
    if not doc:
        return None
    score = _safe_float(doc.get("vmaf_score"))
    if score is None:
        return None
    return doc


_BATCH_ACTIVE_STATES = {"SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"}


def _resolve_pending_for_resolution(
    db,
    batch_client,
    episode_id,
    s3_url,
    codec_lib,
    resolution_tag,
    res_cfg,
    res_state,
    run_id=None,
):
    tested = res_state["tested"]
    pending_items = [(k, v) for k, v in tested.items() if v.get("status") == "PENDING"]
    job_ids = [v.get("job_id") for _, v in pending_items if v.get("job_id")]
    described = _describe_jobs(batch_client, job_ids)

    now_dt = datetime.now(timezone.utc)
    threshold = res_cfg["threshold"]
    timeout_s = res_cfg["job_timeout_seconds"]

    resubmit = []

    for bitrate_key, entry in pending_items:
        bitrate = _to_int(bitrate_key)
        doc = _find_latest_vmaf_doc(db, episode_id, codec_lib, resolution_tag, bitrate, run_id=run_id)
        if doc:
            score = _safe_float(doc.get("vmaf_score"))
            passed = _is_pass(score, threshold)
            tested[bitrate_key] = {
                "status": "PASS" if passed else "FAIL",
                "reason": "PASS" if passed else "FAIL_THRESHOLD",
                "vmaf": score,
                "vmaf_delta": round(score - threshold, 3),
            }
            continue

        job_id = entry.get("job_id")
        job = described.get(job_id) if job_id else None
        job_status = (job or {}).get("status")

        retry_count = _to_int(entry.get("retry_count"), 0)

        if job_status == "FAILED":
            if retry_count < 1:
                resubmit.append((bitrate_key, bitrate, retry_count + 1))
            else:
                tested[bitrate_key] = {
                    "status": "FAIL",
                    "reason": "BATCH_FAILED_AFTER_RETRY",
                }
            continue

        if job_status in _BATCH_ACTIVE_STATES:
            continue

        if job_status == "SUCCEEDED":
            submitted_at = entry.get("submitted_at")
            age_s = 0
            if submitted_at:
                try:
                    submitted_dt = datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
                    age_s = int((now_dt - submitted_dt).total_seconds())
                except Exception:
                    age_s = 0
            if age_s > timeout_s:
                if retry_count < 1:
                    resubmit.append((bitrate_key, bitrate, retry_count + 1))
                else:
                    tested[bitrate_key] = {
                        "status": "FAIL",
                        "reason": "SUCCEEDED_NO_DOC",
                    }
            continue

        submitted_at = entry.get("submitted_at")
        age_s = 0
        if submitted_at:
            try:
                submitted_dt = datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
                age_s = int((now_dt - submitted_dt).total_seconds())
            except Exception:
                age_s = 0

        if age_s > timeout_s:
            if job_id:
                try:
                    batch_client.terminate_job(
                        jobId=job_id,
                        reason="Hard timeout exceeded — job not found in Batch",
                    )
                except Exception:
                    pass
            if retry_count < 1:
                resubmit.append((bitrate_key, bitrate, retry_count + 1))
            else:
                tested[bitrate_key] = {
                    "status": "FAIL",
                    "reason": "TIMEOUT_AFTER_RETRY",
                }
            continue

    for bitrate_key, bitrate, new_retry_count in resubmit:
        tested.pop(bitrate_key, None)
        _resubmit_job(
            batch_client, episode_id, s3_url, codec_lib, resolution_tag,
            res_state, bitrate, new_retry_count, run_id=run_id,
        )

    res_state["test_count"] = _count_non_discarded(tested)


def _choose_best_available(res_state):
    tested = res_state["tested"]
    pass_bitrates = []
    for key, entry in tested.items():
        if entry.get("status") == "PASS":
            pass_bitrates.append((_to_int(key), entry))
    if pass_bitrates:
        pass_bitrates.sort(key=lambda item: item[0])
        winner_bitrate, winner_entry = pass_bitrates[0]
        return winner_bitrate, winner_entry.get("vmaf_delta")

    fail_bitrates = []
    for key, entry in tested.items():
        if entry.get("status") == "FAIL":
            fail_bitrates.append((_to_int(key), entry))
    if fail_bitrates:
        fail_bitrates.sort(key=lambda item: item[0], reverse=True)
        winner_bitrate, winner_entry = fail_bitrates[0]
        return winner_bitrate, winner_entry.get("vmaf_delta")

    pending = _pending_bitrates(tested)
    if pending:
        return pending[0], None

    return None, None


def _finalize_resolution(res_state, winner, winner_delta=None):
    res_state["phase"] = "FINAL"
    res_state["winner"] = winner
    res_state["winner_vmaf_delta"] = winner_delta


def _advance_binary(res_state):
    """Pure binary search step. Returns {'submit': [bitrate]|[], 'discard': []}.
       Folds resolved tests into left/right + best_pass; finalizes when range empty."""
    actions = {"submit": [], "discard": []}
    tested = res_state["tested"]
    candidates = res_state["candidates"]
    left, right = res_state["left"], res_state["right"]

    if _pending_bitrates(tested):
        return actions

    last_tested = sorted(
        (_to_int(k), v) for k, v in tested.items() if v.get("status") in {"PASS", "FAIL"}
    )
    if last_tested:
        for bitrate, entry in last_tested:
            try:
                idx = candidates.index(bitrate)
            except ValueError:
                continue
            if entry["status"] == "PASS":
                if res_state["best_pass"] is None or bitrate < res_state["best_pass"]:
                    res_state["best_pass"] = bitrate
                if left <= idx <= right:
                    right = idx - 1
            else:
                if left <= idx <= right:
                    left = idx + 1
        res_state["left"], res_state["right"] = left, right

    if left > right:
        winner = res_state["best_pass"]
        if winner is None:
            winner, delta = _choose_best_available(res_state)
        else:
            delta = (tested.get(str(winner)) or {}).get("vmaf_delta")
        _finalize_resolution(res_state, winner, delta)
        return actions

    mid = (left + right) // 2
    next_bitrate = candidates[mid]
    if str(next_bitrate) in tested:
        return actions
    actions["submit"] = [next_bitrate]
    return actions


def _advance_to_next_resolution(search_state, batch_client, episode_id, s3_url, codec_lib, run_id):
    """Move active pointer to the next non-FINAL resolution and seed its mid bitrate.
       Sets active_resolution = None when nothing remains."""
    cur = search_state.get("active_resolution")
    order = RESOLUTION_ORDER
    if cur is None or cur not in order:
        search_state["active_resolution"] = None
        return
    for next_res in order[order.index(cur) + 1:]:
        rs = search_state["resolutions"][next_res]
        if rs["phase"] == "FINAL":
            continue
        search_state["active_resolution"] = next_res
        rs["phase"] = "SEARCHING"
        cands = rs["candidates"]
        mid = (rs["left"] + rs["right"]) // 2
        _submit_jobs(
            batch_client, episode_id, s3_url, codec_lib, next_res, rs,
            [cands[mid]], run_id=run_id,
        )
        return
    search_state["active_resolution"] = None


def _submit_jobs(batch_client, episode_id, s3_url, codec_lib, resolution_tag, res_state, bitrates, run_id=None):
    queue_arn = os.environ.get("BATCH_JOB_QUEUE_ARN")
    definition_arn = os.environ.get("BATCH_JOB_DEFINITION_ARN")
    if not queue_arn or not definition_arn:
        raise RuntimeError("BATCH_JOB_QUEUE_ARN/BATCH_JOB_DEFINITION_ARN not configured")

    tested = res_state["tested"]
    resolution_env = _resolution_env_value(resolution_tag)
    now_iso = _utc_now_iso()
    for bitrate in bitrates:
        key = str(bitrate)
        if key in tested:
            continue
        job_name = f"ChaiQSearch-{episode_id[:24]}-{resolution_env}-{bitrate}-{uuid.uuid4().hex[:6]}"
        env_vars = [
            {"name": "BITRATE", "value": str(bitrate)},
            {"name": "CODEC", "value": codec_lib},
            {"name": "RESOLUTION", "value": resolution_env},
            {"name": "S3_URL", "value": s3_url},
            {"name": "EPISODE_ID", "value": episode_id},
        ]
        if run_id:
            env_vars.append({"name": "LAB_RUN_ID", "value": run_id})
        resp = batch_client.submit_job(
            jobName=job_name[:128],
            jobQueue=queue_arn,
            jobDefinition=definition_arn,
            containerOverrides={"environment": env_vars},
        )
        tested[key] = {
            "status": "PENDING",
            "job_id": resp.get("jobId"),
            "submitted_at": now_iso,
        }

    res_state["test_count"] = _count_non_discarded(tested)


def _resubmit_job(batch_client, episode_id, s3_url, codec_lib, resolution_tag, res_state, bitrate, retry_count, run_id=None):
    queue_arn = os.environ.get("BATCH_JOB_QUEUE_ARN")
    definition_arn = os.environ.get("BATCH_JOB_DEFINITION_ARN")
    if not queue_arn or not definition_arn:
        return

    tested = res_state["tested"]
    resolution_env = _resolution_env_value(resolution_tag)
    key = str(bitrate)
    job_name = f"ChaiQSearch-{episode_id[:24]}-{resolution_env}-{bitrate}-r{retry_count}-{uuid.uuid4().hex[:6]}"
    env_vars = [
        {"name": "BITRATE", "value": str(bitrate)},
        {"name": "CODEC", "value": codec_lib},
        {"name": "RESOLUTION", "value": resolution_env},
        {"name": "S3_URL", "value": s3_url},
        {"name": "EPISODE_ID", "value": episode_id},
    ]
    if run_id:
        env_vars.append({"name": "LAB_RUN_ID", "value": run_id})
    try:
        resp = batch_client.submit_job(
            jobName=job_name[:128],
            jobQueue=queue_arn,
            jobDefinition=definition_arn,
            containerOverrides={"environment": env_vars},
        )
        tested[key] = {
            "status": "PENDING",
            "job_id": resp.get("jobId"),
            "submitted_at": _utc_now_iso(),
            "retry_count": retry_count,
        }
    except Exception:
        tested[key] = {
            "status": "FAIL",
            "reason": "RESUBMIT_FAILED",
        }

    res_state["test_count"] = _count_non_discarded(tested)


def _discard_jobs(batch_client, res_state, bitrates):
    tested = res_state["tested"]
    for bitrate in bitrates:
        key = str(bitrate)
        entry = tested.get(key)
        if not entry:
            continue
        if entry.get("status") != "PENDING":
            continue
        job_id = entry.get("job_id")
        if job_id:
            try:
                batch_client.terminate_job(
                    jobId=job_id,
                    reason="Search decision made job irrelevant",
                )
            except Exception:
                # If terminate fails (already ended), still mark as discarded to prevent waiting forever.
                pass
        tested[key] = {
            "status": "DISCARDED",
            "job_id": job_id,
        }
    res_state["test_count"] = _count_non_discarded(tested)


def _phase_label(phase):
    if phase == "FINAL":
        return "DONE"
    return "PROBING"


def _phase_message(resolution_tag, res_state):
    phase = res_state.get("phase")
    if phase == "FINAL":
        winner = res_state.get("winner")
        if winner is not None:
            return f"{resolution_tag}: winner {winner} kbps"
        return f"{resolution_tag}: no winner"
    if phase == "PENDING":
        return f"{resolution_tag}: queued"
    pending = _pending_bitrates(res_state.get("tested") or {})
    if pending:
        return f"{resolution_tag}: testing {pending[0]}"
    return f"{resolution_tag}: deciding"


def _write_progress(db, episode_id, codec, poll_count, all_done, search_state):
    progress = {
        "updated_at": _utc_now_iso(),
        "poll_count": poll_count,
        "all_done": all_done,
        "resolutions": {},
    }

    for res in RESOLUTION_ORDER:
        rs = search_state["resolutions"][res]
        tested = rs["tested"]
        resolved_count = sum(
            1
            for entry in tested.values()
            if entry.get("status") in {"PASS", "FAIL"}
        )
        pending_count = sum(1 for entry in tested.values() if entry.get("status") == "PENDING")
        progress["resolutions"][res] = {
            "phase": _phase_label(rs.get("phase")),
            "raw_phase": rs.get("phase"),
            "tested": resolved_count,
            "pending": pending_count,
            "winner": rs.get("winner"),
            "bracket_display": rs.get("bracket_display"),
            "message": _phase_message(res, rs),
        }

    db.video_episodes.update_one(
        {"episode_id": episode_id},
        {
            "$set": {
                f"search_progress_{codec}": progress,
                f"lab_status_{codec}": "COMPLETE" if all_done else "RUNNING",
            }
        },
        upsert=True,
    )


def _build_response(episode_id, codec, s3_url, search_state, poll_count, all_done, run_id=None):
    resp = {
        "episode_id": episode_id,
        "codec": codec,
        "s3_url": s3_url,
        "search_state": search_state,
        "poll_count": poll_count,
        "all_done": all_done,
        "next_wait": "SHORT" if poll_count <= 3 else "LONG",
    }
    if run_id:
        resp["run_id"] = run_id
    return resp


def handler(event, context):
    episode_id = event.get("episode_id")
    codec = event.get("codec")
    s3_url = event.get("s3_url")
    run_id = event.get("run_id")
    poll_count = _to_int(event.get("poll_count"), 0)

    if not episode_id:
        raise ValueError("episode_id is required")
    if codec not in {"h264", "h265"}:
        raise ValueError("codec must be h264 or h265")
    if not s3_url:
        raise ValueError("s3_url is required")

    mongo_uri = os.environ.get("MONGO_URI")
    if not mongo_uri:
        raise RuntimeError("MONGO_URI not configured")

    codec_lib = SEARCH_CONFIG[codec]["ffmpeg_codec"]
    cfg_by_res = SEARCH_CONFIG[codec]["resolutions"]

    mongo_client = pymongo.MongoClient(mongo_uri)
    try:
        db = mongo_client["chai_q_lab"]
        batch_client = boto3.client("batch")

        search_state = event.get("search_state")
        if not search_state:
            search_state = _build_initial_state(codec)
            first_res = RESOLUTION_ORDER[0]
            rs = search_state["resolutions"][first_res]
            rs["phase"] = "SEARCHING"
            mid = (rs["left"] + rs["right"]) // 2
            _submit_jobs(
                batch_client=batch_client,
                episode_id=episode_id,
                s3_url=s3_url,
                codec_lib=codec_lib,
                resolution_tag=first_res,
                res_state=rs,
                bitrates=[rs["candidates"][mid]],
                run_id=run_id,
            )
            search_state["active_resolution"] = first_res
            all_done = False
            _write_progress(db, episode_id, codec, poll_count, all_done, search_state)
            return _build_response(episode_id, codec, s3_url, search_state, poll_count, all_done, run_id=run_id)

        poll_count += 1
        search_state = _normalize_state(search_state, codec)

        active = search_state.get("active_resolution")
        if active:
            rs = search_state["resolutions"][active]
            if rs["phase"] == "FINAL":
                _advance_to_next_resolution(
                    search_state, batch_client, episode_id, s3_url, codec_lib, run_id,
                )
            else:
                _resolve_pending_for_resolution(
                    db=db,
                    batch_client=batch_client,
                    episode_id=episode_id,
                    s3_url=s3_url,
                    codec_lib=codec_lib,
                    resolution_tag=active,
                    res_cfg=cfg_by_res[active],
                    res_state=rs,
                    run_id=run_id,
                )

                actions = _advance_binary(rs)
                if actions.get("discard"):
                    _discard_jobs(batch_client, rs, actions["discard"])
                if actions.get("submit"):
                    _submit_jobs(
                        batch_client=batch_client,
                        episode_id=episode_id,
                        s3_url=s3_url,
                        codec_lib=codec_lib,
                        resolution_tag=active,
                        res_state=rs,
                        bitrates=actions["submit"],
                        run_id=run_id,
                    )
                elif rs["phase"] == "FINAL":
                    _advance_to_next_resolution(
                        search_state, batch_client, episode_id, s3_url, codec_lib, run_id,
                    )

        all_done = search_state.get("active_resolution") is None
        _write_progress(db, episode_id, codec, poll_count, all_done, search_state)
        return _build_response(episode_id, codec, s3_url, search_state, poll_count, all_done, run_id=run_id)
    finally:
        mongo_client.close()
