"""
Audio Quality Check worker (ViSQOL).

Scores the **already-encoded** HE-AAC rendition (64k) of ONE episode against its source,
using ViSQOL in **audio mode** (48 kHz, full-band). Measurement-only — nothing is re-encoded.

Inputs are public HTTPS (no GCP creds):
  MASTER_URL : public audio_master.m3u8 (lists the #EXT-X-MEDIA:TYPE=AUDIO variant playlists)
  SOURCE_URL : the source master (podcast audio_url; `.wav` or `.mp3`, auto-detected)

Per rung the worker decodes the source and the rendition to the SAME mono / 48 kHz / mid-window
WAV, then runs ViSQOL once → one MOS-LQO. Both signals come off the same source timeline, so the
matched window + ViSQOL's internal patch alignment absorb the small AAC encoder delay (§5.3 plan).

Writes `chai_q_lab.audio_episodes.visqol` (UI summary) and `chai_q_lab.audio_visqol_research`
(per-rung history). With `--no-db` (or no MONGO_URI) it just prints — that's the standalone
test mode used to validate scores against a real episode before any infra exists.

Env / CLI (CLI flags override env):
  EPISODE_ID, MASTER_URL, SOURCE_URL, MONGO_URI
  VISQOL_SEGMENT  default "mid-180s"   ("full" scores the whole file)
  VISQOL_BIN      default "visqol"     (path to the ViSQOL binary)
  VISQOL_MODEL    optional             (explicit --similarity_to_quality_model path)
"""

import os
import re
import sys
import json
import argparse
import subprocess
import tempfile
from urllib.parse import urljoin

import requests


# ── codec label from the ACTUAL rendition stream (not assumed from kbps) ─────────────────────
# HE-AAC and AAC-LC both report codec_name='aac'; the AAC object type is in ffprobe's `profile`
# (HE-AAC / HE-AACv2 / LC). Detecting it from the real stream avoids mislabeling — e.g. a legacy
# AAC-LC 64k rung that an older pipeline produced would otherwise be wrongly tagged "aac-he".
def _codec_label(codec_name, profile):
    p = (profile or "").upper()
    if codec_name == "aac":
        if "HE-AAC" in p and "V2" in p:
            return "aac-he-v2"
        if "HE-AAC" in p:
            return "aac-he"
        if "LC" in p:
            return "aac-lc"
        return "aac"
    return codec_name or "unknown"


# ── master playlist parsing ────────────────────────────────────────────────────────────────
_URI_RE = re.compile(r'URI="([^"]+)"')
_KBPS_RE = re.compile(r'audio_(\d+)k', re.IGNORECASE)


def parse_master(master_url):
    """Fetch the master playlist and return [(kbps, absolute_variant_url), ...] sorted by kbps.

    Robust to BOTH HLS master shapes GCP Transcoder can emit for an audio-only job:
      - audio as a rendition group:  #EXT-X-MEDIA:TYPE=AUDIO,...,URI="audio_64k.m3u8"
      - audio as plain variants:     #EXT-X-STREAM-INF:...  →  audio_64k.m3u8  (on the next line)
    The rung playlist is found by its filename (`audio_<k>k.m3u8`), taken from either a URI="..."
    attribute (MEDIA or STREAM-INF) or a bare variant line (the URI following a STREAM-INF). The
    audio subtitle patcher (`audio_subtitle_publish.py`) handles both layouts too, so we must as
    well. Subtitle playlists (`subtitle_*.m3u8`) and segment files never match `audio_<k>k.m3u8`,
    so they're ignored regardless of layout. Dedupes by kbps if a rung appears in both forms.
    """
    resp = requests.get(master_url, timeout=30)
    resp.raise_for_status()
    by_kbps = {}
    for raw in resp.text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # A variant URI can be a URI="..." attribute (MEDIA/STREAM-INF) or a bare playlist line.
        candidates = _URI_RE.findall(line)
        if not line.startswith("#"):
            candidates.append(line)
        for uri in candidates:
            m_kbps = _KBPS_RE.search(uri)
            if m_kbps:
                by_kbps[int(m_kbps.group(1))] = urljoin(master_url, uri)
    rungs = sorted(by_kbps.items())
    if not rungs:
        raise RuntimeError(f"No audio_<k>k renditions found in master: {master_url}")
    return rungs


