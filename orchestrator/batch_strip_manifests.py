"""Batch-strip signing params from EVERY combined master in master.showcache.

Wraps strip_manifest_params.process() and runs it over all episodes + trailers
whose playback URL is a `_combined.m3u8`. Built to run in BOUNDED CHUNKS — you
do not (and should not) do everything at once:

  * --limit N        process at most N episodes this run (default 25 on --apply)
  * resumable        a JSONL state file records what's done; re-run continues
  * --sleep S        delay between episodes (gentle on CDN invalidation quota)
  * idempotent       a re-run of a clean episode is a no-op

Two files are written:
  * --state-file  (JSONL, machine-readable)  — one record per episode, drives resume
  * --log-file    (human-readable)           — timestamped: skipped / cleaned / url / errors

Safety: the edge is checked once up front AND per-episode inside process()
(fail-closed). If any route enforces signing, the whole batch stops.

Env:
  MONGO_URI   master cluster (source .env.deploy:  set -a; . ../.env.deploy; set +a)

Usage:
  ARN=arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd
  # dry-run over EVERYTHING (read-only) — see totals, change nothing
  python batch_strip_manifests.py --from-secret $ARN
  # clean the first 25 not-yet-done (default chunk), with backups
  python batch_strip_manifests.py --from-secret $ARN --apply --backup
  # bigger chunk / resume — run again; done episodes are skipped
  python batch_strip_manifests.py --from-secret $ARN --apply --backup --limit 100

Exit codes: 0 all ok | 1 error | 2 edge refused (stopped) | 3 some partial.
"""

import argparse
import contextlib
import io
import json
import os
import sys
import time
from datetime import datetime, timezone

import pymongo

import strip_manifest_params as smp

COMBINED_MARKER = "_combined.m3u8"
_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_STATE_FILE = os.path.join(_HERE, "batch_strip_state.jsonl")
DEFAULT_LOG_FILE = os.path.join(_HERE, "batch_strip_manifests.log")


class Logger:
    """Write timestamped lines to a file (append) and echo to the console."""
    def __init__(self, path):
        self.fh = open(path, "a")
        self.path = path

    def log(self, msg, echo=True):
        line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}  {msg}"
        self.fh.write(line + "\n")
        self.fh.flush()
        if echo:
            print(msg)

    def close(self):
        self.fh.close()


def enumerate_masters(mongo_uri):
    """Return [(episode_id, canonical_master_url)] for every combined master in
    master.showcache, STABLE order (by _id, then array order) so --limit chunks
    paginate deterministically across runs."""
    client = pymongo.MongoClient(mongo_uri)
    try:
        showcache = client["master"]["showcache"]
        cursor = showcache.find(
            {},
            {"_id": 1, "episodes.id": 1, "episodes.signed_playback_url": 1,
             "trailers_playback_urls._key": 1, "trailers_playback_urls.gcpUrl": 1},
        ).sort("_id", 1)
        out = []
        for show in cursor:
            for ep in show.get("episodes") or []:
                url = ep.get("signed_playback_url")
                if url and COMBINED_MARKER in url:
                    out.append((str(ep["id"]), url.split("?", 1)[0]))
            for t in show.get("trailers_playback_urls") or []:
                url = t.get("gcpUrl")
                if url and COMBINED_MARKER in url:
                    out.append((f"trailer_{show['_id']}_{t['_key']}", url.split("?", 1)[0]))
        return out
    finally:
        client.close()


def load_state(path):
    """Return {episode_id: last_record}. Last line for an id wins."""
    state = {}
    if not os.path.exists(path):
        return state
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            state[rec["episode_id"]] = rec
    return state


def append_state(path, rec):
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")


def classify(result):
    """Map a process() result to a batch status."""
    if result.get("aborted"):
        return "aborted"
    if result.get("write_skipped"):
        return "failed"          # concurrent change — retry later
    if result.get("invalidation_failed"):
        return "needs_invalidation"
    return "done"


