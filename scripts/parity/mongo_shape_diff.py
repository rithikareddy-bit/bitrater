#!/usr/bin/env python3
"""Compare the SHAPE (keys + value types) of a prod doc and its shadow twin (gate E). Read-only.

Values like URLs/timestamps legitimately differ; missing/extra keys or changed
types indicate the Azure path writes something different from AWS.

Usage: MONGO_URI=... python mongo_shape_diff.py video_episodes <episode_id>
"""
import sys

IGNORE_PREFIXES = ("_id",)


def shape(value, path=""):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            out.update(shape(v, f"{path}.{k}" if path else k))
        return out or {path: "dict"}
    if isinstance(value, list):
        return {path: f"list[{type(value[0]).__name__}]" if value else "list"}
    return {path: type(value).__name__}


def diff(prod_doc, shadow_doc):
    a = {k: v for k, v in shape(prod_doc).items() if not k.startswith(IGNORE_PREFIXES)}
    b = {k: v for k, v in shape(shadow_doc).items() if not k.startswith(IGNORE_PREFIXES)}
    out = [f"only in prod: {k}" for k in sorted(set(a) - set(b))]
    out += [f"only in shadow: {k}" for k in sorted(set(b) - set(a))]
    out += [f"type {k}: prod={a[k]} shadow={b[k]}" for k in sorted(set(a) & set(b)) if a[k] != b[k] and "NoneType" not in (a[k], b[k])]
    return out


if __name__ == "__main__":
    import os
    import pymongo
    coll, ep = sys.argv[1], sys.argv[2]
    c = pymongo.MongoClient(os.environ["MONGO_URI"], readPreference="secondaryPreferred")
    p = c["chai_q_lab"][coll].find_one({"episode_id": ep}) or {}
    s = c["chai_q_lab_shadow"][coll].find_one({"episode_id": ep}) or {}
    d = diff(p, s)
    print("\n".join(d) or "SAME SHAPE")
    sys.exit(1 if d else 0)
