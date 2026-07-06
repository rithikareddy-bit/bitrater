"""Strip leftover signing params from the .m3u8 files of ONE combined master.

The resign Lambda only cleans the master URL stored in Mongo. The signing params
(?URLPrefix=...&Expires=...&KeyName=...&Signature=...) are ALSO baked into the
text of every .m3u8 object in gs://chai-shots-manifests (child playlists,
segment lines, EXT-X-MAP, subtitle playlists). Nothing else removes those.

This walks master -> child playlists -> subtitle playlists, strips the params
from every line, re-uploads each changed .m3u8, and (optionally) invalidates the
CDN so the clean copy is served immediately.

Segments (.m4s) are binary and carry no params — they are never touched.

DRY-RUN by default: prints what it WOULD change and uploads nothing.
Pass --apply to actually rewrite GCS + invalidate.

Credentials must belong to a service account that can (a) write the bucket AND
(b) invalidate the CDN. The prod SA `chai-q-transcoder` has both; load it from
AWS Secrets Manager with --from-secret so no key file is ever written to disk.

Usage:
  # dry run as the prod SA (safe, read-only)
  python strip_manifest_params.py "<master .m3u8 URL>" \
      --from-secret arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd

  # actually rewrite + invalidate (refuses unless the edge is confirmed DISABLED)
  python strip_manifest_params.py "<master .m3u8 URL>" --apply --backup \
      --from-secret arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd

  # POST-APPLY verify (no gcloud needed): re-run the dry-run — expect "0 cleaned"
  # (every file [clean]) — then curl the master to confirm no params after ~5 min.

  # Without --from-secret it uses ADC / GOOGLE_APPLICATION_CREDENTIALS, which must
  # still point at an SA with invalidate permission (testing-gcp does NOT have it).

Exit codes: 0 ok | 1 error | 2 refused (edge not confirmed DISABLED) | 3 partial (skipped writes / invalidation failed).
--apply reads the live edge config via the networkservices API using the SAME
service-account credentials that write GCS + invalidate — a single identity, no
gcloud needed — and refuses unless every route is signedRequestMode: DISABLED.
A route that positively ENFORCES signing is a HARD refuse that --force cannot
override; --force only overrides an UNKNOWN (unreadable) edge state.

Credentials: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON with
write access to the bucket + networkservices.edgeCacheServices.invalidateCache,
or rely on application-default credentials.
"""

import argparse
import json
import os
import re
import sys
import time

from google.api_core.exceptions import PreconditionFailed
from google.auth.transport.requests import AuthorizedSession
from google.cloud import storage as gcs

from media_cdn_signer import strip_existing_signing_params

CDN_BASE = os.environ.get("CDN_BASE", "https://cdn.chaishots.in").rstrip("/")
CDN_BUCKET = os.environ.get("CDN_BUCKET", "chai-shots-manifests")
CONTENT_TYPE_M3U8 = "application/x-mpegURL; charset=utf-8"
M3U8_CACHE_CONTROL = "public, max-age=2592000"  # 30 days, matches pipeline

MEDIA_CDN_PROJECT = os.environ.get("MEDIA_CDN_PROJECT", "media-cdn-poc-466009")
MEDIA_CDN_SERVICE = os.environ.get("MEDIA_CDN_SERVICE", "chai-shorts-media-cdn")
MEDIA_CDN_LOCATION = os.environ.get("MEDIA_CDN_LOCATION", "global")
NETWORK_SERVICES_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

# A signing param present in a .m3u8 line = something to strip.
_HAS_PARAMS_RE = re.compile(r"URLPrefix=|Signature=|KeyName=|Expires=")