# ── ffprobe / ffmpeg helpers ─────────────────────────────────────────────────────────────────
def ffprobe_info(url):
    """Return {codec, profile, sample_rate, duration} for the first audio stream of `url`.
    `profile` distinguishes HE-AAC vs AAC-LC (both have codec_name='aac') — see _codec_label."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,profile,sample_rate",
         "-show_entries", "format=duration", "-of", "json", url],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    return {
        "codec": stream.get("codec_name"),
        "profile": stream.get("profile"),
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
        "duration": float(fmt["duration"]) if fmt.get("duration") else None,
    }


def compute_window(duration, segment):
    """Return (start, dur) for the scoring window, or None to score the whole file.

    "mid-<N>s" → centered N-second window; "full" → whole file. If the episode is shorter
    than the window, score it in full.
    """
    if not segment or segment == "full":
        return None
    m = re.match(r"mid-(\d+)s?", segment)
    win = int(m.group(1)) if m else 180
    if not duration or duration <= win:
        return None
    return ((duration - win) / 2.0, float(win))


def decode_to_wav(path, out_path, window):
    """Decode local `path` to a mono / 48 kHz / s16 WAV at `out_path`, optionally cropped to
    `window`.

    `-ss`/`-t` go AFTER `-i` (output seeking: decode from the start, discard to the window). This
    is slower than input seeking but reliable — input seeking (`-ss` before `-i`) silently yields
    an empty output on the byterange-fMP4 HLS these renditions use. The same window is applied to
    source and renditions so the signals line up before ViSQOL. Inputs are always LOCAL files
    (see _download / materialize_hls) — the static glibc ffmpeg can't resolve DNS.
    """
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", path]
    if window:
        cmd += ["-ss", f"{window[0]:.3f}", "-t", f"{window[1]:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out_path]
    subprocess.run(cmd, check=True)


def _download(url, dest, timeout=180):
    """Stream `url` to local `dest` via requests (Python resolves DNS fine; static ffmpeg can't)."""
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)
    return dest


def materialize_hls(variant_url, out_dir):
    """Download a variant playlist + every segment/init it references into `out_dir`, and return
    the local playlist path. ffmpeg then reads it entirely from disk — no network, no DNS.

    Segment names in these playlists are flat (e.g. audio_64k0000000000.m4s) and the EXT-X-MAP
    init is referenced via URI="…"; both are resolved relative to the variant URL.
    """
    os.makedirs(out_dir, exist_ok=True)
    resp = requests.get(variant_url, timeout=60)
    resp.raise_for_status()
    text = resp.text
    names = set()
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            m = _URI_RE.search(s)          # e.g. #EXT-X-MAP:URI="…"
            if m:
                names.add(m.group(1))
            continue
        names.add(s)                       # a segment filename
    for name in names:
        _download(urljoin(variant_url, name), os.path.join(out_dir, os.path.basename(name)))
    local_pl = os.path.join(out_dir, "index.m3u8")
    with open(local_pl, "w") as f:
        f.write(text)
    return local_pl


# ── ViSQOL ─────────────────────────────────────────────────────────────────────────────────
_MOS_RE = re.compile(r"MOS-LQO[:=]?\s*([0-9]+\.?[0-9]*)", re.IGNORECASE)


def run_visqol(ref_wav, deg_wav, visqol_bin, model_path):
    """Run ViSQOL in audio mode (NO --use_speech_mode) and return the MOS-LQO float.

    Audio mode is mandatory here: speech mode is 16 kHz narrowband and would ignore exactly the
    high-frequency detail AAC trades away — useless for grading the codec.
    """
    cmd = [visqol_bin, "--reference_file", ref_wav, "--degraded_file", deg_wav, "--verbose"]
    if model_path:
        cmd += ["--similarity_to_quality_model", model_path]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    m = _MOS_RE.search(out.stdout) or _MOS_RE.search(out.stderr)
    if not m:
        raise RuntimeError(f"Could not parse MOS-LQO from ViSQOL output:\n{out.stdout}\n{out.stderr}")
    return round(float(m.group(1)), 3)


