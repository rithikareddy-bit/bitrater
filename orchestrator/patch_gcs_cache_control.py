"""
One-shot script: set Cache-Control: public, max-age=31536000 on all .m3u8 blobs
in chai-shots-manifests that don't already have that value set.

Run locally:
  python3 patch_gcs_cache_control.py
  python3 patch_gcs_cache_control.py --dry-run       # preview without patching
  python3 patch_gcs_cache_control.py --workers 50    # tune concurrency (default 100)
  python3 patch_gcs_cache_control.py --prefix shows/ # scope to a subtree
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from google.cloud import storage

BUCKET_NAME = "chai-shots-manifests"
TARGET_CACHE_CONTROL = "public, max-age=2592000"
DEFAULT_WORKERS = 100


def patch_blob(blob, dry_run):
    """Returns ('patched'|'skipped'|'error', blob.name, error_msg)"""
    try:
        current = (blob.cache_control or "").strip().lower()
        if current == TARGET_CACHE_CONTROL.lower():
            return ("skipped", blob.name, None)
        if dry_run:
            return ("patched", blob.name, None)
        blob.cache_control = TARGET_CACHE_CONTROL
        blob.patch()
        return ("patched", blob.name, None)
    except Exception as e:
        return ("error", blob.name, str(e))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--prefix", default="")
    args = parser.parse_args()

    client = storage.Client()

    scope = f" (prefix={args.prefix!r})" if args.prefix else ""
    mode = " [DRY RUN]" if args.dry_run else ""
    print(f"Scanning {BUCKET_NAME}{scope} — {args.workers} workers{mode}")

    list_kwargs = {"prefix": args.prefix} if args.prefix else {}
    m3u8_blobs = [
        b for b in client.list_blobs(BUCKET_NAME, **list_kwargs)
        if b.name.endswith(".m3u8")
    ]
    total = len(m3u8_blobs)
    print(f"Found {total} .m3u8 blobs to process\n")

    patched = skipped = errors = 0

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(patch_blob, b, args.dry_run): b for b in m3u8_blobs}
        done = 0
        for future in as_completed(futures):
            status, name, err = future.result()
            done += 1
            if status == "patched":
                patched += 1
            elif status == "skipped":
                skipped += 1
            else:
                errors += 1
                print(f"  ERROR: {name} — {err}")
            if done % 1000 == 0:
                print(f"  {done}/{total} done — patched={patched} skipped={skipped} errors={errors}")

    label = "Would patch" if args.dry_run else "Patched"
    print(f"\nDone. {label}: {patched} | Already correct: {skipped} | Errors: {errors}")


if __name__ == "__main__":
    main()