def edge_signing_status(creds):
    """Query the live Media CDN edge via the networkservices API, using the SAME
    credentials that write GCS + invalidate the cache (single identity — no
    gcloud dependency). Returns (status, detail) where status is one of:

      "disabled"  — every route positively reports DISABLED. Safe to --apply.
      "enforcing" — >=1 route positively reports a non-DISABLED mode. NEVER safe;
                    stripping params would 403 playback. --force must NOT override.
      "unknown"   — could not determine (request error / non-200 / empty body).
                    Fail-closed; --force MAY override (the only legitimate use).

    Do NOT whitelist enum values: the Media CDN enum is DISABLED |
    REQUIRE_SIGNATURES | REQUIRE_TOKENS, and anything not exactly DISABLED (incl.
    future enums) counts as enforcing.
    """
    scoped = creds.with_scopes([NETWORK_SERVICES_SCOPE]) if hasattr(creds, "with_scopes") else creds
    session = AuthorizedSession(scoped)
    resource = (
        f"projects/{MEDIA_CDN_PROJECT}/locations/{MEDIA_CDN_LOCATION}"
        f"/edgeCacheServices/{MEDIA_CDN_SERVICE}"
    )
    url = f"https://networkservices.googleapis.com/v1/{resource}"
    try:
        r = session.get(url, timeout=60)
    except Exception as e:
        return "unknown", f"edge describe request failed: {e}"
    if r.status_code != 200:
        return "unknown", f"edge describe HTTP {r.status_code}: {r.text.strip()[:200]}"

    modes = re.findall(r'"signedRequestMode":\s*"([A-Z_]+)"', r.text)
    if not modes:
        return "unknown", f"could not read any signedRequestMode (body: {r.text.strip()[:200]!r})"
    non_disabled = [m for m in modes if m != "DISABLED"]
    if non_disabled:
        return "enforcing", f"{len(non_disabled)}/{len(modes)} route(s) ENFORCE signing: {sorted(set(non_disabled))}"
    return "disabled", f"all {len(modes)} route(s) DISABLED"


def client_from_secret(secret_arn: str):
    """Build a GCS client from a service-account JSON stored in AWS Secrets
    Manager, held ONLY in memory — the private key is never written to disk.
    Returns (gcs.Client, client_email). Region is parsed from the ARN.

    boto3 is imported lazily so the tool has no AWS dependency unless this is used.
    """
    import boto3  # lazy: only needed for --from-secret
    region = secret_arn.split(":")[3] if secret_arn.startswith("arn:") else os.environ.get("AWS_REGION", "us-east-1")
    sm = boto3.client("secretsmanager", region_name=region)
    info = json.loads(sm.get_secret_value(SecretId=secret_arn)["SecretString"])
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_info(info)
    return gcs.Client(credentials=creds, project=info.get("project_id")), info.get("client_email")


def _gcs_path_from_url(url: str) -> str:
    """CDN_BASE-rooted absolute URL -> bucket object path (no query string)."""
    base = CDN_BASE + "/"
    if not url.startswith(base):
        raise ValueError(f"URL not under CDN_BASE ({CDN_BASE}): {url}")
    return url[len(base):].split("?", 1)[0]


def _resolve_child_m3u8(parent_path: str, ref: str) -> str:
    """Resolve a .m3u8 reference (absolute CDN URL or relative) to a bucket path."""
    ref = ref.split("?", 1)[0]
    if ref.startswith(CDN_BASE + "/"):
        return _gcs_path_from_url(ref)
    if ref.startswith(("http://", "https://")):
        raise ValueError(f"Off-CDN reference, refusing to follow: {ref}")
    if ref.startswith("/"):
        return ref.lstrip("/")
    parent_dir = parent_path.rsplit("/", 1)[0] if "/" in parent_path else ""
    return f"{parent_dir}/{ref}" if parent_dir else ref


def _child_m3u8_refs(text: str):
    """Every .m3u8 reference in a manifest body: bare URI lines + URI="..." attrs."""
    refs = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            m = re.search(r'URI="([^"]+)"', s)
            if m and ".m3u8" in m.group(1):
                refs.append(m.group(1))
        elif ".m3u8" in s:
            refs.append(s)
    return refs


