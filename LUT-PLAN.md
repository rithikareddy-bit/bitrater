# LUT Layer Integration Plan — bitrater pipeline

**Status:** Draft
**Scope:** Apply a single color LUT (Look-Up Table) stage in front of every encode — both the H.264 (libx264) and H.265 (libx265) paths — and keep VMAF scoring honest.

---

## 1. Current state (what we have today)

We transcode on two surfaces. Both must change in lockstep, or the production encode will look different from the research encode we tune against.

| Surface | File | Codec path | How it runs |
|---|---|---|---|
| Research / VMAF tuning | `research-worker/worker.py:43-83` | libx264, libx265 | Local FFmpeg, two-pass |
| Production | `orchestrator/gcp_transcoder.py:35-79` | h264, h265 | GCP Transcoder API |

Key observations:

- **Research worker filter chain** today is just `scale={w}:{h}:flags=lanczos` — `worker.py:46`. No color stage.
- **Pixel format is 8-bit** `yuv420p` in both configs — `configs/h264_heavy.json:4`, `configs/h265_heavy.json:4`. This is a problem for LUT quality (see §5).
- **VMAF reference** is the raw `source.mp4`, compared against the encoded `variant.mp4` — `worker.py:140-152`. If we LUT only the encode, VMAF tanks (20–40 pt drop) because VMAF is pixel-based and will read the color shift as distortion.
- **GCP Transcoder API cannot run custom FFmpeg filters.** There is no `lut3d` option in `types.VideoStream.H264CodecSettings` / `H265CodecSettings`. This is the hard constraint that shapes the whole plan.

---

## 2. Why do this at all

Pick the real reason — the plan changes based on which one:

1. **Creative grade** — you want a consistent look across encodes (teal-orange, filmic, skin-tone warmth). LUT is the right tool.
2. **Color-space normalization** — sources arrive in mixed color spaces (Rec.709, Rec.2020, log footage) and you want everything in a clean Rec.709 SDR before encode. LUT is *one* option but `zscale` + BT.2390 tone-map is usually better for this. If this is the goal, **revisit before implementing — a LUT is not the best fit.**
3. **HDR→SDR tone map** — not a LUT job. Use `zscale,tonemap`.
4. **Brand consistency / test fixture** — fine, LUT works.

**Assumption for the rest of this doc:** goal is #1 (creative look, applied uniformly). If it's #2 or #3, stop and re-scope.

---

## 3. The architectural choice

There are three ways to slot a LUT in. Only one survives the GCP Transcoder constraint.

### Option A — apply LUT inside each encode's filter chain (rejected)
`[0:v]lut3d=file=grade.cube,scale=...[enc]`
- Works in research-worker.
- **Fails in GCP Transcoder** — no filter support.
- Rejected: breaks parity between research and prod.

### Option B — pre-grade the source once, feed the graded source to everything (**recommended**)
1. New stage: `grade.cube` is applied to `source.mp4` → `graded.mp4`.
2. `graded.mp4` is the input to *both* the H.264 and H.265 encodes.
3. `graded.mp4` is also the VMAF reference (keeps symmetry — §6).
4. For prod, `graded.mp4` is uploaded to GCS and set as `gcs_input_uri` in `gcp_transcoder.py`.

Pros: works on both surfaces, keeps GCP Transcoder untouched, VMAF stays valid, one LUT applied once (no drift between codecs).
Cons: extra storage (one more intermediate per episode), extra ~1× realtime compute.

### Option C — switch GCP side from Transcoder API to raw FFmpeg on Cloud Run/Batch (rejected for now)
Gives full filter control but throws away the GCP Transcoder investment (step functions, job tracking, manifests). Not worth it just for a LUT.

**Decision: Option B.**

---

## 4. Where the LUT file lives and how it's chosen

