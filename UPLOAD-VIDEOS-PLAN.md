# Upload Videos — Plan

Reference inspected (not kept in repo): https://github.com/reallycoolthings-org/AdminTool-Mongo
Their flow: browser → `POST /api/v1/upload/s3` (multipart form) → server returns `{ url }`. That works for images (small files). It will **not** work as-is for multi-GB master videos because:
- Next.js / serverless API routes buffer the body (memory + body-size limits, typically 4.5 MB on Vercel; ~100 MB practical even self-hosted).
- A 4-min original at "high GB" needs resumable multipart upload going straight to S3.

So we adapt the idea: keep the page UX (show → episode → upload) but use **S3 multipart presigned URLs** so the file streams browser-direct to S3.

---

## 1. Scope

New page `/upload-videos` in `dashboard/` that lets an operator:
1. Pick a show (reuse existing `GET /api/shows` listing).
2. Expand to its episodes (reuse `GET /api/shows/[id]` shape).
3. For each episode row, upload a large source video (multi-GB `.mp4`/`.mov`/`.mkv`).
4. File streams **direct to S3** via multipart presigned URLs (no server proxy).
5. On completion, write the resulting `s3://…` URL into `master.showcache` at `episodes[index].s3_url` (matches what the rest of the codebase already reads — see `dashboard/lib/showcacheLookup.js` and `dashboard/app/api/episode/[id]/route.js`).
6. Show per-episode upload state (idle / uploading % / done / failed) with the existing `s3_url` displayed when present.

Out of scope (existing pipeline already handles it once `s3_url` lands):
- Transcoding to HLS, signing, VTT, etc. — those are kicked off by other routes (auto-pipeline, gcp, lab).

---

## 2. Data model

Mongo collection `master.showcache`, document shape (already in use):
```
{
  _id, title, slug, language,
  episodes: [
    { _id?, title, episode_number, s3_url, ... },
    ...
  ]
}
```

Write target: `showcache.episodes[N].s3_url` (string, full `s3://bucket/key` or `https://…` — match whatever the rest of the pipeline expects; check one existing doc before deciding final form). Also stamp `episodes[N].s3_url_updated_at = new Date()` and top-level `updated_at` so it sorts to the top on the home page.

DB selection:
- `MONGO_URI` → prod (`master` db) — default for this page.
- `SUBTITLE_MONGO_URI` → dev (`gld2sqs` db) — opt-in via an "Environment: dev / prod" toggle at the top of the page. `dashboard/lib/mongodb.js` already exposes both via `clientPromise()` and `getDevClientPromise()`.

---

## 3. S3

