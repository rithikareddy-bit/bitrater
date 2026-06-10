# CDN Operations — Lessons Learned

## Incident: SSL Outage During Signing Removal (2026-06-10)

### What happened
We disabled CDN signing by running `gcloud edge-cache services import` with a YAML that only
contained routing rules. GCP treated the import as a **full config replacement** and silently
dropped the `edgeSslCertificates` field that wasn't in the file. This removed the TLS certificate
from the CDN service, breaking HTTPS for all of `cdn.chaishots.in`. Every video URL returned
`ERR_SSL_VERSION_OR_CIPHER_MISMATCH` until the cert was restored.

---

### Rule: Always include `edgeSslCertificates` in every import YAML

`gcloud edge-cache services import` **replaces** the entire service config with whatever is in the
YAML. Any field not present in the file is deleted from the live service.

Every YAML you import must include:

```yaml
name: projects/media-cdn-poc-466009/locations/global/edgeCacheServices/chai-shorts-media-cdn
edgeSslCertificates:
- projects/623432890759/locations/global/certificates/media-cdn-ssl
routing:
  ...
```

---

### Rule: Always take a full backup before any CDN import

Before running `gcloud edge-cache services import`, export the current config:

```bash
gcloud edge-cache services export chai-shorts-media-cdn \
  --destination=cdn-backups/cdn-backup-$(date +%Y%m%d-%H%M%S).yaml \
  --project=media-cdn-poc-466009
```

Use the exported file as the base for your changes — never write a YAML from scratch.

---

### Rule: `no-store` on HLS manifests breaks CDN caching

If GCS blobs have `Cache-Control: no-store`, the CDN cannot cache manifests. Every request goes
back to GCS origin, and the CDN reports cache status `N/A`. This causes high TTFB for distant
regions (we measured ~2000ms USA TTFB before the fix).

All HLS/DASH files (`.m3u8`, `.m4s`, `.mp4`, audio segments) must use:

```python
blob.cache_control = "public, max-age=31536000"
```

Never use `no-store` on media files. Content is versioned by timestamp folder
(`{episode_id}/{ddmmyyyy_HHMMSS}/`) so stale cache is not a concern.

---

### Rule: Verify CDN signedRequestMode before and after any config change

After any `gcloud edge-cache services import`, confirm all routes are in the expected mode:

```bash
gcloud edge-cache services describe chai-shorts-media-cdn \
  --project=media-cdn-poc-466009 \
  --format="yaml(edgeSslCertificates,routing.pathMatchers[0].routeRules[].routeAction.cdnPolicy.signedRequestMode)"
```

Expected output (signing disabled):
```yaml
edgeSslCertificates:
- projects/623432890759/locations/global/certificates/media-cdn-ssl
routing:
  pathMatchers:
  - routeRules:
    - routeAction:
        cdnPolicy:
          signedRequestMode: DISABLED
    - routeAction:
        cdnPolicy:
          signedRequestMode: DISABLED
    - routeAction:
        cdnPolicy:
          signedRequestMode: DISABLED
```

---

### Summary checklist for any future CDN config change

- [ ] Export current config as backup first
- [ ] Start from the exported backup, make only the targeted change
- [ ] Ensure `edgeSslCertificates` is present in the YAML
- [ ] After import, verify `edgeSslCertificates` and `signedRequestMode` with describe command
- [ ] Test a CDN URL from browser immediately after import completes
