#!/usr/bin/env python3
"""Gate F: each Azure dry run must match the nearest prod (AWS) resign run. Read-only.

prod run doc  (chai_q_lab.playback_resign_runs):         updated_count + skipped_count + len(errors)
azure dry run (chai_q_lab_shadow.playback_resign_runs):  target_count, would_update, errors, canary

Pass per dry run: canary ok, the SAME errors as the nearest prod run, and target_count equals the prod total of the
nearest run within 2 h, allowing for combined URLs added/removed in between
(--tolerance, default 0).

Usage: MONGO_URI=... python resign_dryrun_compare.py [--last 12] [--tolerance 0]
"""
import sys


def _error_signature(errors):
    from collections import Counter
    return Counter(((e or {}).get("episode_id"), ((e or {}).get("error") or "")[:120]) for e in (errors or []))


def evaluate(dry_runs, prod_runs, tolerance=0):
    results = []
    for d in dry_runs:
        nearest = min(prod_runs, key=lambda p: abs((p["started_at"] - d["started_at"]).total_seconds()), default=None)
        problems = []
        if not d.get("canary", {}).get("ok"):
            problems.append("canary failed")
        # Parity, not perfection: the dry run must fail on exactly the same items as the
        # nearest prod (AWS) run. (2026-10-09: both fail on the same 55 showcache entries
        # that have a combined URL but no episode id: a pre-existing prod data issue.)
        if nearest is not None and _error_signature(d.get("errors")) != _error_signature(nearest.get("errors")):
            problems.append(f"errors differ from prod: azure {len(d.get('errors') or [])} vs prod {len(nearest.get('errors') or [])}")
        if nearest is None or abs((nearest["started_at"] - d["started_at"]).total_seconds()) > 7200:
            problems.append("no prod run within 2 h")
        else:
            prod_total = nearest.get("updated_count", 0) + nearest.get("skipped_count", 0) + len(nearest.get("errors") or [])
            if abs(prod_total - d["target_count"]) > tolerance:
                problems.append(f"target_count {d['target_count']} vs prod {prod_total}")
        results.append((d["started_at"], problems))
    return results


if __name__ == "__main__":
    import os
    import pymongo
    args = sys.argv[1:]
    last = int(args[args.index("--last") + 1]) if "--last" in args else 12
    tol = int(args[args.index("--tolerance") + 1]) if "--tolerance" in args else 0
    c = pymongo.MongoClient(os.environ["MONGO_URI"], readPreference="secondaryPreferred")
    dry = list(c["chai_q_lab_shadow"].playback_resign_runs.find({"dry_run": True}).sort("started_at", -1).limit(last))
    prod = list(c["chai_q_lab"].playback_resign_runs.find({}).sort("started_at", -1).limit(last * 3))
    res = evaluate(dry, prod, tol)
    for ts, probs in res:
        print(("PASS " if not probs else "FAIL ") + str(ts) + (" " + "; ".join(probs) if probs else ""))
    ok = len(res) >= last and all(not p for _, p in res)
    print(f"GATE F {'PASSED' if ok else 'NOT PASSED'} ({sum(1 for _, p in res if not p)}/{last})")
    sys.exit(0 if ok else 1)
