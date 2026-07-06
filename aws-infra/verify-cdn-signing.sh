#!/usr/bin/env bash
#
# verify-cdn-signing.sh
#
# Proves whether it is safe to strip signing params
# (?URLPrefix=...&Expires=...&KeyName=...&Signature=...) from playback content.
#
# The params live in THREE places, not one:
#   1. master.showcache.episodes[].signed_playback_url   (Mongo — the master URL)
#   2. child playlist URIs inside the combined master .m3u8   (baked into GCS objects)
#   3. segment (.m4s) + EXT-X-MAP URIs inside each child .m3u8 (baked into GCS objects)
#
# The DB resigner only cleans (1). (2) and (3) stay until the .m3u8 files
# themselves are rewritten. None of it matters for playback IF the edge is
# signedRequestMode: DISABLED — which is exactly what this script verifies,
# end to end, by actually walking master -> children -> segments.
#
# Usage:
#   ./verify-cdn-signing.sh                          # CDN config check only
#   ./verify-cdn-signing.sh "<combined master URL>"  # config + full chain walk
#
# The master URL may keep its ?...&Signature=... tail; the script strips as needed.

set -uo pipefail

SERVICE="chai-shorts-media-cdn"
PROJECT="media-cdn-poc-466009"

bold()   { printf '\033[1m%s\033[0m\n' "$1"; }
green()  { printf '\033[32m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

strip_params() { printf '%s' "${1%%\?*}"; }                 # drop everything from first '?'
base_dir()     { local u; u="$(strip_params "$1")"; printf '%s' "${u%/*}"; }  # dir of a URL

# Resolve a (possibly relative) manifest URI against the playlist it came from.
resolve() {
  local parent="$1" uri="$2"
  case "$uri" in
    http://*|https://*) printf '%s' "$uri" ;;
    /*)                 local host="${parent#*://}"; host="${host%%/*}"
                        printf '%s://%s%s' "${parent%%://*}" "$host" "$uri" ;;
    *)                  printf '%s/%s' "$(base_dir "$parent")" "$uri" ;;
  esac
}

# HTTP status. Second arg "range" => byte-range GET (for large segments; expect 206).
httpcode() {
  local url="$1" mode="${2:-full}"
  if [ "$mode" = "range" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 25 -r 0-99 "$url" 2>/dev/null || echo "000"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$url" 2>/dev/null || echo "000"
  fi
}

ok_code() { case "$1" in 200|206) return 0 ;; *) return 1 ;; esac; }

# Pull every content URI out of an m3u8 body (stdin): bare URI lines + URI="..." attrs.
extract_uris() {
  awk '
    /^#/ {
      # EXT-X-MEDIA / EXT-X-MAP carry the target in URI="..."
      if (match($0, /URI="[^"]+"/)) {
        s = substr($0, RSTART+5, RLENGTH-6); print s
      }
      next
    }
    NF { print $0 }   # non-comment, non-empty = a playlist/segment URI
  '
}

PASS=0; FAIL=0
note_pass() { PASS=$((PASS+1)); }
note_fail() { FAIL=$((FAIL+1)); }

# ---------------------------------------------------------------------------
# 1. CONFIG CHECK
# ---------------------------------------------------------------------------
bold "== 1. Live CDN edge config =="
echo "service: $SERVICE   project: $PROJECT"
echo
DESC="$(gcloud edge-cache services describe "$SERVICE" \
  --project="$PROJECT" \
  --format="yaml(edgeSslCertificates,routing.pathMatchers[].routeRules[].routeAction.cdnPolicy.signedRequestMode)" 2>/dev/null)"

if [ -z "$DESC" ]; then
  red "Could not read CDN config (gcloud auth / project / service name?)."
  red "Cannot confirm the edge is DISABLED — refusing to certify safe. Authenticate gcloud and re-run."
  note_fail   # fail-closed: no confirmed edge config == not a pass (symmetric with the actor's --apply guard)
else
  echo "$DESC"; echo
  MODES="$(printf '%s\n' "$DESC" | grep -oE 'signedRequestMode:[[:space:]]*[A-Z_]+' | awk '{print $2}')"
  TOTAL="$(printf '%s\n' "$MODES" | grep -c . || true)"
  NON_DISABLED="$(printf '%s\n' "$MODES" | grep -vc '^DISABLED$' || true)"
  printf '%s\n' "$DESC" | grep -q 'edgeSslCertificates:' && SSL_OK=1 || SSL_OK=0

  echo "routes reporting signedRequestMode : $TOTAL"
  echo "routes NOT disabled                : $NON_DISABLED"
  if [ "$SSL_OK" -eq 1 ]; then
    green "edgeSslCertificates                : present"
  else
    red   "edgeSslCertificates                : MISSING (!) — refusing to certify safe"
    note_fail   # fail-closed on missing TLS cert (the 2026-06-10 outage was a dropped edgeSslCertificates)
  fi
  echo
  if [ "$TOTAL" -gt 0 ] && [ "$NON_DISABLED" -eq 0 ]; then
    green "All routes DISABLED — the edge does not enforce signatures."; note_pass
  else
    red   "Some routes still enforce signatures — stripping params would 403 them."; note_fail
  fi
fi

MASTER="${1:-}"
if [ -z "$MASTER" ]; then
  echo; yellow "No master URL passed — config check only."
  yellow "For the full chain walk: ./verify-cdn-signing.sh \"<combined master .m3u8 URL>\""
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. CHAIN WALK: master -> children -> segments, each tested STRIPPED
# ---------------------------------------------------------------------------
echo
bold "== 2. Manifest chain walk (params stripped at every level) =="

# -- expiry sanity: decode any Expires= we can find --
EXP="$(printf '%s' "$MASTER" | grep -oE 'Expires=[0-9]+' | head -1 | cut -d= -f2)"
if [ -n "${EXP:-}" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$EXP" <<'PY'
import sys; from datetime import datetime, timezone
exp=int(sys.argv[1]); now=datetime.now(timezone.utc).timestamp()
print("master URL Expires :", datetime.fromtimestamp(exp,timezone.utc).isoformat(),
      "->", ("EXPIRED" if exp<now else "valid"), f"({(exp-now)/86400:.1f} days)")
PY
fi
echo

# -- Level 0: master --
MASTER_CLEAN="$(strip_params "$MASTER")"
C="$(httpcode "$MASTER_CLEAN")"
if ok_code "$C"; then green "[master ]  $C  (stripped)  $MASTER_CLEAN"; note_pass
else                  red   "[master ]  $C  (stripped)  $MASTER_CLEAN"; note_fail; fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cdnverify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

curl -s --max-time 25 "$MASTER" > "$TMP/master.m3u8"
if [ ! -s "$TMP/master.m3u8" ]; then red "Could not download master body; aborting walk."; exit 1; fi

# -- Level 1: child playlists (.m3u8) referenced by master --
extract_uris < "$TMP/master.m3u8" | grep -E '\.m3u8' > "$TMP/children.txt" || true
NCHILD="$(grep -c . "$TMP/children.txt" || true)"
echo; bold "-- ${NCHILD} child playlist(s) --"

: > "$TMP/child_abs.txt"
while IFS= read -r uri; do
  [ -n "$uri" ] || continue
  abs="$(resolve "$MASTER" "$uri")"
  clean="$(strip_params "$abs")"
  printf '%s\n' "$abs" >> "$TMP/child_abs.txt"   # keep EVERY child for per-child segment sampling
  c="$(httpcode "$clean")"
  short="${clean##*/}"
  if ok_code "$c"; then green "  [child ]  $c  ${short}"; note_pass
  else                  red   "  [child ]  $c  ${short}"; note_fail; fi
done < "$TMP/children.txt"

# -- Level 2: sample ONE segment from EVERY child (not just the first), so the
#    gate covers exactly what strip_manifest_params.py --apply will rewrite.
#    .vtt included so subtitle playlists get exercised too.
echo; bold "-- segment sample from each child (with vs stripped) --"
while IFS= read -r child_abs; do
  [ -n "$child_abs" ] || continue
  curl -s --max-time 25 "$child_abs" > "$TMP/child.m3u8"
  seg_uri="$(extract_uris < "$TMP/child.m3u8" | grep -E '\.m4s|\.ts|\.mp4|\.vtt' | head -1)"
  child_short="$(strip_params "$child_abs")"; child_short="${child_short##*/}"
  if [ -z "$seg_uri" ]; then
    yellow "  [segment] (none found)         in ${child_short}"; continue
  fi
  abs="$(resolve "$child_abs" "$seg_uri")"
  clean="$(strip_params "$abs")"
  withp="$(httpcode "$abs" range)"
  cleanp="$(httpcode "$clean" range)"
  short="${clean##*/}"
  if ok_code "$cleanp"; then
    green "  [segment] with=$withp stripped=$cleanp  ${short}  (via ${child_short})"; note_pass
  else
    red   "  [segment] with=$withp stripped=$cleanp  ${short}  (via ${child_short})"; note_fail
  fi
done < "$TMP/child_abs.txt"

# ---------------------------------------------------------------------------
# VERDICT
# ---------------------------------------------------------------------------
echo
bold "== Verdict =="
echo "checks passed: $PASS    failed: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  green "Every level returns 200/206 with params stripped — removing the params will NOT affect the videos."
else
  red   "$FAIL check(s) failed — do NOT strip params until resolved (see red lines above)."
  exit 1
fi
