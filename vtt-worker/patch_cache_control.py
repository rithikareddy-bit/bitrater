"""
One-shot: patch Cache-Control on existing sprite/VTT blobs to `no-cache, max-age=0`.

Blobs uploaded before commit 578a63f inherited the GCS bucket default
(`public, max-age=3600`), which makes regenerated content appear stale for up
to an hour at Google's edge plus any downstream caches. This script walks
`output/webp/` and rewrites `cache_control` metadata (no content re-upload).

Usage:
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
      python patch_cache_control.py --bucket media-cdn-poc-466009-sprites [--dry-run]
"""
from __future__ import annotations

import argparse
import fnmatch
import sys

from google.cloud import storage as gcs_storage


TARGET_CACHE_CONTROL = "no-cache, max-age=0"
PREFIX = "output/webp/"
PATTERNS = ("*-sprite.webp", "*-sprite-*.webp", "*-thumbnails.vtt")


def iter_target_blobs(client: gcs_storage.Client, bucket_name: str):
    # list_blobs returns cacheControl in the metadata already — don't reload() per blob.
    it = client.list_blobs(
        bucket_name,
        prefix=PREFIX,
        fields="items(name,cacheControl),nextPageToken",
    )
    for blob in it:
        name = blob.name.rsplit("/", 1)[-1]
        if any(fnmatch.fnmatch(name, pat) for pat in PATTERNS):
            yield blob


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    client = gcs_storage.Client()
    patched = skipped = seen = 0

    print(f"Scanning gs://{args.bucket}/{PREFIX} (dry_run={args.dry_run}) ...", flush=True)
    for blob in iter_target_blobs(client, args.bucket):
        seen += 1
        current = blob.cache_control or ""
        if current == TARGET_CACHE_CONTROL:
            skipped += 1
        else:
            print(
                f"[patch] gs://{args.bucket}/{blob.name}  "
                f"{current or '(default)'} -> {TARGET_CACHE_CONTROL}",
                flush=True,
            )
            if not args.dry_run:
                blob.cache_control = TARGET_CACHE_CONTROL
                blob.patch()
            patched += 1

        if seen % 100 == 0:
            print(f"  ... scanned {seen} (patched={patched} skipped={skipped})", flush=True)

    print(
        f"Done. seen={seen} patched={patched} skipped={skipped} dry_run={args.dry_run}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