def main():
    ap = argparse.ArgumentParser(description="Batch-strip signing params across all combined masters.")
    ap.add_argument("--from-secret", metavar="ARN", required=True,
                    help="AWS Secrets Manager ARN of the SA that can write+invalidate (in-memory)")
    ap.add_argument("--apply", action="store_true", help="Actually rewrite + invalidate (default: dry run)")
    ap.add_argument("--backup", action="store_true", help="Write <path>.bak before overwriting")
    ap.add_argument("--limit", type=int, default=None,
                    help="Max episodes this run (default: 10 on --apply, all on dry-run; 0 = ALL remaining)")
    ap.add_argument("--sleep", type=float, default=5.0, help="Seconds between episodes (default 5.0)")
    ap.add_argument("--invalidation-delay", type=float, default=5.0,
                    help="Seconds between CDN invalidation calls (default 5.0, rate-limit safety)")
    ap.add_argument("--state-file", default=DEFAULT_STATE_FILE, help="JSONL progress/resume file")
    ap.add_argument("--log-file", default=DEFAULT_LOG_FILE, help="Human-readable run log")
    args = ap.parse_args()

    logger = Logger(args.log_file)

    mongo_uri = os.environ.get("MONGO_URI")
    if not mongo_uri:
        logger.log("ERROR: MONGO_URI not set. Run:  set -a; . ../.env.deploy; set +a")
        sys.exit(1)

    try:
        client, ident = smp.client_from_secret(args.from_secret)
    except Exception as e:
        logger.log(f"ERROR loading SA from secret: {e}")
        sys.exit(1)

    mode = "APPLY" if args.apply else "DRY-RUN"
    logger.log(f"===== START {mode}  identity={ident}  limit={args.limit}  "
               f"sleep={args.sleep}s  inval_delay={args.invalidation_delay}s")

    # Edge check ONCE up front — clean early abort (process() re-checks per episode too).
    if args.apply:
        status, detail = smp.edge_signing_status(client._credentials)
        logger.log(f"edge check: {detail}")
        if status != "disabled":
            logger.log(f"STOP: edge is '{status}', not disabled. Refusing the batch.")
            sys.exit(2)

    all_masters = enumerate_masters(mongo_uri)
    state = load_state(args.state_file)
    done_ids = {eid for eid, rec in state.items() if rec.get("status") == "done"}
    pending_inval = {eid: rec.get("prefixes", []) for eid, rec in state.items()
                     if rec.get("status") == "needs_invalidation"}

    todo = [(eid, url) for eid, url in all_masters if eid not in done_ids]
    if args.limit is None:
        limit = 10 if args.apply else len(todo)   # cautious default on apply
    elif args.limit == 0:
        limit = len(todo)                          # 0 = ALL remaining (run-to-completion)
    else:
        limit = args.limit
    batch = todo[:limit]

    logger.log(f"total={len(all_masters)}  already_done={len(done_ids)}  remaining={len(todo)}  this_run={len(batch)}")
    # Record which already-done episodes are being SKIPPED this run (to the file only, not console spam).
    for eid, url in all_masters:
        if eid in done_ids:
            logger.log(f"SKIP  {eid}  (already done)  {url}", echo=False)

    counts = {"cleaned": 0, "clean": 0, "needs_invalidation": 0, "failed": 0}
    for i, (eid, master) in enumerate(batch, 1):
        tag = f"[{i}/{len(batch)}] {eid}"
        buf = io.StringIO()
        try:
            if args.apply and eid in pending_inval:
                # Files already clean from a prior run; only invalidation is pending.
                with contextlib.redirect_stdout(buf):
                    failed = smp._invalidate(client, pending_inval[eid],
                                             delay=args.invalidation_delay)
                result = {"aborted": False, "write_skipped": 0,
                          "invalidation_failed": failed > 0, "changed": 0,
                          "prefixes": pending_inval[eid]}
            else:
                with contextlib.redirect_stdout(buf):
                    result = smp.process(master, apply=args.apply, invalidate=True,
                                         backup=args.backup, client=client,
                                         invalidation_delay=args.invalidation_delay)
        except Exception as e:
            logger.log(f"{tag}: ERROR {e}  {master}")
            if args.apply:
                append_state(args.state_file, {"episode_id": eid, "master": master,
                                               "status": "failed", "error": str(e)})
                counts["failed"] += 1
            time.sleep(args.sleep)
            continue

        st = classify(result)
        if st == "aborted":
            edge_status = result.get("edge_status", "unknown")
            logger.log(buf.getvalue().strip(), echo=False)
            if edge_status == "enforcing":
                # Real: a route enforces signing → hard stop (exit 2).
                logger.log(f"{tag}: EDGE ENFORCING mid-batch — HARD STOP.  {master}")
                logger.close()
                sys.exit(2)
            # Transient: could not READ the edge (network blip, sleep/wake). Not the
            # same as enforcing — exit 5 so the wrapper resumes after a wait.
            logger.log(f"{tag}: edge unreadable (transient, '{edge_status}') — exiting for resume.  {master}")
            logger.close()
            sys.exit(5)

        if not args.apply:
            n = result.get("changed", 0)
            logger.log(f"{tag}: {'WOULD-CLEAN ' + str(n) if n else 'CLEAN (nothing to do)'}  {master}")
            continue

        rec = {"episode_id": eid, "master": master, "status": st,
               "prefixes": result.get("prefixes", [])}
        append_state(args.state_file, rec)
        if st == "done":
            if result.get("changed"):
                counts["cleaned"] += 1
                logger.log(f"{tag}: CLEANED {result['changed']} file(s)  prefixes={result.get('prefixes')}  {master}")
            else:
                counts["clean"] += 1
                logger.log(f"{tag}: ALREADY-CLEAN  {master}")
        else:
            counts[st] += 1
            logger.log(f"{tag}: {st.upper()} — will retry next run  {master}")
            logger.log(buf.getvalue().strip(), echo=False)
        time.sleep(args.sleep)

    logger.log("===== SUMMARY")
    if args.apply:
        logger.log(f"cleaned={counts['cleaned']}  already_clean={counts['clean']}  "
                   f"needs_reinval={counts['needs_invalidation']}  failed={counts['failed']}")
        # Only cleaned+already_clean become "done"; needs_reinval/failed stay in the
        # queue and are retried next run — so they count toward what's still remaining.
        newly_done = counts["cleaned"] + counts["clean"]
        remaining = len(todo) - newly_done
        logger.log(f"remaining_after={remaining}" + ("  (re-run to continue)" if remaining else "  ALL DONE"))
        logger.close()
        sys.exit(3 if counts["needs_invalidation"] or counts["failed"] else 0)
    else:
        logger.log(f"dry-run listed {len(batch)} episode(s). Re-run with --apply to clean in chunks.")
        logger.close()
        sys.exit(0)


if __name__ == "__main__":
    main()
