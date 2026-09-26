#!/usr/bin/env python3
"""Lab parity (gate E): same episode researched on AWS (prod) and Azure (shadow).

Pass when, per (codec, resolution): the golden bitrate differs by at most one
ladder step, and every (bitrate) measured on both has |dVMAF| <= 0.5. Read-only.

Usage: MONGO_URI=... python vmaf_compare.py <episode_id> [--codec h264]
"""
import sys

VMAF_TOL = 0.5


def compare(prod_rows, shadow_rows, prod_golden, shadow_golden, ladders):
    """rows: [{codec,resolution,bitrate_kbps,vmaf_score}]; golden: {(codec,res): kbps}; ladders: {(codec,res): [kbps]}"""
    problems = []
    p = {(r["codec"], r["resolution"], r["bitrate_kbps"]): r["vmaf_score"] for r in prod_rows}
    s = {(r["codec"], r["resolution"], r["bitrate_kbps"]): r["vmaf_score"] for r in shadow_rows}
    for key in sorted(set(p) & set(s)):
        if abs(p[key] - s[key]) > VMAF_TOL:
            problems.append(f"VMAF {key}: prod={p[key]:.2f} shadow={s[key]:.2f}")
    for key in sorted(set(prod_golden) | set(shadow_golden)):
        a, b = prod_golden.get(key), shadow_golden.get(key)
        ladder = ladders.get(key, [])
        if a is None or b is None or a not in ladder or b not in ladder:
            if a != b:
                problems.append(f"golden {key}: prod={a} shadow={b}")
            continue
        if abs(ladder.index(a) - ladder.index(b)) > 1:
            problems.append(f"golden {key}: prod={a} shadow={b} (> 1 step apart)")
    return problems


if __name__ == "__main__":
    import os
    import pymongo
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "orchestrator"))
    from search_orchestrator import SEARCH_CONFIG
    ep = sys.argv[1]
    c = pymongo.MongoClient(os.environ["MONGO_URI"], readPreference="secondaryPreferred")
    proj = {"_id": 0, "codec": 1, "resolution": 1, "bitrate_kbps": 1, "vmaf_score": 1}
    rows = {db: list(c[db].video_vmaf_research.find({"episode_id": ep}, proj)) for db in ("chai_q_lab", "chai_q_lab_shadow")}
    golden = {}
    for db in ("chai_q_lab", "chai_q_lab_shadow"):
        doc = c[db].video_episodes.find_one({"episode_id": ep}, {"golden_recipes": 1}) or {}
        res = (doc.get("golden_recipes") or {}).get("resolutions") or {}
        golden[db] = {(codec, r): v.get("bitrate_kbps") for r, per in res.items() for codec, v in (per or {}).items()
                      if isinstance(v, dict)}
    ladders = {(codec, r): cfg["candidates"] for codec, cc in SEARCH_CONFIG.items() for r, cfg in cc["resolutions"].items()}
    probs = compare(rows["chai_q_lab"], rows["chai_q_lab_shadow"], golden["chai_q_lab"], golden["chai_q_lab_shadow"], ladders)
    print("\n".join(probs) or "PASS")
    sys.exit(1 if probs else 0)
