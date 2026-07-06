# Runbook — stripping signing params from manifest `.m3u8` files

Removes leftover signed-URL params (`?URLPrefix=…&Expires=…&KeyName=…&Signature=…`)
that are baked into the **text** of `.m3u8` objects in `gs://chai-shots-manifests`
(served as `cdn.chaishots.in`). These are harmless while the edge is
`signedRequestMode: DISABLED` (the edge ignores query strings), but they clutter
the manifests. This runbook cleans them safely.

Two tools, two jobs:

| Tool | Role |
|------|------|
| `aws-infra/verify-cdn-signing.sh` | **Optional gate** — confirms the edge is `DISABLED` and that master/children/segments serve `200`/`206` with params stripped. Uses `gcloud` (your user account). |
| `orchestrator/strip_manifest_params.py` | **Actor** — rewrites the `.m3u8` files param-free and invalidates the CDN. Self-refuses unless the edge is confirmed `DISABLED`. Reads the edge via its **service-account credentials** (no gcloud). |

The **actor is self-contained and fail-closed**: on `--apply` it reads the live
edge config with the same SA that writes/invalidates and refuses unless every
route is `DISABLED`. It does **not** need gcloud. The bash gate is an optional
extra check that does need gcloud auth.

## Identity — this is the important part

The SA must be able to do **both** (a) write `gs://chai-shots-manifests` **and**
(b) invalidate the CDN. Only some SAs can:

| SA | write | invalidate | how to use |
|----|-------|-----------|------------|
| `chai-q-transcoder` (prod) | ✅ | ✅ | `--from-secret <ARN>` (loads it from Secrets Manager, in-memory) |
| `testing-gcp` (local key) | ✅ | ❌ | do NOT use — rewrites files then fails invalidation → stale cache |

Always run with `--from-secret` so the flow uses the prod SA and the private key
is never written to disk.

---

## Preconditions

The actor needs **AWS credentials** (to read the SA from Secrets Manager) — that's it.
No gcloud, no GCP key file.

```bash
# AWS creds that can read the secret (already configured on the dev box):
aws sts get-caller-identity      # should succeed

# The prod SA secret ARN:
ARN=arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd
```

If the SA can't confirm the edge is `DISABLED`, `--apply` exits **2** and touches
nothing. That is intended (fail-closed).

Optional — the bash gate (`verify-cdn-signing.sh`) additionally needs
`gcloud auth login` + `gcloud config set project media-cdn-poc-466009`. It is not
required; the actor self-guards.

---

## The 3-step flow

Run in order for one combined-master URL. `<master>` = the `…_combined.m3u8` URL.
`$ARN` is the prod SA secret from Preconditions.

### 1. DRY-RUN — review the diff (read-only)
```bash
cd orchestrator
python3 strip_manifest_params.py "<master>" --from-secret "$ARN"
echo "exit: $?"     # 0
```
Prints the identity (`chai-q-transcoder …`), each `.m3u8` it would rewrite, the
param count removed, and the CDN prefixes it would invalidate. Nothing is
modified. Sanity-check the file list matches the episode.

### 2. APPLY — must exit 0
```bash
python3 strip_manifest_params.py "<master>" --apply --backup --from-secret "$ARN"
echo "exit: $?"     # must be 0  (2 = refused, 3 = partial/invalidation-failed)
```
The actor first reads the live edge via the SA and **refuses (exit 2)** unless
every route is `DISABLED`. Then it backs up each file to `<path>.bak`, rewrites
param-free (with an `if_generation_match` clobber guard), and **queues** CDN
invalidations. Exit 3 means a write was skipped or an invalidation failed — re-run.

### 3. WAIT, then POST-VERIFY (no gcloud needed)
```bash
# CDN invalidation is ASYNC — the actor only QUEUED it. Wait for propagation.
sleep 300      # ~2–5 min

# (a) re-run the dry-run: every file should now be [clean], "0 cleaned"
python3 strip_manifest_params.py "<master>" --from-secret "$ARN" | grep "scanned"

# (b) confirm the edge now serves a param-free body
curl -s "<master>" | grep -c 'Signature='      # expect 0
```
**Do not skip the wait** — checking (b) too early races the invalidation and can
read the stale still-signed manifest.

> Post-verify is a manual step, not an auto-`--post-verify` flag: an automated
> re-check glued to `--apply` would fire during the invalidation race and be
> flaky by construction. The dry-run check (a) is edge-independent (reads GCS
> directly) so it's true immediately; the curl check (b) needs the wait.

### Optional extra gate (needs gcloud)
Before step 2 you may also run `aws-infra/verify-cdn-signing.sh "<master>"`
(exit 0 = safe). It independently walks master→children→segments over the edge.
It needs `gcloud auth login`; the actor does not depend on it.

---

## Exit codes

**Actor (`strip_manifest_params.py`)**

| Code | Meaning |
|------|---------|
| 0 | Success — files cleaned (or dry-run completed) |
| 1 | Error (bad URL, GCS failure, etc.) |
| 2 | Refused — edge not confirmed `DISABLED` (fix SA creds / edge, or `--force`) |
| 3 | Partial — some files skipped (concurrent change) or an invalidation failed; re-run |

**Gate (`verify-cdn-signing.sh`)**

| Code | Meaning |
|------|---------|
| 0 | Safe — edge confirmed `DISABLED` and all sampled URLs serve clean |
| 1 | Not safe / not certifiable — a route enforces signing, a URL failed, or the config couldn't be read |

---

## Rollback

`--apply --backup` writes `<path>.bak` for each rewritten `.m3u8` before
overwriting. To restore one file:
```bash
gsutil cp gs://chai-shots-manifests/<path>.bak gs://chai-shots-manifests/<path>
# then re-invalidate that prefix
```
Note: `.bak` objects are CDN-reachable and not auto-cleaned — remove them once
you're confident (`gsutil rm gs://chai-shots-manifests/**.bak`).

---

## Scope / assumptions

- Assumes a **single CDN host** (`cdn.chaishots.in`) with **all routes DISABLED**.
  If the topology changes (multiple hosts, a route flipped to `REQUIRE_SIGNATURES`
  / `REQUIRE_TOKENS`), re-audit before use — the actor will refuse on a non-DISABLED
  route, which is the correct behavior.
- Cleans one combined master's chain per invocation (master + children + subtitle
  playlists). Segments (`.m4s`) are binary, carry no params, and are never touched.
- The Mongo `signed_playback_url` field is a **separate** concern handled by the
  resign Lambda — this runbook only touches the GCS `.m3u8` files.
- Do **not** clean params via a CDN config import — see
  `aws-infra/cdn-backups/LESSONS_LEARNED.md` (the 2026-06-10 TLS outage). This
  runbook never touches the edge config; it only rewrites GCS objects.