def process(master_url: str, apply: bool, invalidate: bool,
            backup: bool = False, force: bool = False, client=None,
            invalidation_delay: float = 0.0) -> dict:
    # client can be injected (e.g. built from in-memory credentials so a prod key
    # is never written to disk); falls back to ADC / GOOGLE_APPLICATION_CREDENTIALS.
    if client is None:
        client = gcs.Client()
    bucket = client.bucket(CDN_BUCKET)

    # --- Gap #1: couple actor to the safety gate. Refuse to mutate unless the
    #     live edge positively reports every route DISABLED. Fail-closed.
    if apply:
        status, detail = edge_signing_status(client._credentials)
        print(f"edge check: {detail}")
        aborted = {"changed": 0, "aborted": True, "invalidation_failed": False,
                   "write_skipped": 0, "prefixes": [], "edge_status": status}
        if status == "enforcing":
            # Hard block — NOT overridable by --force. Stripping params off segments
            # while the edge enforces signing would 403 playback.
            print(
                "\nREFUSING --apply: the edge POSITIVELY ENFORCES signing on >=1 route.\n"
                "Stripping params now would 403 playback. --force CANNOT override a\n"
                "confirmed-enforcing edge — fix the edge config first.",
                file=sys.stderr,
            )
            return aborted
        if status != "disabled" and not force:
            # "unknown" — could not READ the edge (e.g. transient network error).
            # Not the same as enforcing; the caller may retry/resume.
            print(
                "\nREFUSING --apply: could not confirm the edge is DISABLED (state unknown).\n"
                "Fix credentials / connectivity, or override with --force ONLY if you are\n"
                "certain the edge is DISABLED.",
                file=sys.stderr,
            )
            return aborted
        if status == "unknown" and force:
            print("  (--force: proceeding despite UNKNOWN edge state — allowed because it is "
                  "not a confirmed-enforcing edge)")
        print()

    master_path = _gcs_path_from_url(master_url)
    queue = [master_path]
    seen = set()
    changed_prefixes = set()
    changed_files = 0
    write_skipped = 0
    scanned = 0

    print(f"{'APPLY' if apply else 'DRY-RUN'}  bucket=gs://{CDN_BUCKET}")
    print(f"master: {master_path}\n")

    while queue:
        path = queue.pop(0)
        if path in seen:
            continue
        seen.add(path)

        # get_blob() does a metadata GET that reliably populates .generation
        # (bucket.blob()+.exists() leaves it None, making if_generation_match a
        # silent no-op). Returns None when the object is absent.
        blob = bucket.get_blob(path)
        if blob is None:
            print(f"  [MISS] {path}  (referenced but not found — skipping)")
            continue

        # Capture metadata NOW, BEFORE download_as_text() — that call overwrites
        # blob.cache_control with the download-response header (no-cache/no-store),
        # so reading it afterwards yields the wrong value. (This was the cache-control
        # regression.) Preserve the real stored values from get_blob().
        orig_cache_control = blob.cache_control
        orig_content_type = blob.content_type

        text = blob.download_as_text(encoding="utf-8")
        scanned += 1

        # Discover child .m3u8 files from the ORIGINAL text (before stripping).
        for ref in _child_m3u8_refs(text):
            try:
                child = _resolve_child_m3u8(path, ref)
            except ValueError as e:
                print(f"  [WARN] {e}")
                continue
            if child not in seen:
                queue.append(child)

        stripped = strip_existing_signing_params(text)
        if stripped == text:
            print(f"  [clean] {path}")
            continue

        n_params = len(_HAS_PARAMS_RE.findall(text))
        prefix = path.rsplit("/", 1)[0]
        print(f"  [STRIP] {path}  ({n_params} param occurrences removed)")

        # changed_files / changed_prefixes count ONLY changes we actually commit
        # (dry-run: would-commit; apply: successfully written) so a concurrent
        # skip never overcounts nor drops a sibling's invalidation prefix.
        if not apply:
            changed_files += 1
            changed_prefixes.add(prefix)
            continue

        gen = blob.generation  # reliably set by get_blob(); real concurrent-clobber guard
        if backup:
            bucket.copy_blob(blob, bucket, f"{path}.bak")
            print(f"           -> backed up to {path}.bak")
        # Preserve the object's existing cache policy + content-type (captured
        # from get_blob BEFORE download_as_text corrupted them). Only fall back to
        # defaults if genuinely unset. Stripping params must not change metadata.
        blob.cache_control = orig_cache_control or M3U8_CACHE_CONTROL
        ctype = orig_content_type or CONTENT_TYPE_M3U8
        try:
            blob.upload_from_string(
                stripped, content_type=ctype,
                if_generation_match=gen,
            )
        except PreconditionFailed:
            write_skipped += 1
            print(f"           -> SKIPPED: {path} changed concurrently (generation moved); re-run to clean it")
            continue
        changed_files += 1
        changed_prefixes.add(prefix)
        print(f"           -> re-uploaded clean ({len(stripped)} bytes)")

    print(f"\nscanned {scanned} .m3u8 file(s); {changed_files} cleaned"
          + (f", {write_skipped} skipped (concurrent change)" if write_skipped else "") + ".")

    invalidation_failed = False
    if changed_files and invalidate:
        if apply:
            invalidation_failed = _invalidate(client, sorted(changed_prefixes),
                                              delay=invalidation_delay) > 0
        else:
            print("would invalidate CDN prefixes:")
            for p in sorted(changed_prefixes):
                print(f"    /{p}/*")

    if not apply:
        print("\nDRY-RUN — nothing was modified. Re-run with --apply to make it real.")
    return {"changed": changed_files, "aborted": False,
            "invalidation_failed": invalidation_failed, "write_skipped": write_skipped,
            "prefixes": sorted(changed_prefixes)}


