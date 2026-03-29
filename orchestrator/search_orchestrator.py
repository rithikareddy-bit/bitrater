import os
import uuid
from datetime import datetime, timezone

import boto3
import pymongo


RESOLUTION_ORDER = ["1080p", "720p", "480p"]
SEARCH_GLOBALS = {
    "MAX_TESTS_PER_RESOLUTION": 10,
    "CONFIDENCE_STOP_GAP_KBPS": 100,
    "CONFIDENCE_STOP_VMAF_MARGIN": 3,
}

SEARCH_CONFIG = {
    "h264": {
        "ffmpeg_codec": "libx264",
        "resolutions": {
            "1080p": {
                "threshold": 88,
                "dip_floor": 80,
                "job_timeout_seconds": 3000,
                "candidates": [1800, 2000, 2300, 2500, 2700, 3000, 3300, 3600, 3900, 4200],
                "initial_probes": [2300, 3000, 3900],
            },
            "720p": {
                "threshold": 75,
                "dip_floor": 67,
                "job_timeout_seconds": 1800,
                "candidates": [700, 900, 1100, 1300, 1500, 1700, 1900],
                "initial_probes": [1100, 1700],
            },
            "480p": {
                "threshold": 48,
                "dip_floor": 40,
                "job_timeout_seconds": 1200,
                "candidates": [200, 300, 400, 500, 600],
                "initial_probes": [400],
            },
        },
    },
    "h265": {
        "ffmpeg_codec": "libx265",
        "resolutions": {
            "1080p": {
                "threshold": 88,
                "dip_floor": 80,
                "job_timeout_seconds": 3000,
                "candidates": [800, 1000, 1200, 1500, 1800, 2100, 2300, 2600, 2900, 3200],
                "initial_probes": [1200, 2100, 2900],
            },
            "720p": {
                "threshold": 75,
                "dip_floor": 67,
                "job_timeout_seconds": 1800,
                "candidates": [500, 700, 900, 1200, 1350, 1500, 1650],
                "initial_probes": [900, 1500],
            },
            "480p": {
                "threshold": 48,
                "dip_floor": 40,
                "job_timeout_seconds": 1200,
                "candidates": [100, 200, 300, 400, 500],
                "initial_probes": [300],
            },
        },
    },
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
        tested = existing.get("tested") or {}
        normalized[res] = {
            "phase": existing.get("phase") or "PROBING",
            "candidates": list(cfg[res]["candidates"]),
            "tested": tested,
            "bracket": existing.get("bracket"),
            "winner": existing.get("winner"),
            "winner_vmaf_delta": existing.get("winner_vmaf_delta"),
            "bracket_display": existing.get("bracket_display"),
            "anchor_pass": existing.get("anchor_pass"),
            "test_count": _count_non_discarded(tested),
        }

    return {"codec": codec, "resolutions": normalized}


def _build_initial_state(codec):
    cfg = SEARCH_CONFIG[codec]["resolutions"]
    return {
        "codec": codec,
        "resolutions": {
            res: {
                "phase": "PROBING",
                "candidates": list(cfg[res]["candidates"]),
                "tested": {},
                "bracket": None,
                "winner": None,
                "winner_vmaf_delta": None,
                "bracket_display": None,
                "anchor_pass": None,
                "test_count": 0,
            }
            for res in RESOLUTION_ORDER
        },
    }


def _count_non_discarded(tested):
    return sum(1 for entry in tested.values() if entry.get("status") != "DISCARDED")


def _get_status(tested, bitrate):
    entry = tested.get(str(bitrate))
    if not entry:
        return None
    return entry.get("status")


def _pending_bitrates(tested):
    out = []
    for k, entry in tested.items():
        if entry.get("status") == "PENDING":
            out.append(_to_int(k))
    return sorted(out)


def _any_pending_strictly_below(tested, space_bitrates, cap_bitrate):
    """True if any candidate in space with bitrate < cap is still PENDING (parallel-wave ordering)."""
    return any(
        b < cap_bitrate and _get_status(tested, b) == "PENDING"
        for b in space_bitrates
    )


def _is_pass(vmaf_score, timeline, threshold, dip_floor):
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
    dip_floor = res_cfg["dip_floor"]
    timeout_s = res_cfg["job_timeout_seconds"]

    resubmit = []

    for bitrate_key, entry in pending_items:
        bitrate = _to_int(bitrate_key)
        doc = _find_latest_vmaf_doc(db, episode_id, codec_lib, resolution_tag, bitrate, run_id=run_id)
        if doc:
            score = _safe_float(doc.get("vmaf_score"))
            timeline = doc.get("vmaf_timeline") or []
            passed = _is_pass(score, timeline, threshold, dip_floor)
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


def _choose_low_search_targets(candidates_below):
    if len(candidates_below) <= 2:
        return list(candidates_below)
    mid_idx = len(candidates_below) // 2
    picks = [candidates_below[0], candidates_below[mid_idx]]
    dedup = []
    for bitrate in picks:
        if bitrate not in dedup:
            dedup.append(bitrate)
    return dedup


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
    res_state["bracket"] = None
    res_state["bracket_display"] = None
    res_state["anchor_pass"] = None


def _decide_resolution(res_state, res_cfg):
    actions = {"submit": [], "discard": []}
    phase = res_state.get("phase")
    tested = res_state["tested"]
    candidates = res_state["candidates"]

    if phase == "FINAL":
        return actions

    res_state["test_count"] = _count_non_discarded(tested)
    if res_state["test_count"] >= SEARCH_GLOBALS["MAX_TESTS_PER_RESOLUTION"]:
        winner, winner_delta = _choose_best_available(res_state)
        _finalize_resolution(res_state, winner, winner_delta)
        actions["discard"] = _pending_bitrates(tested)
        return actions

    if phase == "PROBING":
        submitted = sorted(
            _to_int(k)
            for k, entry in tested.items()
            if entry.get("status") != "DISCARDED"
        )
        if not submitted:
            return actions

        lowest = submitted[0]
        lowest_status = _get_status(tested, lowest)
        if lowest_status == "PENDING":
            return actions

        if lowest_status == "PASS":
            lower_candidates = [b for b in candidates if b < lowest and str(b) not in tested]
            actions["discard"] = [b for b in _pending_bitrates(tested) if b > lowest]
            if not lower_candidates:
                winner_delta = (tested.get(str(lowest)) or {}).get("vmaf_delta")
                _finalize_resolution(res_state, lowest, winner_delta)
                actions["discard"] = _pending_bitrates(tested)
                return actions

            res_state["phase"] = "LOWER_SEARCH"
            res_state["anchor_pass"] = lowest
            actions["submit"] = _choose_low_search_targets(lower_candidates)
            return actions

        if lowest_status == "FAIL":
            pass_submitted = [b for b in submitted if _get_status(tested, b) == "PASS"]
            if pass_submitted:
                low_pass = min(pass_submitted)
                unresolved_lower = [b for b in submitted if b < low_pass and _get_status(tested, b) == "PENDING"]
                if unresolved_lower:
                    return actions
                low_fail = max([b for b in submitted if b < low_pass and _get_status(tested, b) == "FAIL"], default=lowest)
                res_state["phase"] = "HIGHER_SEARCH"
                res_state["bracket"] = [low_fail, low_pass]
                res_state["bracket_display"] = f"{low_fail}-{low_pass}"
                actions["discard"] = [b for b in _pending_bitrates(tested) if b <= low_fail or b >= low_pass]
                return actions

            pending = [b for b in submitted if _get_status(tested, b) == "PENDING"]
            if pending:
                return actions

            next_higher = next((b for b in candidates if b > max(submitted) and str(b) not in tested), None)
            if next_higher is not None:
                actions["submit"] = [next_higher]
                return actions

            winner = max(submitted)
            winner_delta = (tested.get(str(winner)) or {}).get("vmaf_delta")
            _finalize_resolution(res_state, winner, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        return actions

    if phase == "LOWER_SEARCH":
        anchor = res_state.get("anchor_pass")
        if anchor is None:
            winner, winner_delta = _choose_best_available(res_state)
            _finalize_resolution(res_state, winner, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        lower_space = [b for b in candidates if b < anchor]
        pass_lower = sorted([b for b in lower_space if _get_status(tested, b) == "PASS"])
        if pass_lower:
            best = pass_lower[0]
            # Wait until every strictly lower rung has resolved before committing to
            # best, so e.g. 2000 kbps cannot win while 1800 kbps is still PENDING.
            if _any_pending_strictly_below(tested, lower_space, best):
                return actions
            pending_above_best = [b for b in _pending_bitrates(tested) if b > best]
            if pending_above_best:
                actions["discard"] = pending_above_best
            remaining_lower = [b for b in candidates if b < best and str(b) not in tested]
            if not remaining_lower:
                winner_delta = (tested.get(str(best)) or {}).get("vmaf_delta")
                _finalize_resolution(res_state, best, winner_delta)
                actions["discard"] = _pending_bitrates(tested)
                return actions
            res_state["anchor_pass"] = best
            actions["submit"] = _choose_low_search_targets(remaining_lower)
            return actions

        pending_lower = [b for b in lower_space if _get_status(tested, b) == "PENDING"]
        if pending_lower:
            return actions

        untested_lower = [b for b in lower_space if str(b) not in tested]
        if untested_lower:
            actions["submit"] = _choose_low_search_targets(untested_lower)
            return actions

        winner_delta = (tested.get(str(anchor)) or {}).get("vmaf_delta")
        _finalize_resolution(res_state, anchor, winner_delta)
        actions["discard"] = _pending_bitrates(tested)
        return actions

    if phase == "HIGHER_SEARCH":
        bracket = res_state.get("bracket") or []
        if len(bracket) != 2:
            winner, winner_delta = _choose_best_available(res_state)
            _finalize_resolution(res_state, winner, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        low_fail, high_pass = int(bracket[0]), int(bracket[1])

        if low_fail >= high_pass:
            winner_delta = (tested.get(str(high_pass)) or {}).get("vmaf_delta")
            _finalize_resolution(res_state, high_pass, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        pass_between = sorted(
            b for b in candidates if low_fail < b <= high_pass and _get_status(tested, b) == "PASS"
        )
        if pass_between:
            high_pass = pass_between[0]

        fail_between = sorted(
            b for b in candidates if low_fail <= b < high_pass and _get_status(tested, b) == "FAIL"
        )
        if fail_between:
            low_fail = fail_between[-1]

        if low_fail >= high_pass:
            winner_delta = (tested.get(str(high_pass)) or {}).get("vmaf_delta")
            _finalize_resolution(res_state, high_pass, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        res_state["bracket"] = [low_fail, high_pass]
        res_state["bracket_display"] = f"{low_fail}-{high_pass}"

        high_entry = tested.get(str(high_pass)) or {}
        high_vmaf = _safe_float(high_entry.get("vmaf"))
        if (
            (high_pass - low_fail) <= SEARCH_GLOBALS["CONFIDENCE_STOP_GAP_KBPS"]
            and high_vmaf is not None
            and abs(high_vmaf - res_cfg["threshold"]) <= SEARCH_GLOBALS["CONFIDENCE_STOP_VMAF_MARGIN"]
        ):
            winner_delta = (tested.get(str(high_pass)) or {}).get("vmaf_delta")
            _finalize_resolution(res_state, high_pass, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        between = [b for b in candidates if low_fail < b < high_pass]
        if not between:
            winner_delta = (tested.get(str(high_pass)) or {}).get("vmaf_delta")
            _finalize_resolution(res_state, high_pass, winner_delta)
            actions["discard"] = _pending_bitrates(tested)
            return actions

        pending_between = [b for b in between if _get_status(tested, b) == "PENDING"]
        if pending_between:
            actions["discard"] = [b for b in _pending_bitrates(tested) if b <= low_fail or b >= high_pass]
            return actions

        unresolved = [b for b in between if str(b) not in tested]
        if unresolved:
            idx = (len(unresolved) - 1) // 2
            actions["submit"] = [unresolved[idx]]
            actions["discard"] = [b for b in _pending_bitrates(tested) if b <= low_fail or b >= high_pass]
            return actions

        winner_delta = (tested.get(str(high_pass)) or {}).get("vmaf_delta")
        _finalize_resolution(res_state, high_pass, winner_delta)
        actions["discard"] = _pending_bitrates(tested)
        return actions

    return actions


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
    if phase in {"LOWER_SEARCH", "HIGHER_SEARCH"}:
        return "REFINING"
    if phase == "FINAL":
        return "DONE"
    return "PROBING"


def _phase_message(resolution_tag, res_state):
    phase = res_state.get("phase")
    if phase == "PROBING":
        return f"{resolution_tag}: waiting for decisive result"
    if phase == "LOWER_SEARCH":
        return f"{resolution_tag}: testing lower candidates"
    if phase == "HIGHER_SEARCH":
        br = res_state.get("bracket_display")
        return f"{resolution_tag}: narrowing {br}" if br else f"{resolution_tag}: narrowing bracket"
    winner = res_state.get("winner")
    if winner is not None:
        return f"{resolution_tag}: winner {winner} kbps"
    return f"{resolution_tag}: done"


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
            for res in RESOLUTION_ORDER:
                rs = search_state["resolutions"][res]
                _submit_jobs(
                    batch_client=batch_client,
                    episode_id=episode_id,
                    s3_url=s3_url,
                    codec_lib=codec_lib,
                    resolution_tag=res,
                    res_state=rs,
                    bitrates=cfg_by_res[res]["initial_probes"],
                    run_id=run_id,
                )
            all_done = False
            _write_progress(db, episode_id, codec, poll_count, all_done, search_state)
            return _build_response(episode_id, codec, s3_url, search_state, poll_count, all_done, run_id=run_id)

        poll_count += 1
        search_state = _normalize_state(search_state, codec)

        for res in RESOLUTION_ORDER:
            rs = search_state["resolutions"][res]
            if rs.get("phase") == "FINAL":
                continue

            _resolve_pending_for_resolution(
                db=db,
                batch_client=batch_client,
                episode_id=episode_id,
                s3_url=s3_url,
                codec_lib=codec_lib,
                resolution_tag=res,
                res_cfg=cfg_by_res[res],
                res_state=rs,
                run_id=run_id,
            )

            actions = _decide_resolution(rs, cfg_by_res[res])
            if actions.get("discard"):
                _discard_jobs(batch_client, rs, actions["discard"])
            if actions.get("submit"):
                _submit_jobs(
                    batch_client=batch_client,
                    episode_id=episode_id,
                    s3_url=s3_url,
                    codec_lib=codec_lib,
                    resolution_tag=res,
                    res_state=rs,
                    bitrates=actions["submit"],
                    run_id=run_id,
                )

        all_done = all(search_state["resolutions"][res]["phase"] == "FINAL" for res in RESOLUTION_ORDER)
        _write_progress(db, episode_id, codec, poll_count, all_done, search_state)
        return _build_response(episode_id, codec, s3_url, search_state, poll_count, all_done, run_id=run_id)
    finally:
        mongo_client.close()
