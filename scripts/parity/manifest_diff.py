#!/usr/bin/env python3
"""Compare the HLS output of a prod run and a shadow run (gate E: transcode). Read-only.

Normalises the per-run timestamp (ddmmyyyy_HHMMSS) and host, then compares the
file set and each playlist's structure: STREAM-INF (BANDWIDTH/RESOLUTION/CODECS),
EXT-X-MEDIA, EXTINF count+durations, EXT-X-MAP byteranges. Segment bytes are not
expected to be identical (encoder nondeterminism), so .m4s files compare by name only.

Usage: python manifest_diff.py gs://chai-shots-manifests/<ep>/<ts>/ gs://chai-q-az-shadow-manifests/<ep>/<ts>/
"""
import re
import sys

TS = re.compile(r"\d{8}_\d{6}")
# Base URL: prod cdn.chaishots.in vs shadow storage.googleapis.com/<shadow bucket>
HOST = re.compile(r"https?://[^/\s\"]+(?:/chai-q-az-shadow-manifests|/chai-shots-manifests)?")
KEEP = re.compile(r"^#EXT-X-(STREAM-INF|MEDIA|MAP|TARGETDURATION|VERSION|PLAYLIST-TYPE|ENDLIST)|^#EXTINF")


def normalise_name(name: str) -> str:
    return TS.sub("<TS>", name.rsplit("/", 1)[-1])


def playlist_shape(text: str) -> list:
    lines = []
    for line in text.splitlines():
        line = HOST.sub("<HOST>", TS.sub("<TS>", line.strip()))
        if KEEP.match(line) or (line and not line.startswith("#")):
            lines.append(line)
    return lines


def compare(prod: dict, shadow: dict) -> list:
    """prod/shadow: {normalised_name: text_or_None}. Returns human-readable differences."""
    diffs = []
    for name in sorted(set(prod) ^ set(shadow)):
        diffs.append(f"only in {'prod' if name in prod else 'shadow'}: {name}")
    for name in sorted(set(prod) & set(shadow)):
        if name.endswith(".m3u8"):
            a, b = playlist_shape(prod[name]), playlist_shape(shadow[name])
            if a != b:
                first = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
                diffs.append(f"{name}: differs at line {first}: prod={a[first:first+1]} shadow={b[first:first+1]}")
    return diffs


def load(prefix: str) -> dict:
    from google.cloud import storage
    bucket, _, path = prefix[len("gs://"):].partition("/")
    out = {}
    for blob in storage.Client().list_blobs(bucket, prefix=path):
        name = normalise_name(blob.name)
        out[name] = blob.download_as_text() if blob.name.endswith((".m3u8", ".vtt")) else None
    return out


if __name__ == "__main__":
    d = compare(load(sys.argv[1]), load(sys.argv[2]))
    print("\n".join(d) or "IDENTICAL (modulo timestamp/host)")
    sys.exit(1 if d else 0)