- Bucket: **`sanity-dev-store`** (confirmed by sampling live `episodes[].s3_url` values — all 86 shows with sources point here). Region: **`ap-south-2`**. We MUST use this bucket — the encoding workers (Lab/GCP) have IAM read scoped to it; a new bucket would silently break the next encode.
- Existing files live under `videos/<slug>/...` (flat). To avoid disturbing legacy paths and to give us a clean audit/lifecycle surface, new uploads go under a **separate top-level prefix** `uploads/episodes/` in the same bucket.
- Key layout (folder hierarchy in S3):
  ```
  ${UPLOAD_S3_PREFIX}/                       # overall folder, e.g. uploads/episodes/
    ${slug}/                                 # one folder per show
      ep-${episodeNumberPadded}/             # one folder per episode
        ${timestamp}-${safeFileName}.${ext}  # the upload itself
  ```
  Example: `uploads/episodes/kota-bommali/ep-003/1715760000-master.mp4`.
  - `slug` lower-cased, non-`[a-z0-9-]` stripped.
  - `episodeNumberPadded` = `String(episode_number).padStart(3,'0')` (falls back to `ep-idx-${index}` only if `episode_number` is missing — and `init` rejects that case per gap #5).
  - Timestamp prefix keeps prior uploads visible in the bucket if versioning is off (see gap #7).
- ACL: none (private). Buckets in this repo are private + signed.
- SDK: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — already in `dashboard/package.json`. No new deps.

CORS on bucket (must verify, may need to add): allow `PUT`, `POST`, `GET`, `HEAD` from the dashboard origin, expose `ETag` header (required for multipart).

---

## 4. API routes (new, under `dashboard/app/api/uploads/`)

All routes accept `?env=prod|dev` to pick which Mongo to write to. Default `prod`.

1. `POST /api/uploads/init`
   - Body: `{ slug, episodeIndex, fileName, fileSize, contentType }`
   - Server: validates show+episode exist; computes S3 key; calls `CreateMultipartUploadCommand`; returns `{ uploadId, key, bucket, partSize }`.
   - `partSize` = 16 MiB (tuned for a few-GB file; ≤10,000 parts).

2. `POST /api/uploads/sign-part`
   - Body: `{ key, uploadId, partNumber }`
   - Returns a single presigned `UploadPart` URL (15 min expiry). Browser PUTs the part bytes directly.
   - (Alternative: sign N URLs in one call. Single-part calls keep the surface simple and let us re-sign on retry.)

3. `POST /api/uploads/complete`
   - Body: `{ key, uploadId, parts: [{ PartNumber, ETag }], slug, episodeIndex, env }`
   - Server: `CompleteMultipartUploadCommand`, then updates `showcache.episodes[N].s3_url` + `s3_url_updated_at` + top-level `updated_at`. Returns the final S3 URL.

4. `POST /api/uploads/abort`
   - Body: `{ key, uploadId }` — `AbortMultipartUploadCommand` (called on cancel / page close).

All routes share `lib/uploadAuth.js` (basic guard — same pattern as the other admin routes; if there is no existing auth, mirror what `subtitle-uploads` / other admin endpoints do).

---

## 5. Client page `dashboard/app/upload-videos/page.js`

- Reuses the show grid pattern from `dashboard/app/page.js`. On expand, fetch episodes from `GET /api/shows/[id]` (same call the home page already does — confirm shape, fall back to a thin new `GET /api/uploads/episodes?slug=...` only if `[id]` doesn't expose `episodes[].s3_url`).
- Per-episode row UI:
  - `<input type="file" accept="video/*">`
  - "Upload" button (disabled while uploading)
  - Progress bar (0–100%)
  - Current `s3_url` link (truncated) if present
  - "Cancel" button (calls `/abort`)
- Uploader logic (`dashboard/lib/multipartUploader.js`):
  1. `init` → get `uploadId`, `key`, `partSize`.
  2. Slice file into parts; for each: `fetch sign-part` → `fetch(presignedUrl, { method:'PUT', body: chunk })` → record `ETag` from response header.
  3. Run 3–4 parts in parallel; retry each part up to 3× on network error.
  4. `complete` with the ETag list.
  5. Update local row state with returned URL.
- Sticky env toggle (prod | dev) at top — defaults to prod with a confirm dialog the first time a user uploads to prod.
- Search box (slug contains) — same as home page.

---

## 5b. Gaps caught during end-to-end review (fold into impl)

**Critical — silent breakage if missed**
- **G1. Progress needs XHR, not `fetch`.** `fetch()` has no upload-progress event. Use `XMLHttpRequest` per part (`xhr.upload.onprogress`); aggregate bytes across parallel parts for the bar.
- **G2. Disable SDK flexible checksums when presigning.** `@aws-sdk/client-s3 ^3.1027.0` adds `x-amz-checksum-crc32` into the signature for `UploadPartCommand`. The browser PUT won't send it → `SignatureDoesNotMatch`. When constructing the `S3Client` for presigning, pass `requestChecksumCalculation: "WHEN_REQUIRED"` and explicitly omit `ChecksumAlgorithm` from the command input. Verify by inspecting the presigned URL — it must NOT include `x-amz-sdk-checksum-algorithm` in `SignedHeaders`.
- **G3. Bucket CORS — exact spec.**
  ```json
  [{
    "AllowedMethods": ["PUT","GET","HEAD"],
    "AllowedOrigins": ["<dashboard origin>"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
  ```
  Without `ExposeHeaders: ETag` the browser cannot read the ETag → `/complete` is impossible.
- **G4. Content-Type binding is end-to-end.** Decision: **do not sign `ContentType`**, and the browser PUT also omits `Content-Type` (or sends `application/octet-stream`). Avoids the "exact match" trap entirely. Final stored object's content-type is set via a follow-up `CopyObject`-with-metadata or accepted as `binary/octet-stream` (the existing pipeline doesn't read it).

**Correctness**
- **G5. Address episodes by `episode_number`, not array index.** `init` resolves `(slug, episodeNumber) → episode`; if not found, returns 404. No index fallback. Eliminates the silent-wrong-episode race.
- **G6. Validate target exists in `init`.** Server confirms the show doc exists and contains a matching episode before issuing `CreateMultipartUpload`. Reject early so we don't leave orphan multiparts.
- **G7. Don't blindly overwrite `s3_url`.** On `complete`: if the row already has an `s3_url`, copy it to `episodes[].s3_url_previous` (with `s3_url_previous_at`) before overwriting. Also: confirm bucket versioning is enabled; if not, document that it MUST be turned on before the first prod upload.
- **G8. `updated_at` is a `Date`.** `/api/shows` does `$convert: { to: 'date' }`. Use `new Date()` when writing, not an ISO string, to match what's already there and keep the sort cheap.
- **G9. No automatic downstream trigger.** `/complete` stops at writing `s3_url`. Operator manually starts the encode pipeline via the existing buttons. Reason: safer, avoids accidental prod re-encodes.

**Operational**
- **G10. Retries re-sign, not reuse.** Presigned URL TTL = 15 min. On any part error, drop the cached URL and call `/sign-part` again. Limit: 3 retries per part with exponential backoff.
- **G11. `beforeunload` → `navigator.sendBeacon`.** Send a `Blob` with `type: 'application/json'`:
  ```js
  navigator.sendBeacon('/api/uploads/abort',
    new Blob([JSON.stringify({key, uploadId})], { type: 'application/json' }));
  ```
  Plain `fetch` here is cancelled by the browser on unload.
- **G12. SSE-KMS IAM.** If the bucket has default SSE-KMS, the dashboard role also needs `kms:GenerateDataKey` and `kms:Decrypt` on the key ARN. Add to the IAM block.
- **G13. Region must be explicit.** `UPLOAD_S3_REGION` is **required** (no fallback to `AWS_REGION`, which is `us-east-1` in most of this repo and would mis-sign URLs for an `ap-south-2` bucket). `init` throws if unset.
- **G14. Auth — block on answer to open Q3.** Mirror the guard used by `/api/push` / `/api/auto-pipeline/start`. Do not ship the page without it; the routes can overwrite prod source URLs.

**Minor**
- **G15. Hard upload ceiling.** 16 MiB × 10,000 parts ≈ 156 GiB. Bump `UPLOAD_PART_SIZE_MIB` to 32 if we ever need bigger.
- **G16. Sort parts before complete.** Server sorts the `parts` array by `PartNumber` ascending before calling `CompleteMultipartUploadCommand` — S3 requires it.
- **G17. Verify `GET /api/shows/[id]` returns `episodes[].s3_url`.** 30-sec check. If not, add a thin `GET /api/uploads/episodes?slug=...&env=...` that projects exactly `{ episode_number, title, s3_url, s3_url_updated_at }`.

---

## 5c. Does this affect signing? (short answer: no)

Two different "signing" systems exist in this repo. Spelling them out so this is unambiguous:

1. **Media CDN URL signing** (`signed_playback_url*`, `cdn.chaishots.in`, `app/signing/`, `/api/signing/resign`, `KeyName=` keyset rule in memory). These URLs are produced **after** encoding by the downstream pipeline. Our upload page never writes or reads any `signed_playback_url*` field, never calls `/api/signing/*`, and never touches Media CDN keysets.
2. **S3 SigV4 presigning** (what we use for the multipart PUT URLs). Completely separate machinery — short-lived URLs minted per-part by `@aws-sdk/s3-request-presigner`. They authorize the browser PUT to S3 and nothing else.

So no existing signed playback URL is invalidated, re-signed, or rotated by this feature on its own. The signing pipeline only re-runs if an operator afterwards manually presses the existing encode/resign buttons — which is the same as today.

Caveat (intended, not a side effect): if the operator replaces `s3_url` and *then* triggers a re-encode, the resulting `signed_playback_url*` will of course be new (different HLS path → different signed URL). That's the whole point of replacing a source. The previous signed URL keeps working for clients holding it until its own TTL expires; we don't actively invalidate it.

Nothing else in the codebase watches `s3_url` for changes, so writing it does not auto-fire any worker, encoder, signer, or queue. Verified by grep across `dashboard/`, `orchestrator/`, `research-worker/`, `vtt-worker/`, `aws-infra/`.

---

## 6. Failure modes & guardrails

- Browser close mid-upload → orphan multipart in S3. Mitigations:
  - `beforeunload` handler fires `/abort` (best-effort `navigator.sendBeacon`).
  - Add an S3 lifecycle rule: abort incomplete multipart uploads after 7 days (one-time bucket config, document in plan, don't auto-apply).
- Wrong show/episode → overwriting a good `s3_url`. Mitigation: server-side check that current `s3_url` is empty **or** require an explicit `overwrite: true` flag from the client (UI shows a "Replace existing source" checkbox when the row already has a URL).
- Prod/dev mix-up → the env toggle is the only way to write to prod; first prod-write per session shows a confirm. The toggle's current value is shown next to every Upload button.
- Large file timeouts → no API route handles the bytes, so Next/Vercel timeouts don't apply. Only `init`/`sign-part`/`complete` touch the server, each a few-ms op.
- Mongo connection: reuse `clientPromise()` / `getDevClientPromise()` — they're already pooled.

---

## 7. Env / config additions

Add to `deploy.env.example`:
```
# Upload Videos page
UPLOAD_S3_BUCKET=sanity-dev-store         # confirmed against live episodes[].s3_url
UPLOAD_S3_REGION=ap-south-2               # REQUIRED — no fallback (see G13)
UPLOAD_S3_PREFIX=uploads/episodes/        # overall folder; show/episode subfolders appended automatically
UPLOAD_PART_SIZE_MIB=16
```

IAM (on whichever role the dashboard runs as): `s3:CreateMultipartUpload`, `s3:UploadPart`, `s3:CompleteMultipartUpload`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` on `arn:aws:s3:::${UPLOAD_S3_BUCKET}/${UPLOAD_S3_PREFIX}*`.

---

## 8. Open questions before coding

1. **Final URL form to write to `s3_url`** — does the rest of the pipeline expect `s3://bucket/key` or `https://bucket.s3.region.amazonaws.com/key`? Read 1–2 live docs and match.
2. **Bucket region** — confirm the source bucket is `ap-south-2` (probe-source defaults to it; trailerPrep too). If it's something else for episode masters, set `UPLOAD_S3_REGION` accordingly.
3. **Auth** — is there an existing admin guard on these dashboard routes, or are they open inside a VPC? If open, that's fine for now; we'll mirror it.
4. **Episode identification** — `episodes[]` array index vs. an `_id`/`episode_number` lookup. Index is simplest; lookup by `episode_number` is safer if arrays get reordered. Recommend `episode_number` if present, fall back to index.

---

## 9. Build order

1. Confirm the 4 open questions above (1 short Mongo read + 1 bucket inspection).
2. Add env vars + (manually) bucket CORS + lifecycle rule.
3. `lib/multipartUploader.js` (client) + `app/api/uploads/{init,sign-part,complete,abort}/route.js`.
4. `app/upload-videos/page.js` — list + per-episode row + progress.
5. Smoke test on **dev** Mongo with a small file, then a real multi-GB file.
6. Add link to `/upload-videos` in the dashboard header/nav.
7. Flip default env toggle to prod once verified.
