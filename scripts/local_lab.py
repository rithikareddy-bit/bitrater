#!/usr/bin/env python3
"""Run the Parallel Resol lab for one show on THIS machine (no Batch).

Fallback for when AWS/Azure Batch can't launch workers. Each (episode, resolution)
unit runs research-worker/worker.py's run_search() unchanged (same ffmpeg settings,
same SEARCH_CONFIG, same trial docs in video_vmaf_research); the source is
downloaded once per episode and hard-linked into each unit's dir. When an
episode's 3 units finish, its grid is aggregated exactly like
dashboard/lib/parallelResolLab.js aggregateGrid() (golden_recipes winner,
lab_status_<codec>=COMPLETE, efficiency_gain).

Unlike runEpisodeGrid, existing golden_recipes for the codec are NOT unset at
start: they're only overwritten by winners, so a failed/interrupted episode
keeps its previous (e.g. default) ladder.

Resume-safe: episodes whose golden_recipes for the codec already have
vmaf_attained on all 3 resolutions (i.e. real lab winners, not defaults) are
skipped.

  MONGO_URI=... python3 scripts/local_lab.py --show-id 6ad1acf74c65fcc09ff9b4de --codec h264
"""
import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pymongo
from bson import ObjectId

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_DIR = os.path.join(REPO, "research-worker")
CONFIGS_DIR = os.path.join(REPO, "configs")

# dashboard/lib/gridLadders.js
CODEC_LIB = {"h264": "libx264", "h265": "libx265"}
VMAF_THRESHOLDS = {"1080p": 88, "720p": 75, "480p": 48}
RESOLUTION_ORDER = ["1080p", "720p", "480p"]

