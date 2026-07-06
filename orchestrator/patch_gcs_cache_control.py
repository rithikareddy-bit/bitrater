"""
One-shot script: set Cache-Control: public, max-age=2592000 (30 days) on playback
blobs in chai-shots-manifests that don't already have that value.

By default it now covers ALL playback file types (.m3u8, .m4s, .vtt, .ts, .mp4),
so segments get 30 days too — not just .m3u8 as the original version did. Restrict
with --exts if you want the old .m3u8-only behaviour. Metadata-only patch; .bak
backups are skipped.

Run locally:
  python3 patch_gcs_cache_control.py --dry-run          # preview (add creds below)
  python3 patch_gcs_cache_control.py                    # patch (uses ADC)
  python3 patch_gcs_cache_control.py --from-secret <ARN>  # load prod SA in-memory (no ADC/key file)
  python3 patch_gcs_cache_control.py --exts .m3u8       # old behaviour: manifests only
  python3 patch_gcs_cache_control.py --workers 50       # tune concurrency (default 100)
  python3 patch_gcs_cache_control.py --prefix <uuid>/   # scope to a subtree
"""

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from google.cloud import storage

CDN_BASE = "https://cdn.chaishots.in/"


def _active_prefixes(mongo_uri):
    """UUID prefixes of every episode of every ACTIVE show, taken from
    episodes[].signed_playback_url (combined only)."""
    import pymongo
    client = pymongo.MongoClient(mongo_uri)
    try:
        prefixes = set()
        cur = client["master"]["showcache"].find(
            {"active": True}, {"episodes.signed_playback_url": 1})
        for show in cur:
            for ep in show.get("episodes") or []:
                url = ep.get("signed_playback_url")
                if url and "_combined.m3u8" in url and url.startswith(CDN_BASE):
                    uuid = url[len(CDN_BASE):].split("/", 1)[0]
                    if uuid:
                        prefixes.add(uuid + "/")
        return sorted(prefixes)
    finally:
        client.close()

BUCKET_NAME = "chai-shots-manifests"
TARGET_CACHE_CONTROL = "public, max-age=2592000"      # 30 days
PLAYBACK_EXTS = (".m3u8", ".m4s", ".vtt", ".ts", ".mp4")
DEFAULT_WORKERS = 100


def _client(from_secret):
    """Storage client from a Secrets Manager SA (in-memory) if --from-secret is
    given, else default ADC / GOOGLE_APPLICATION_CREDENTIALS."""
    if not from_secret:
        return storage.Client()
    import boto3
    from google.oauth2 import service_account
    region = from_secret.split(":")[3]
    info = json.loads(boto3.client("secretsmanager", region_name=region)
                      .get_secret_value(SecretId=from_secret)["SecretString"])
    creds = service_account.Credentials.from_service_account_info(info)
    print(f"identity: {info['client_email']} (from Secrets Manager, in-memory)")
    return storage.Client(credentials=creds, project=info.get("project_id"))


ONE_YEAR = "public, max-age=31536000"


def patch_blob(blob, dry_run, only_broken=False):
    """Returns (status, blob.name, current_value_or_err).
    status: 'patched' | 'skipped' (already 30d) | 'left' (not a target) | 'error'.

    only_broken=True => patch ONLY files currently at no-store or 1-year; leave
    every other value (already-30d, legacy 'private, max-age=0', etc.) untouched.
    """
    current = (blob.cache_control or "").strip().lower()
    if current == TARGET_CACHE_CONTROL.lower():
        return ("skipped", blob.name, current)                  # already 30 days
    if only_broken and not ("no-store" in current or current == ONE_YEAR):
        return ("left", blob.name, current)                     # not no-store/1yr → leave alone
    if dry_run:
        return ("patched", blob.name, current)
    try:
        blob.cache_control = TARGET_CACHE_CONTROL
        blob.patch()
        return ("patched", blob.name, current)
    except Exception as e:
        return ("error", blob.name, str(e))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--exts", nargs="+", default=list(PLAYBACK_EXTS),
                        help="file extensions to patch (default: all playback types)")
    parser.add_argument("--from-secret", metavar="ARN", default="",
                        help="load the SA from AWS Secrets Manager in-memory (no ADC/key file)")
    parser.add_argument("--only-broken", action="store_true",
                        help="patch ONLY files currently at no-store or 1-year (leave all other "
                             "values, incl. legacy private/max-age=0, untouched)")
    parser.add_argument("--active-only", action="store_true",
                        help="scope to episodes of ACTIVE shows (from showcache signed_playback_url) — "
                             "lists only those UUID folders instead of the whole bucket (needs MONGO_URI)")
    args = parser.parse_args()

    client = _client(args.from_secret)
    exts = tuple(args.exts)
    from collections import Counter

    mode = " [DRY RUN]" if args.dry_run else ""

    def _match(b):
        return b.name.endswith(exts) and not b.name.endswith(".bak")

    if args.active_only:
        mongo_uri = os.environ.get("MONGO_URI")
        if not mongo_uri:
            raise SystemExit("MONGO_URI not set (needed for --active-only)")
        prefixes = _active_prefixes(mongo_uri)
        print(f"Active shows → {len(prefixes)} episode UUID prefixes — {args.workers} workers{mode}")
        # list each prefix in parallel (each is tiny) — far faster than one whole-bucket scan
        blobs = []
        def _list(p):
            return [b for b in client.list_blobs(BUCKET_NAME, prefix=p) if _match(b)]
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for res in ex.map(_list, prefixes):
                blobs.extend(res)
    else:
        scope = f" (prefix={args.prefix!r})" if args.prefix else ""
        print(f"Scanning {BUCKET_NAME}{scope} for {exts} — {args.workers} workers{mode}")
        list_kwargs = {"prefix": args.prefix} if args.prefix else {}
        blobs = [b for b in client.list_blobs(BUCKET_NAME, **list_kwargs) if _match(b)]

    byext = Counter("." + b.name.rsplit(".", 1)[-1] for b in blobs)
    total = len(blobs)
    print(f"Found {total} blobs to process: {dict(byext)}\n")

    if args.only_broken:
        print("mode: --only-broken (fixing ONLY no-store and 1-year; leaving everything else)\n")

    patched = skipped = left = errors = 0
    fixing = Counter()   # what current-values are being patched (no-store vs 1yr)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(patch_blob, b, args.dry_run, args.only_broken): b for b in blobs}
        done = 0
        for future in as_completed(futures):
            status, name, cur = future.result()
            done += 1
            if status == "patched":
                patched += 1
                fixing["1-year" if cur == ONE_YEAR else ("no-store" if "no-store" in (cur or "") else cur)] += 1
            elif status == "skipped":
                skipped += 1
            elif status == "left":
                left += 1
            else:
                errors += 1
                print(f"  ERROR: {name} — {cur}")
            if done % 5000 == 0:
                print(f"  {done}/{total} — patch={patched} already30d={skipped} left={left} err={errors}", flush=True)

    label = "Would patch" if args.dry_run else "Patched"
    print(f"\nDone. {label}: {patched}  (by current value: {dict(fixing)})")
    print(f"Already 30 days     : {skipped}")
    print(f"Left untouched      : {left}  (not no-store/1-year)")
    print(f"Errors              : {errors}")


if __name__ == "__main__":
    main()
