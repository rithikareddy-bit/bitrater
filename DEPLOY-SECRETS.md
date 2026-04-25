# Deploy secrets

## After a leaked MongoDB URI

1. **Rotate MongoDB Atlas password**
   Atlas → Database Access → user → Edit → new password. The old password was in public Git history and must be treated as compromised.

2. **Local deploy only**
   - Copy `deploy.env.example` → `.env.deploy` (never committed).
   - Put the **new** `MONGO_URI` there.
   - Run `./deploy.sh` from your machine only.

3. **GitHub security alert**
   After rotating: in the alert, choose **revoke** / close as resolved once the old credential is disabled.

4. **Optional: remove secret from Git history**
   The string may still exist in old commits. To purge (rewrites history — coordinate with team):
   [GitHub: Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

5. **Related repo**
   If the same URI appeared in `rithikareddy-bit/vmaf` (or elsewhere), fix and rotate there too.

---

## Media CDN URL signing — keypair and phased rollout

The resigner Lambda needs an Ed25519 keypair. The private half stays in AWS Secrets Manager; only the public half ever goes to GCP.

### 1. Generate the keypair

```bash
python3 <<'PY'
import base64
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

priv = Ed25519PrivateKey.generate()
priv_bytes = priv.private_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PrivateFormat.Raw,
    encryption_algorithm=serialization.NoEncryption(),
)
pub_bytes = priv.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
print("PRIVATE_B64URL =", base64.urlsafe_b64encode(priv_bytes).decode().rstrip("="))
print("PUBLIC_B64URL  =", base64.urlsafe_b64encode(pub_bytes).decode().rstrip("="))
PY
```

Save both outputs. Treat `PRIVATE_B64URL` like a root password.

### 2. Store the private key in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name chai-q/media-cdn-signing-key \
  --secret-string "$(jq -n \
    --arg key_name "chaishots-playback-keyset" \
    --arg priv "$PRIVATE_B64URL" \
    '{key_name:$key_name, private_key_b64url:$priv}')"
```

The secret name `chai-q/media-cdn-signing-key` is the default for `var.media_cdn_signing_key_secret_id` in `aws-infra/variables.tf`.

**Gotcha:** `key_name` in this JSON is the **keyset name** (`chaishots-playback-keyset`), not the key id within the keyset (`chaishots-playback-key`). The resigner Lambda puts this value into the signed URL's `KeyName=` query parameter, and Media CDN resolves it against keyset short names — not key ids. If you set it to the key id instead, every request returns HTTP 403 with `signed_request_public_keyset_name_mismatch` in Cloud Logging.

### 3. Upload the public key to GCP Media CDN

```bash
gcloud edge-cache keysets create chaishots-playback-keyset \
  --public-key="id=chaishots-playback-key,value=<PUBLIC_B64URL>"
```

*Do not* attach the keyset to the route rule yet — §6 of the implementation plan spells out the phased rollout.

### 4. Phased rollout

The Media CDN keyset must **not** be attached to the catch-all route rule until every URL in showcache is signed. Attaching it route-wide earlier 403s every live viewer. Three phases:

**Phase 0 — Pilot on one episode (30-min TTL, cron disabled).** Point the plan at `shiva-mahathyam` ep 25 (or any single episode). `terraform apply` with:

```hcl
signed_url_ttl_seconds     = 1800
resign_schedule_expression = "rate(25 minutes)"
resign_schedule_enabled    = false
```

Manually invoke the resigner for just the pilot episode, verify the signed URL plays, then add a *priority-1 pilot route rule* in Media CDN that requires signatures for `/$PILOT_EP_ID/*` only — bump the existing catch-all rule to `priority: 2` in the same `export → edit → import`. Every other episode keeps playing unchanged.

**Phase 1 — Catalog soak (30-min TTL, cron enabled).** Flip `resign_schedule_enabled = true` and re-apply. The cron signs every combined-URL episode every 25 minutes. Keyset is still scoped to the pilot route rule, so production traffic is unaffected; Phase 1 is a dry run that only writes to Mongo + GCS.

**Phase 2 — Scale + enforce.** Bump `signed_url_ttl_seconds = 7200` and `resign_schedule_expression = "rate(105 minutes)"`. Manually invoke with `{}` once to re-sign with 2-h expiry. Then in Media CDN: delete the priority-1 pilot rule, change the catch-all back to `priority: 1`, and set `signedRequestMode: REQUIRE_SIGNATURES` + `signedRequestKeyset`. Leave `cacheKeyPolicy.excludeQueryString: true` (already there).

### 5. Rollback (Phase 2 enforcement)

If anything surfaces after enforcement is on:

```bash
gcloud edge-cache services export chai-shorts-media-cdn --destination=/tmp/cdn.yaml
# edit /tmp/cdn.yaml: set signedRequestMode: DISABLED on the catch-all rule;
# remove signedRequestKeyset line.
gcloud edge-cache services import chai-shorts-media-cdn --source=/tmp/cdn.yaml
```

~60 seconds of propagation and viewers are back to unsigned access. Resigner continues writing signed URLs in the background — a no-op from the viewer's perspective while disabled — so re-enabling later is a single `gcloud` apply cycle.

### 6. Key rotation

To rotate the signing key:

1. Generate a new keypair (step 1).
2. Upload the new public key to the existing keyset as a *second* key with a different id (e.g. `chaishots-playback-key-v2`) — Media CDN keysets support multiple keys. **But** the signed URL's `KeyName` is the keyset name, so rotating the key-id alone won't affect what's in the URL; the real rotation is replacing the public key at that id while keeping the keyset unchanged.
3. Write the new private key JSON to `chai-q/media-cdn-signing-key` using `aws secretsmanager put-secret-value` with `{"key_name":"chaishots-playback-keyset", "private_key_b64url":"<new-priv>"}` (keep `key_name` = keyset short name; only `private_key_b64url` changes).
4. Trigger a full sweep — all URLs get re-signed with the new key.
5. After ~2× the TTL (so no cached URLs signed by the old key remain in use), remove the old key from the keyset.