def _invalidate(client, prefixes, delay=0.0, max_retries=5) -> int:
    """Invalidate each prefix, PACED (`delay` s between calls) and with exponential
    backoff on rate-limit (429) / transient 5xx / network errors, so a large batch
    can never hammer the CDN or fail on a temporary quota hiccup. Returns the number
    of invalidations that FAILED even after retries (caller exits non-zero)."""
    creds = client._credentials
    scoped = creds.with_scopes([NETWORK_SERVICES_SCOPE]) if hasattr(creds, "with_scopes") else creds
    session = AuthorizedSession(scoped)
    service_path = (
        f"projects/{MEDIA_CDN_PROJECT}/locations/{MEDIA_CDN_LOCATION}"
        f"/edgeCacheServices/{MEDIA_CDN_SERVICE}"
    )
    url = f"https://networkservices.googleapis.com/v1/{service_path}:invalidateCache"
    failed = 0
    for i, prefix in enumerate(prefixes):
        if i > 0 and delay:
            time.sleep(delay)                      # pace between invalidations
        path_pattern = f"/{prefix.strip('/')}/*"
        for attempt in range(max_retries + 1):
            try:
                resp = session.post(url, json={"path": path_pattern}, timeout=60)
                code = resp.status_code
            except Exception as e:
                if attempt < max_retries:
                    backoff = min(120, 5 * (2 ** attempt))
                    print(f"[CDN] {path_pattern} request error ({e}); retry in {backoff}s")
                    time.sleep(backoff)
                    continue
                failed += 1
                print(f"[CDN] invalidation ERROR for {path_pattern}: {e}")
                break
            if code < 300:
                print(f"[CDN] invalidation queued for {path_pattern}")
                break
            if code in (429, 500, 502, 503, 504) and attempt < max_retries:
                backoff = min(120, 5 * (2 ** attempt))
                print(f"[CDN] {path_pattern} HTTP {code} (rate-limit/transient); backing off {backoff}s")
                time.sleep(backoff)
                continue
            failed += 1
            print(f"[CDN] invalidation FAILED for {path_pattern}: {code} {resp.text[:200]}")
            break
    return failed


def main():
    ap = argparse.ArgumentParser(description="Strip signing params from a combined master's .m3u8 files.")
    ap.add_argument("master_url", help="Combined master .m3u8 URL (with or without ?params)")
    ap.add_argument("--apply", action="store_true", help="Actually rewrite GCS + invalidate (default: dry run)")
    ap.add_argument("--no-invalidate", dest="invalidate", action="store_false", help="Skip CDN invalidation")
    ap.add_argument("--backup", action="store_true", help="Copy each .m3u8 to <path>.bak before overwriting")
    ap.add_argument("--force", action="store_true",
                    help="Override an UNKNOWN edge state (config unreadable) only. Cannot override a "
                         "confirmed-enforcing edge. Use only if you are certain the edge is DISABLED.")
    ap.add_argument("--from-secret", metavar="ARN",
                    help="Load the service account from AWS Secrets Manager (in-memory, no key file). "
                         "Use this to run as the prod SA that can invalidate the CDN.")
    ap.add_argument("--invalidation-delay", type=float, default=0.0,
                    help="Seconds to pause between CDN invalidation calls (rate-limit safety)")
    args = ap.parse_args()

    try:
        client = None
        if args.from_secret:
            client, ident = client_from_secret(args.from_secret)
            print(f"credentials: {ident} (from Secrets Manager, in-memory)\n")
        result = process(
            args.master_url, apply=args.apply, invalidate=args.invalidate,
            backup=args.backup, force=args.force, client=client,
            invalidation_delay=args.invalidation_delay,
        )
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if result["aborted"]:
        sys.exit(2)                       # refused: edge not confirmed DISABLED
    if result.get("write_skipped"):
        print(
            f"\nWARNING: {result['write_skipped']} file(s) skipped due to concurrent "
            "changes and were NOT cleaned — re-run to finish them.",
            file=sys.stderr,
        )
        sys.exit(3)                       # partial: not everything was cleaned
    if result["invalidation_failed"]:
        print(
            "\nWARNING: one or more CDN invalidations failed — the stale signed "
            ".m3u8 may serve for up to 30 days. Re-run invalidation before trusting this.",
            file=sys.stderr,
        )
        sys.exit(3)                       # Gap #6: failed invalidation is NOT success
    sys.exit(0)


if __name__ == "__main__":
    main()