- Store `.cube` files in `configs/luts/` (e.g. `configs/luts/default_v1.cube`).
- Reference by name from codec configs — extend `h264_heavy.json` / `h265_heavy.json`:
  ```json
  { "lut": "default_v1", ... }
  ```
  But **both configs must reference the same LUT** (that's the whole point). So actually: put it in a new `configs/grade.json` with a single `{"lut": "default_v1"}`, and load it once in the orchestrator. Codec configs should not diverge on grading.
- Version LUTs by filename. Never mutate a `.cube` in place — a re-graded LUT silently invalidates every historical VMAF number.
- Record `lut_name` in the MongoDB VMAF result doc (`worker.py:170-180`) so past runs stay interpretable.

---

## 5. Pixel format / bit-depth — the subtle gotcha

Applying a 3D LUT to 8-bit `yuv420p` and writing back to 8-bit introduces **banding in gradients** (skies, skin, fades to black). That banding then confuses the encoder's psychovisual model and costs VMAF points.

**Required change:** pre-grade in a 10-bit intermediate, regardless of final encode bit depth.

```
ffmpeg -i source.mp4 \
  -vf "format=yuv420p10le,lut3d=file=grade.cube:interp=tetrahedral" \
  -c:v libx264 -crf 12 -pix_fmt yuv420p10le \
  graded.mp4
```

Notes:
- `interp=tetrahedral` — smoother than default trilinear, ~zero cost.
- Intermediate is visually lossless (CRF 12 or ProRes if you want to be safer).
- Final encode stage can still output 8-bit `yuv420p` — GCP Transcoder expects 8-bit anyway. The 10-bit intermediate just protects the LUT math.
- If storage matters more than quality, CRF 16 is acceptable.

---

## 6. Keeping VMAF honest

This is the part people get wrong. Current code compares `source.mp4` (ungraded) vs `variant.mp4`. If we ungrade-compare a graded variant, VMAF crashes.

**Rule: after introducing the LUT, `graded.mp4` becomes the VMAF reference, not `source.mp4`.**

Change at `worker.py:140-152`:
- Replace `-i source.mp4` with `-i graded.mp4` on the VMAF ffmpeg invocation.
- The `[0:v]` ref in the filter_complex is now graded, matching what the encoder saw.

Expected impact on VMAF numbers vs pre-LUT baseline: **±1–3 points** from content difficulty shift (LUTs that boost contrast make encoding harder, flatter LUTs make it easier). This is real and shouldn't be papered over — log a baseline-vs-graded comparison on one episode before rollout.

**Do not** mix graded and ungraded references across episodes in the same experiment — it poisons the dataset.

---

## 7. Changes by file

### 7a. `research-worker/worker.py`

1. Add pre-grade stage after `s3.download_file(...)` at `worker.py:118`:
   ```python
   _apply_lut("source.mp4", "graded.mp4", lut_path)
   ```
2. Change the encode input in `_two_pass_encode` from `source.mp4` to `graded.mp4` — `worker.py:51, 66`.
3. Change VMAF inputs to use `graded.mp4` as reference — `worker.py:148`.
4. Scale filter stays the same; the scale on the VMAF dist side must also scale from the encode's output back to `graded.mp4`'s dimensions (already does — `worker.py:142`).
5. Persist `lut_name` and `lut_version` in the Mongo doc — `worker.py:170-180`.

### 7b. `orchestrator/gcp_transcoder.py`

1. Add a pre-step (new Lambda or a stage before `handler`) that:
   - Downloads source from S3/GCS,
   - Applies LUT to a 10-bit intermediate,
   - Uploads `graded.mp4` to GCS,
   - Returns the new `gcs_input_uri`.
2. `handler` at `gcp_transcoder.py:202` accepts the graded URI as `gcs_input_uri` instead of the raw source.
3. No change to `_build_h264_video_stream` / `_build_h265_video_stream` — they don't need to know.
4. Record `lut_name` on the `video_episodes` doc — `gcp_transcoder.py:233-239`.

### 7c. Step function `orchestrator/gcp_step_function_def.json`

Add a `ApplyLUT` state before the two transcoder invocations so H.264 and H.265 share the same graded input. (Important: same graded file, not two re-grades — identical pixels into both codecs.)

### 7d. `configs/grade.json` (new)

```json
{ "lut": "default_v1", "interp": "tetrahedral", "intermediate_crf": 12 }
```

### 7e. `configs/luts/default_v1.cube` (new)

Drop the actual `.cube` file in. Don't commit huge (>10MB) LUTs — most 33³ LUTs are under 1MB.

---

## 8. Validation checklist before rolling out

Run on **one episode, both codecs, at one bitrate** before touching production:

1. [ ] Pre-LUT baseline: record VMAF for `(episode, codec, bitrate)` against ungraded reference.
2. [ ] Post-LUT: record VMAF for same `(episode, codec, bitrate)` against graded reference.
3. [ ] Sanity: VMAF delta should be within ±3 points. If it's −10 or worse, something is broken (likely reference mismatch or 8-bit LUT banding).
4. [ ] Visual spot-check: open `graded.mp4` and the final encode side-by-side. Confirm the look matches intent.
5. [ ] Re-run twice on the same source to confirm determinism — same VMAF both runs.
6. [ ] Check file size delta on the 10-bit intermediate — if it explodes, drop to CRF 16.

Only after all six pass: roll to the step function for real episodes.

---

## 9. Risks and how we mitigate

| Risk | Mitigation |
|---|---|
| VMAF scores drop after rollout and look like a regression | Log `lut_name` on every run; compare only graded-vs-graded or pre-vs-pre, never cross. Keep a dashboard filter for `lut_name`. |
| LUT swapped silently; historical numbers now meaningless | Version LUTs by filename; never mutate in place; record version in Mongo. |
| 8-bit banding sneaks in | Enforce 10-bit intermediate in `_apply_lut`; fail loudly if `-pix_fmt` isn't `yuv420p10le` at that stage. |
| Storage bill climbs from keeping graded intermediates | Delete `graded.mp4` from GCS after both codec jobs complete. It's reproducible. |
| Research and prod drift (different LUTs applied) | Single `configs/grade.json`, loaded by both `worker.py` and the GCP pre-grade step. No per-codec LUT choice. |
| Someone adds a third codec later and forgets the LUT | Centralize pre-grade as a separate step in the pipeline, not inside the encode function. Codec additions inherit LUT for free. |

---

## 10. What we are explicitly NOT doing

- Not putting LUT logic inside `_build_h264_video_stream` / `_build_h265_video_stream`. GCP API can't do it.
- Not applying different LUTs per codec. That defeats the purpose.
- Not LUT-ing the VTT / sprite / thumbnail pipeline in `vtt-worker/`. Those are previews; a mismatched look there is a separate, cheaper decision.
- Not touching the quality-check stage in `orchestrator/quality_checker.py` — blockdetect/blurdetect are LUT-agnostic.
- Not moving to OCIO/ACES. That's a bigger program; revisit if #2 or #3 from §2 becomes the real goal.

---

## 11. Open questions for you

1. Which LUT file do you want to start with? Do you have a `.cube` already, or do we need to commission one?
2. Is this applied to every episode, or only a subset (per-show configurable)? If per-show, the LUT name needs to live on the `video_shows` doc, not a global config.
3. Rollout: new episodes only, or backfill? Backfill means re-encoding and re-scoring everything currently in `video_vmaf_research`.