# Runs inside the unit dir: worker.py untouched, only the download is swapped
# for a hard link to the episode's already-downloaded source.
UNIT_SCRIPT = """
import os, sys
sys.path.insert(0, os.environ["LOCAL_LAB_WORKER_DIR"])
import worker
src = os.environ["LOCAL_LAB_SOURCE"]
worker._download_source = lambda url, dest: os.link(src, dest)
worker.main()
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def find_winner(docs, threshold):
    valid = sorted((d for d in docs if d.get("vmaf_score") is not None), key=lambda d: d["bitrate_kbps"])
    if not valid:
        return None
    above = [d for d in valid if d["vmaf_score"] >= threshold]
    w = above[0] if above else max(valid, key=lambda d: d["vmaf_score"])
    return {"bitrate_kbps": w["bitrate_kbps"], "vmaf_attained": w["vmaf_score"], "params": w.get("params")}


def aggregate_grid(db, episode_id, codec):
    """Port of parallelResolLab.js aggregateGrid()."""
    results = list(db["video_vmaf_research"].find({"episode_id": episode_id, "codec": CODEC_LIB[codec]}))
    if not any(r.get("vmaf_score") is not None for r in results):
        raise RuntimeError(f"no VMAF results for {episode_id}/{codec}")
    existing = db["video_episodes"].find_one({"episode_id": episode_id}, {"golden_recipes": 1, "efficiency_gain": 1}) or {}
    existing_res = (existing.get("golden_recipes") or {}).get("resolutions") or {}
    gain = dict(existing.get("efficiency_gain") or {})
    set_op = {}
    winners = {}
    for res in RESOLUTION_ORDER:
        codec_winners = dict(existing_res.get(res) or {})
        w = find_winner([r for r in results if r.get("resolution") == res], VMAF_THRESHOLDS[res])
        if w:
            codec_winners[codec] = w
            winners[res] = w
            set_op[f"golden_recipes.resolutions.{res}.{codec}"] = w
        h265, h264 = codec_winners.get("h265"), codec_winners.get("h264")
        if h265 and h264 and h264.get("bitrate_kbps"):
            gain[res] = f"{round((1 - h265['bitrate_kbps'] / h264['bitrate_kbps']) * 100 * 100) / 100}%"
        elif res not in gain:
            gain[res] = "N/A"
    set_op.update({
        "status": "ANALYSIS_COMPLETE",
        f"lab_status_{codec}": "COMPLETE",
        f"lab_finished_at_{codec}": now_iso(),
        "efficiency_gain": gain,
    })
    db["video_episodes"].update_one({"episode_id": episode_id}, {"$set": set_op, "$unset": {f"lab_error_{codec}": ""}}, upsert=True)
    return winners


def has_lab_winners(doc, codec):
    res = ((doc or {}).get("golden_recipes") or {}).get("resolutions") or {}
    return all((res.get(r) or {}).get(codec, {}).get("vmaf_attained") is not None for r in RESOLUTION_ORDER)


def download(url, dest):
    tmp = dest + ".part"
    with urllib.request.urlopen(url.strip(), timeout=120) as resp, open(tmp, "wb") as f:
        shutil.copyfileobj(resp, f, length=8 * 1024 * 1024)
    os.replace(tmp, dest)


def run_unit(ep, res, codec, work, mongo_uri, db_lab, run_id):
    unit_dir = os.path.join(work, ep["id"], res)
    shutil.rmtree(unit_dir, ignore_errors=True)
    os.makedirs(unit_dir)
    shutil.copytree(CONFIGS_DIR, os.path.join(unit_dir, "configs"))  # worker reads configs/ relative to cwd
    env = {
        **os.environ,
        "LAB_MODE": "search",
        "S3_URL": ep["s3_url"],
        "CODEC": CODEC_LIB[codec],
        "EPISODE_ID": ep["id"],
        "RESOLUTION": res[:-1],
        "MONGO_URI": mongo_uri,
        "DB_LAB": db_lab,
        "LAB_RUN_ID": run_id,
        "LOCAL_LAB_WORKER_DIR": WORKER_DIR,
        "LOCAL_LAB_SOURCE": os.path.join(work, ep["id"], "source.mp4"),
    }
    t0 = time.time()
    with open(os.path.join(work, ep["id"], f"{res}.log"), "w") as lf:
        rc = subprocess.run([sys.executable, "-I", "-c", UNIT_SCRIPT], cwd=unit_dir, env=env,
                            stdout=lf, stderr=subprocess.STDOUT).returncode
    shutil.rmtree(unit_dir, ignore_errors=True)
    return rc, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show-id", required=True)
    ap.add_argument("--codec", choices=["h264", "h265"], required=True)
    ap.add_argument("--episodes", help="comma-separated episode ids (default: all in the show)")
    ap.add_argument("--parallel", type=int, default=3, help="concurrent (episode, resolution) units")
    ap.add_argument("--db-lab", default=os.environ.get("DB_LAB", "chai_q_lab"))
    ap.add_argument("--db-master", default="master")
    ap.add_argument("--work", default="/tmp/local_lab")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    mongo_uri = os.environ["MONGO_URI"]
    client = pymongo.MongoClient(mongo_uri, serverSelectionTimeoutMS=30000)
    db = client[args.db_lab]
    show = client[args.db_master]["showcache"].find_one({"_id": ObjectId(args.show_id)}, {"name": 1, "title": 1, "episodes": 1})
    if not show:
        sys.exit(f"show {args.show_id} not found in {args.db_master}.showcache")
    eps = [{"id": e["id"], "n": e.get("episode_number"), "s3_url": e["s3_url"]}
           for e in show.get("episodes") or [] if e.get("id") and (e.get("s3_url") or "").strip()]
    if args.episodes:
        wanted = set(args.episodes.split(","))
        eps = [e for e in eps if e["id"] in wanted]
    docs = {d["episode_id"]: d for d in db["video_episodes"].find({"episode_id": {"$in": [e["id"] for e in eps]}})}
    todo = []
    for e in eps:
        d = docs.get(e["id"])
        if (d or {}).get(f"lab_status_{args.codec}") == "RUNNING":
            log(f"skip ep {e['n']} {e['id']}: lab already RUNNING")
        elif has_lab_winners(d, args.codec):
            log(f"skip ep {e['n']} {e['id']}: already has lab winners")
        else:
            todo.append(e)
    log(f"{show.get("name") or show.get("title")}: {len(todo)}/{len(eps)} episodes to run, codec={args.codec}, db={args.db_lab}, parallel={args.parallel}")
    if args.dry_run or not todo:
        return

    run_id = f"local-{uuid.uuid4()}"
    os.makedirs(args.work, exist_ok=True)
    started = set()   # episodes this run marked RUNNING and hasn't finalized
    lock = threading.Lock()
    results = {"ok": [], "failed": []}

    def finalize(ep, unit_rcs):
        ep_id = ep["id"]
        try:
            if any(rc != 0 for rc in unit_rcs.values()):
                raise RuntimeError("unit(s) failed: " + ", ".join(f"{r} rc={rc}" for r, rc in unit_rcs.items() if rc != 0))
            winners = aggregate_grid(db, ep_id, args.codec)
            log(f"ep {ep['n']} COMPLETE: " + ", ".join(f"{r}={w['bitrate_kbps']}k (vmaf {w['vmaf_attained']:.1f})" for r, w in winners.items()))
            results["ok"].append(ep["n"])
        except Exception as exc:  # keep previous golden ladder; flag the failure
            db["video_episodes"].update_one({"episode_id": ep_id}, {"$set": {
                f"lab_status_{args.codec}": "FAILED", f"lab_error_{args.codec}": f"local lab: {exc}"}})
            log(f"ep {ep['n']} FAILED: {exc} (logs in {args.work}/{ep_id}/)")
            results["failed"].append(ep["n"])
        finally:
            with lock:
                started.discard(ep_id)
            try:
                os.remove(os.path.join(args.work, ep_id, "source.mp4"))
            except FileNotFoundError:
                pass

    pool = ThreadPoolExecutor(max_workers=args.parallel)
    dl_pool = ThreadPoolExecutor(max_workers=1)  # prefetch next episode while current ones encode

    def fetch(ep):
        d = os.path.join(args.work, ep["id"])
        os.makedirs(d, exist_ok=True)
        dest = os.path.join(d, "source.mp4")
        if not os.path.exists(dest):
            download(ep["s3_url"], dest)
        return dest

    downloads = {}
    for ep in todo[:2]:
        downloads[ep["id"]] = dl_pool.submit(fetch, ep)

    t_start = time.time()
    episode_futures = []
    try:
        for i, ep in enumerate(todo):
            if i + 2 < len(todo):
                nxt = todo[i + 2]
                downloads[nxt["id"]] = dl_pool.submit(fetch, nxt)
            try:
                downloads[ep["id"]].result()
            except Exception as exc:
                log(f"ep {ep['n']} download failed: {exc}")
                results["failed"].append(ep["n"])
                continue
            db["video_episodes"].update_one({"episode_id": ep["id"]}, {"$set": {
                f"lab_status_{args.codec}": "RUNNING", f"lab_run_started_at_{args.codec}": now_iso(), "lab_run_id": run_id}},
                upsert=True)
            with lock:
                started.add(ep["id"])
            log(f"ep {ep['n']} ({i + 1}/{len(todo)}) started")
            unit_futs = {res: pool.submit(run_unit, ep, res, args.codec, args.work, mongo_uri, args.db_lab, run_id)
                         for res in RESOLUTION_ORDER}

            def on_done(ep=ep, unit_futs=unit_futs):
                rcs = {}
                for res, f in unit_futs.items():
                    try:
                        rc, secs = f.result()
                    except Exception as exc:
                        rc, secs = f"exception {exc}", 0
                    rcs[res] = rc
                    log(f"ep {ep['n']} {res} rc={rc} in {secs / 60:.1f} min")
                finalize(ep, rcs)

            episode_futures.append(threading.Thread(target=on_done, daemon=True))
            episode_futures[-1].start()
            # Don't queue far ahead of the pool: keeps sources on disk to ~3 episodes.
            while sum(t.is_alive() for t in episode_futures) > max(1, args.parallel // 3 + 1):
                time.sleep(5)
        for t in episode_futures:
            t.join()
    except KeyboardInterrupt:
        log("interrupted — restoring episodes left RUNNING (previous ladder kept)")
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    finally:
        with lock:
            leftover = list(started)
        for ep_id in leftover:
            db["video_episodes"].update_one({"episode_id": ep_id, f"lab_status_{args.codec}": "RUNNING", "lab_run_id": run_id},
                                            {"$set": {f"lab_status_{args.codec}": "FAILED",
                                                      f"lab_error_{args.codec}": "local lab interrupted"}})
        log(f"done in {(time.time() - t_start) / 3600:.2f} h — ok={sorted(results['ok'])} failed={sorted(results['failed'])}")


if __name__ == "__main__":
    main()
