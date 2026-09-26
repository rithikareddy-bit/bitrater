"""Re-sign combined-master CDN URLs in showcache (Ed25519, rotating token).

Puts a rotating signed token (full-path: Expires/KeyName/Signature) on every
combined playback master (`*_combined.m3u8` — episodes + trailers) in
master.showcache. Only the master URL is signed; children/segments are served
open by the edge, so we never rewrite GCS manifests here (that path caused the
900 s timeout + no-store caching breakage).

Two invocation modes (one handler):
  event == {}                              → full sweep of master.showcache
  event == {"episode_id", "canonical_url"} → update one episode/trailer (from sync route)

Kill switch: SIGNING_ENABLED=false reverts to writing canonical (unsigned) URLs
and clears `signed_playback_expires_at`, so disabling signing is a one-flag flip.
"""

import json
import os
import re

import boto3
import pymongo
from pymongo import UpdateOne
from pymongo.errors import BulkWriteError
from bson import ObjectId
from datetime import datetime, timedelta, timezone

import media_cdn_signer
import runtime_config
import secret_store


CDN_BASE = os.environ["CDN_BASE"]
COMBINED_MARKER = "_combined.m3u8"
TRAILER_ID_RE = re.compile(r"^trailer_([a-f0-9]{24})_(.+)$")
# Full-sweep writes are batched via bulk_write so ~3k+ episodes become a handful
# of round-trips (~seconds) instead of one update_one each (~10 min at Atlas
# latency, which crept toward the 900s Lambda limit).
BULK_BATCH_SIZE = 1000

# Cached at module scope so a full sweep fetches the key from Secrets Manager once.
_SIGNING_KEY = None


def _signing_enabled() -> bool:
    """Master kill switch. Default on; SIGNING_ENABLED=false reverts to unsigned URLs."""
    return os.environ.get("SIGNING_ENABLED", "true").lower() != "false"


def _ttl_seconds() -> int:
    """Signed-URL lifetime. Production 36000 (10 h) vs the 2 h rotation → 8 h mid-play margin."""
    return int(os.environ.get("SIGNED_URL_TTL_SECONDS", "36000"))


def _get_signing_key():
    """Return (key_name, private_key_b64url) from Secrets Manager, cached per container.

    Secret body shape (see aws-infra/variables.tf):
        {"key_name": "...", "private_key_b64url": "..."}
    """
    global _SIGNING_KEY
    if _SIGNING_KEY is None:
        info = secret_store.get_json(os.environ["SIGNING_KEY_SECRET_ID"])
        _SIGNING_KEY = (info["key_name"], info["private_key_b64url"])
    return _SIGNING_KEY


def _signing_mode() -> str:
    """`signature` (default → REQUIRE_SIGNATURES) or `token` (→ REQUIRE_TOKENS).

    Defaults to `signature` so deploying the token code is INERT until the flag is
    flipped to `token`. Format only — targeting (combined masters), rotation, TTL,
    and the Mongo-only write path are identical either way.
    """
    return os.environ.get("SIGNING_MODE", "signature").lower()


def _token_query_param() -> str:
    """Query-param name that carries the token; must match the CDN route (plan O1)."""
    return os.environ.get("TOKEN_QUERY_PARAM", "edge-cache-token")


def _sign(url: str, now: datetime) -> tuple:
    """Sign a combined-master URL. Returns (signed_url, expires_at datetime).

    Scoped to this exact master file (full path), not its directory — children/
    segments are authorized only by the edge's open routes, never by this
    credential. `signature` mode emits REQUIRE_SIGNATURES params; `token` mode
    emits a REQUIRE_TOKENS FullPath token.
    """
    key_name, private_key_b64url = _get_signing_key()
    expires_at = now + timedelta(seconds=_ttl_seconds())
    expires_unix = int(expires_at.timestamp())
    if _signing_mode() == "token":
        qs = media_cdn_signer.sign_token_fullpath(
            url, expires_unix, private_key_b64url, token_param=_token_query_param())
    else:
        qs = media_cdn_signer.sign_url(url, expires_unix, key_name, private_key_b64url)
    return media_cdn_signer.append_signing_params(url, qs), expires_at


def _build_write(episode_id: str, url: str, now: datetime):
    """Sign `url` (canonical, param-free) and build its master.showcache write.

    Returns (filter, update, array_filters, final_url, expires_at). Only combined
    masters are enforced at the edge, so only they are signed; anything else is
    written canonical/unsigned defensively (shouldn't reach here — the sweep
    filters on COMBINED_MARKER and the sync route sends combined). With signing
    disabled, writes the canonical URL and clears `signed_playback_expires_at`.
    """
    if _signing_enabled() and COMBINED_MARKER in url:
        final_url, expires_at = _sign(url, now)
    else:
        final_url, expires_at = url, None

    trailer_match = TRAILER_ID_RE.match(episode_id)
    if trailer_match:
        show_id_hex, trailer_key = trailer_match.group(1), trailer_match.group(2)
        flt = {"_id": ObjectId(show_id_hex)}
        update = _build_update(
            {"trailers_playback_urls.$[t].gcpUrl": final_url},
            "trailers_playback_urls.$[t].signed_playback_expires_at", expires_at)
        array_filters = [{"t._key": trailer_key}]
    else:
        flt = {"episodes.id": episode_id}
        update = _build_update(
            {"episodes.$[ep].signed_playback_url": final_url},
            "episodes.$[ep].signed_playback_expires_at", expires_at)
        array_filters = [{"ep.id": episode_id}]
    return flt, update, array_filters, final_url, expires_at