# ── Mongo ──────────────────────────────────────────────────────────────────────────────────
def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _fetch_secret(arn):
    """Fetch a Secrets Manager secret string by ARN using the container's IAM (the Batch jobRole).
    Region is parsed from the ARN. boto3 is imported lazily so local --no-db runs don't need it."""
    import boto3
    parts = arn.split(":")
    region = parts[3] if arn.startswith("arn:") and len(parts) > 3 and parts[3] else os.getenv("AWS_REGION", "us-east-1")
    return boto3.client("secretsmanager", region_name=region).get_secret_value(SecretId=arn)["SecretString"]


def _resolve_mongo_uri(args):
    """Resolve the Mongo URI (None under --no-db). Order: --mongo-uri flag → MONGO_URI env →
    MONGO_SECRET_ARN (a Secrets Manager ARN fetched at runtime via the jobRole). The ARN path
    keeps the credential out of the Batch job definition's plaintext environment."""
    if args.no_db:
        return None
    direct = args.mongo_uri or os.getenv("MONGO_URI")
    if direct:
        return direct
    arn = os.getenv("MONGO_SECRET_ARN")
    return _fetch_secret(arn) if arn else None


def write_results(mongo_uri, episode_id, summary, per_rung):
    import pymongo
    db = pymongo.MongoClient(mongo_uri)["chai_q_lab"]
    db.audio_episodes.update_one(
        {"episode_id": episode_id}, {"$set": {"visqol": summary}}, upsert=True
    )
    if per_rung:
        db.audio_visqol_research.insert_many(per_rung)


def stamp_failed(mongo_uri, episode_id, message):
    """Best-effort: record FAILED so the dashboard doesn't hang on CALCULATING. Swallows its own
    errors so the real failure still surfaces to the caller / Batch."""
    try:
        import pymongo
        pymongo.MongoClient(mongo_uri)["chai_q_lab"].audio_episodes.update_one(
            {"episode_id": episode_id},
            {"$set": {"visqol.status": "FAILED", "visqol.error": message,
                      "visqol.computed_at": _now_iso()}},
            upsert=True,
        )
    except Exception as e:
        print(f"[WARN] stamp_failed itself errored: {e}", file=sys.stderr)


