# Signed Playback URLs — Before vs Now

*Why the first signing attempt (April 2026) broke and was disabled, and what the current approach (July 2026) does differently.*

---

## The goal (unchanged both times)

Put a rotating signed token on playback URLs so content can't be freely hotlinked/shared, **without hurting CDN caching**. Token rotates every 2h, valid 10h. Media CDN service `chai-shorts-media-cdn`, keyset `chaishots-playback-keyset`.

---

## What we did the FIRST time — and why it broke

### The core mistake: enforcing on the catch-all route

The old config set `signedRequestMode: REQUIRE_SIGNATURES` on the **`/` catch-all** route. That route matches **everything** — the master manifest, every child playlist, AND every segment.

That single decision caused everything else to go wrong:

### Consequence 1 — it forced baking tokens into the manifests

Native players (iOS AVPlayer, Android ExoPlayer) **do not** carry a URL's query-string token down to the child/segment URLs they parse out of a manifest (RFC 3986 relative resolution drops the query string). So under catch-all enforcement, the player would request `child.m3u8` and `seg.ts` **without** a token → **403**.

To work around that, the old signer (`git f133376`) **rewrote every child manifest and every segment reference in GCS**, baking a signature into each line. Now every segment URL carried its own token.

### Consequence 2 — broken caching (`no-store`)

Because the tokens were baked *into* the manifest file contents (and rotated), those manifests were written with `Cache-Control: no-store` to avoid serving a cached manifest full of expired tokens. Result: **the CDN could not cache manifests** → every request fell through to GCS origin → **~2000ms TTFB** for distant regions. This is the caching regression that motivated the whole later cleanup.

### Consequence 3 — the 900s resign treadmill

Every 2h token refresh meant **rewriting every child manifest + segment reference on GCS** (≈549 episodes × ~12 files each). That work is I/O-bound, and as the catalog grew it pushed the resign Lambda toward — and past — its **900s timeout ceiling**. Sharding/near-expiry filters were floated but never fixed it.

### Net result

Signing technically "worked" (URLs were signed and enforced), but it **broke caching and hit the 900s ceiling**. On **2026-06-10** the whole thing was disabled: edge set back to `DISABLED`, Mongo backfilled with unsigned URLs, and a batch job stripped the baked params out of ~3,000 GCS `.m3u8` files.

> **The transition itself (sign-first, then enforce) was fine and is reused today. What broke was the *enforcement style* — enforcing on everything forced baking, and baking broke caching + scale.**

---

## What we do NOW

### The core fix: enforce on the combined master ONLY

`REQUIRE_SIGNATURES` is applied to **`*_combined.m3u8` (the master file) only**. Child playlists and segments stay on **open (`DISABLED`) routes**.

Because only the master needs a token, the "players don't propagate tokens to children" problem **disappears** — children/segments never need a token, so they never 403. **No baking required.**

### Signing is Mongo-only — no GCS rewrites

The cron signs **only the master URL** and writes it to `master.showcache` (`episodes[].signed_playback_url` / `trailers_playback_urls[].gcpUrl`). It **never touches GCS manifests**. That removes the entire I/O treadmill.

### Caching is preserved (30 days)

- Manifests and segments keep `Cache-Control: public, max-age=2592000`. **Never `no-store`.**
- `cacheKeyPolicy.excludeQueryString: true` strips the rotating token from the cache key, so the signed master **caches by its bare path** and is shared across all users — same TTFB as an unsigned URL (verified live: `x-cache-status: hit`).
- (Media CDN marks the signed master response `private` to clients, but the **edge still caches it 30d**; segments stay `public`. Caching where it matters is intact.)

### Token format corrected

Full-path signing per Google's exact recipe: `?Expires=…&KeyName=…&Signature=…` (Ed25519, unpadded base64url, no `URLPrefix`). Verified end-to-end on the live edge (canary G1–G4).

### bulkWrite

The full sweep batches Mongo writes (`bulk_write`, 1000/batch) → **~625s → ~11s** for 3,060 URLs. The 900s ceiling is a non-issue (≈78× headroom; still seconds at 40k).

---

## Side-by-side

| Aspect | Before (April 2026, disabled) | Now (July 2026) |
|---|---|---|
| Enforcement scope | `/` catch-all — master + children + segments | `*_combined.m3u8` **master only** |
| Token placement | **baked into** every manifest + segment in GCS | on the **master request URL** only (in Mongo) |
| GCS manifest rewrites | every file, every 2h | **none** |
| Caching | **broken** (`no-store`, ~2000ms TTFB) | **preserved** (30d, edge-cached, same TTFB) |
| Resign cost | I/O-bound, hit **900s** timeout | Mongo-only, **~11s** (bulkWrite) |
| Token format | URLPrefix (+ baked) | full-path, spec-correct |
| Outcome | **disabled 2026-06-10** | **works** |

---

## Learnings baked in (do NOT repeat)

1. **`no-store` — not signing — was the caching killer.** Signing never adds `no-store`; keep `public, max-age`.
2. **Never bake tokens into manifests.** That is the root of both the caching break and the 900s treadmill. Sign the master URL only, in Mongo.
3. **Enforce on the master pattern only.** Enforcing on all `.m3u8`/segments 403s native players and forces baking — the original mistake.
4. **Keep `excludeQueryString: true`** so a rotating token never fragments or disables the cache.
5. **`bulk_write`** keeps the sweep in seconds regardless of catalog size.