def _write_showcache(mongo_client, episode_id: str, url: str, now: datetime) -> dict:
    """Single-episode write (the sync route path).

    Returns {"matched": bool, "url": final_url, "expires_at": datetime|None}.
    """
    flt, update, array_filters, final_url, expires_at = _build_write(episode_id, url, now)
    result = mongo_client[runtime_config.DB_MASTER]["showcache"].update_one(flt, update, array_filters=array_filters)
    return {"matched": result.matched_count > 0, "url": final_url, "expires_at": expires_at}


def _build_update(set_ops: dict, exp_field: str, expires_at) -> dict:
    """Assemble the Mongo update doc: $set the URL, and $set/$unset the expiry field."""
    if expires_at is not None:
        return {"$set": {**set_ops, exp_field: expires_at}}
    return {"$set": set_ops, "$unset": {exp_field: ""}}


def _collect_sweep_targets(mongo_client) -> list:
    showcache = mongo_client[runtime_config.DB_MASTER]["showcache"]
    targets = []
    cursor = showcache.find(
        {},
        {"_id": 1, "episodes.id": 1, "episodes.signed_playback_url": 1,
         "trailers_playback_urls._key": 1, "trailers_playback_urls.gcpUrl": 1},
    )
    for show in cursor:
        for ep in show.get("episodes") or []:
            url = ep.get("signed_playback_url")
            if url and COMBINED_MARKER in url:
                targets.append({
                    "episode_id": ep["id"],
                    "canonical": url.split("?", 1)[0],
                })
        for t in show.get("trailers_playback_urls") or []:
            url = t.get("gcpUrl")
            if url and COMBINED_MARKER in url:
                targets.append({
                    "episode_id": f"trailer_{show['_id']}_{t['_key']}",
                    "canonical": url.split("?", 1)[0],
                })
    return targets


def _flush_batch(master, ops: list) -> tuple:
    """bulk_write a batch of UpdateOne ops (unordered so one bad op can't abort
    the batch). Returns (matched_count, [error dicts])."""
    if not ops:
        return 0, []
    try:
        res = master.bulk_write(ops, ordered=False)
        return res.matched_count, []
    except BulkWriteError as bwe:
        errs = [{"index": we.get("index"), "error": we.get("errmsg")}
                for we in bwe.details.get("writeErrors", [])]
        return bwe.details.get("nMatched", 0), errs


def handler(event, context):
    mongo_client = pymongo.MongoClient(os.environ["MONGO_URI"])
    now = datetime.now(timezone.utc)

    try:
        if event and event.get("episode_id"):
            canonical = event["canonical_url"].split("?", 1)[0]
            res = _write_showcache(mongo_client, event["episode_id"], canonical, now)
            return {
                "episode_id": event["episode_id"],
                "signed": _signing_enabled(),
                "signed_url": res["url"],
                "expires": res["expires_at"].isoformat() if res["expires_at"] else None,
            }

        # Full sweep — re-sign every combined master in showcache, batched via
        # bulk_write (a few round-trips, ~seconds) instead of one update_one each.
        started_at = now
        # Warm + validate the signing key once up front so a missing/malformed
        # secret fails the whole run fast instead of erroring on every target.
        if _signing_enabled():
            _get_signing_key()
        targets = _collect_sweep_targets(mongo_client)
        master = mongo_client[runtime_config.DB_MASTER]["showcache"]
        ops = []
        updated = 0
        errors = []
        for t in targets:
            try:
                flt, update, array_filters, _, _ = _build_write(t["episode_id"], t["canonical"], now)
                ops.append(UpdateOne(flt, update, array_filters=array_filters))
            except Exception as exc:  # a bad doc must not abort the whole sweep
                errors.append({"episode_id": t["episode_id"], "error": str(exc)})
            if len(ops) >= BULK_BATCH_SIZE:
                m, errs = _flush_batch(master, ops); updated += m; errors += errs; ops = []
        m, errs = _flush_batch(master, ops); updated += m; errors += errs
        skipped = max(0, len(targets) - updated - len(errors))

        finished_at = datetime.now(timezone.utc)
        run_doc = {
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_s": (finished_at - started_at).total_seconds(),
            "updated_count": updated,
            "skipped_count": skipped,
            "errors": errors,
            "signing_disabled": not _signing_enabled(),
            "ttl_seconds": _ttl_seconds(),
        }
        mongo_client[runtime_config.DB_LAB]["playback_resign_runs"].insert_one(dict(run_doc))
        run_doc["started_at"] = run_doc["started_at"].isoformat()
        run_doc["finished_at"] = run_doc["finished_at"].isoformat()
        return run_doc
    finally:
        mongo_client.close()