# ── main ─────────────────────────────────────────────────────────────────────────────────────
def run(args):
    episode_id = args.episode_id or os.getenv("EPISODE_ID")
    master_url = args.master_url or os.getenv("MASTER_URL")
    source_url = args.source_url or os.getenv("SOURCE_URL")
    mongo_uri = _resolve_mongo_uri(args)
    segment = args.segment or os.getenv("VISQOL_SEGMENT", "mid-180s")
    visqol_bin = os.getenv("VISQOL_BIN", "visqol")
    model_path = os.getenv("VISQOL_MODEL")

    missing = [k for k, v in {"MASTER_URL": master_url, "SOURCE_URL": source_url}.items() if not v]
    if missing:
        raise EnvironmentError(f"Missing required input(s): {', '.join(missing)}")

    # podcast_showcache stores some audio_url values WITHOUT a scheme (e.g.
    # "d27vk6lpclibck.cloudfront.net/..."), and the API route passes audio_url through verbatim.
    # requests needs a scheme — default to https, mirroring gcp_copy_audio_to_gcs.py so the
    # worker accepts the exact same source values the copy step already handles.
    if source_url and not source_url.startswith(("http://", "https://")):
        source_url = "https://" + source_url
    if master_url and not master_url.startswith(("http://", "https://")):
        master_url = "https://" + master_url

    # Active ladder filter: score only rungs we actually ship (64). Older masters may still
    # list stale 96/128 rungs — parse them but ignore, so the score reflects the current ladder.
    ladder_env = args.ladder or os.getenv("VISQOL_LADDER") or os.getenv("AUDIO_LADDER_KBPS", "64")
    allowed = {int(x) for x in ladder_env.split(",") if x.strip()}
    rungs_all = parse_master(master_url)
    rungs = [(k, u) for k, u in rungs_all if k in allowed]
    ignored = [k for k, _ in rungs_all if k not in allowed]
    if ignored:
        print(f"[INFO] ignoring rungs not in ladder {sorted(allowed)}: {ignored}")
    if not rungs:
        raise RuntimeError(f"No rungs in master {[k for k, _ in rungs_all]} match ladder {sorted(allowed)}")
    print(f"[INFO] scoring rungs: {[k for k, _ in rungs]}")

    workdir = tempfile.mkdtemp(prefix=f"visqol_{(episode_id or 'ep')}_")

    # Pull the source locally first (ffmpeg can't resolve DNS — see decode_to_wav).
    src_ext = os.path.splitext(source_url.split("?")[0])[1] or ".bin"
    src_local = os.path.join(workdir, f"source{src_ext}")
    _download(source_url, src_local)

    src = ffprobe_info(src_local)
    source_codec, source_sr = src["codec"], src["sample_rate"]
    window = compute_window(src["duration"], segment)
    seg_label = "full" if window is None else segment
    print(f"[INFO] source codec={source_codec} sr={source_sr} dur={src['duration']} → window={seg_label}")
    if source_codec == "mp3":
        print("[WARN] source is MP3 (lossy reference): absolute MOS is bounded by the MP3; "
              "treat scores as relative across rungs.")

    ref_wav = os.path.join(workdir, "ref.wav")
    decode_to_wav(src_local, ref_wav, window)

    scores, per_rung = {}, []
    for kbps, variant_url in rungs:
        local_pl = materialize_hls(variant_url, os.path.join(workdir, f"hls_{kbps}k"))
        rinfo = ffprobe_info(local_pl)
        codec = _codec_label(rinfo.get("codec"), rinfo.get("profile"))
        deg_wav = os.path.join(workdir, f"deg_{kbps}k.wav")
        decode_to_wav(local_pl, deg_wav, window)
        mos = run_visqol(ref_wav, deg_wav, visqol_bin, model_path)
        scores[str(kbps)] = mos
        per_rung.append({
            "episode_id": episode_id, "rung_kbps": kbps, "codec": codec,
            "visqol_mos": mos, "mode": "audio", "segment": seg_label,
            "source_codec": source_codec, "source_sr": source_sr, "timestamp": _now_iso(),
        })
        print(f"[OK] {kbps}k ({codec}) MOS-LQO={mos}")

    summary = {
        "status": "DONE", "mode": "audio", "segment": seg_label, "scores": scores,
        "source_codec": source_codec, "source_sr": source_sr, "computed_at": _now_iso(),
        "error": None,
    }

    # delta read-out (decision support)
    ordered = sorted(int(k) for k in scores)
    deltas = " | ".join(
        f"{k}k {scores[str(k)]}" + (f" (+{round(scores[str(k)] - scores[str(ordered[i-1])], 3)} vs {ordered[i-1]}k)" if i else "")
        for i, k in enumerate(ordered)
    )
    print(f"[RESULT] episode={episode_id} {deltas}")

    if mongo_uri:
        write_results(mongo_uri, episode_id, summary, per_rung)
        print(f"[OK] wrote visqol summary + {len(per_rung)} research docs")
    else:
        print("[INFO] --no-db / no MONGO_URI → results not persisted")
        print(json.dumps(summary, indent=2))


def main():
    ap = argparse.ArgumentParser(description="ViSQOL audio quality check for one episode")
    ap.add_argument("--episode-id")
    ap.add_argument("--master-url")
    ap.add_argument("--source-url")
    ap.add_argument("--mongo-uri")
    ap.add_argument("--segment", help='"mid-180s" (default) or "full"')
    ap.add_argument("--ladder", help='rungs to score, e.g. "64,96" (ignores others like a stale 128)')
    ap.add_argument("--no-db", action="store_true", help="print scores instead of writing Mongo")
    args = ap.parse_args()

    try:
        run(args)
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        mongo_uri = _resolve_mongo_uri(args)
        episode_id = args.episode_id or os.getenv("EPISODE_ID")
        if mongo_uri and episode_id:
            stamp_failed(mongo_uri, episode_id, str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
