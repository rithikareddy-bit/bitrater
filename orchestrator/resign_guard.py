"""Safety wrapper for the scheduled resigner on Azure (AZURE-MIGRATION-PLAN.md P7).

Runs before resign_playback_urls.handler and refuses to write unless it is sure
the tokens it would write actually play:

1. Settings must be set EXPLICITLY and match prod. The code default for
   SIGNING_MODE is "signature", which would 403 every combined master behind the
   REQUIRE_TOKENS CDN route.
2. Canary: sign 3 real targets and GET them on the live CDN. Signed must be 200,
   unsigned must be 403 (enforcement still on). Any miss: abort, write nothing.
3. DRY_RUN (default true): build every write but never flush; log a run doc to
   DB_LAB.playback_resign_runs (must be a *_shadow DB) for comparison with prod.

Log markers for alerts: RESIGN_CONFIG_INVALID, RESIGN_CANARY_FAIL, RESIGN_DRY_RUN_OK, RESIGN_OK.
"""
import hashlib
import json
import os
from datetime import datetime, timezone

import runtime_config

EXPECTED_SETTINGS = {
    "SIGNING_ENABLED": "true",
    "SIGNING_MODE": "token",
    "TOKEN_QUERY_PARAM": "edge-cache-token",
    "SIGNED_URL_TTL_SECONDS": "36000",
}
CANARY_SAMPLES = 3


def settings_problems(env) -> list:
    problems = []
    for name, expected in EXPECTED_SETTINGS.items():
        value = env.get(name)
        if value is None:
            problems.append(f"{name} must be set explicitly (expected {expected!r})")
        elif value.lower() != expected:
            problems.append(f"{name}={value!r}, expected {expected!r}")
    return problems


def is_dry_run(env) -> bool:
    return env.get("DRY_RUN", "true").lower() != "false"


def canary_targets(targets: list, day: str) -> list:
    """Deterministic samples: first episode, first trailer, one hash-picked target."""
    if not targets:
        return []
    picks = []
    first_ep = next((t for t in targets if not t["episode_id"].startswith("trailer_")), None)
    first_trailer = next((t for t in targets if t["episode_id"].startswith("trailer_")), None)
    for t in (first_ep, first_trailer):
        if t and t not in picks:
            picks.append(t)
    start = int(hashlib.sha256(day.encode()).hexdigest(), 16) % len(targets)
    for step in range(len(targets)):  # hash pick, stepping past ones already chosen
        if len(picks) >= CANARY_SAMPLES:
            break
        t = targets[(start + step) % len(targets)]
        if t not in picks:
            picks.append(t)
    return picks[:CANARY_SAMPLES]


def run_canary(targets, now, sign, http_get) -> dict:
    checks = []
    for t in canary_targets(targets, now.strftime("%Y-%m-%d")):
        signed_url, _ = sign(t["canonical"], now)
        signed = http_get(signed_url)
        unsigned = http_get(t["canonical"])
        checks.append({"episode_id": t["episode_id"], "signed_status": signed, "unsigned_status": unsigned,
                       # Range request: a playable signed URL answers 200 or 206
                       "ok": signed in (200, 206) and unsigned == 403})
    return {"ok": bool(checks) and all(c["ok"] for c in checks), "checks": checks}


def _http_status(url: str) -> int:
    import requests

    try:
        return requests.get(url, timeout=15, headers={"Range": "bytes=0-0"}).status_code
    except requests.RequestException:
        return -1


def run(env=None, mongo_client=None, http_get=None, now=None, log=print) -> int:
    """Returns the process exit code (0 ok, 1 canary/handler failure, 2 config refused)."""
    env = os.environ if env is None else env
    try:
        runtime_config.assert_job_isolation("resigner", env)  # shadow: dry run only; reads prod master in F
    except runtime_config.IsolationError as exc:
        log("RESIGN_CONFIG_INVALID " + json.dumps([str(exc)]))
        return 2
    problems = settings_problems(env)
    dry = is_dry_run(env)
    db_lab = env.get("DB_LAB", runtime_config.DB_LAB)
    shadow_lab = db_lab.endswith(runtime_config.SHADOW_DB_SUFFIX)
    if dry and not shadow_lab:
        problems.append(f"DRY_RUN needs DB_LAB=*_shadow for its run log (got {db_lab!r})")
    if not dry and shadow_lab:
        # A shadow stamp's resigner reads prod master (Phase F); it must never write it.
        problems.append(f"a real (non-dry) resign is refused on a shadow stamp (DB_LAB={db_lab!r})")
    if problems:
        log("RESIGN_CONFIG_INVALID " + json.dumps(problems))
        return 2

    import resign_playback_urls as rp

    if mongo_client is None:
        import pymongo

        mongo_client = pymongo.MongoClient(env["MONGO_URI"])
    now = now or datetime.now(timezone.utc)
    targets = rp._collect_sweep_targets(mongo_client)
    canary = run_canary(targets, now, rp._sign, http_get or _http_status)
    run_doc = {"started_at": now, "dry_run": dry, "target_count": len(targets), "canary": canary,
               "source": "azure-resign-guard"}
    runs = mongo_client[db_lab]["playback_resign_runs"]

    if not canary["ok"]:
        runs.insert_one({**run_doc, "canary_failed": True, "finished_at": datetime.now(timezone.utc)})
        log("RESIGN_CANARY_FAIL " + json.dumps(canary))
        return 1

    if dry:
        would_update, errors = 0, []
        for t in targets:
            try:
                rp._build_write(t["episode_id"], t["canonical"], now)
                would_update += 1
            except Exception as exc:  # noqa: BLE001 - mirrors the handler's per-target error capture
                errors.append({"episode_id": t["episode_id"], "error": str(exc)})
        runs.insert_one({**run_doc, "would_update": would_update, "errors": errors,
                         "finished_at": datetime.now(timezone.utc)})
        log("RESIGN_DRY_RUN_OK " + json.dumps({"target_count": len(targets), "would_update": would_update,
                                               "errors": len(errors)}))
        return 0

    result = rp.handler({}, None)
    log("RESIGN_OK " + json.dumps(result, default=str))
    return 0 if not result.get("errors") else 1
