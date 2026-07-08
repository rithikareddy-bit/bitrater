#!/usr/bin/env bash
#
# verify-combined-signing.sh
#
# Gates the combined-master signing rollout (see cdn-backups/RUNBOOK-enable-combined-signing.md).
# Given a SIGNED combined master URL (from master.showcache.signed_playback_url or
# trailers_playback_urls[].gcpUrl), it proves the enforcement is correct AND that
# children/segments stay open — the exact failure mode of the original bug.
#
# Checks:
#   G1  signed master            -> 200 + Cache-Control public,max-age=2592000 (not no-store) + cache hit on repeat
#   G2  master, token stripped   -> 403 (enforcement works)
#   G3  master, Signature altered-> 403 (unforgeable)
#   G4  every child .m3u8 + one .m4s/.ts per child, NO token -> 200/206 (edge does NOT enforce children)
#
# Usage:  ./verify-combined-signing.sh "<signed combined master .m3u8 URL>"

set -uo pipefail

SERVICE="chai-shorts-media-cdn"
PROJECT="media-cdn-poc-466009"
EXPECT_CC_MAXAGE="2592000"

green()  { printf '\033[32m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }
bold()   { printf '\033[1m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

strip_params() { printf '%s' "${1%%\?*}"; }
base_dir()     { local u; u="$(strip_params "$1")"; printf '%s' "${u%/*}"; }

resolve() {
  local parent="$1" uri="$2"
  case "$uri" in
    http://*|https://*) printf '%s' "$uri" ;;
    /*)                 local host="${parent#*://}"; host="${host%%/*}"
                        printf '%s://%s%s' "${parent%%://*}" "$host" "$uri" ;;
    *)                  printf '%s/%s' "$(base_dir "$parent")" "$uri" ;;
  esac
}

httpcode() {
  local url="$1" mode="${2:-full}"
  if [ "$mode" = "range" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 25 -r 0-99 "$url" 2>/dev/null || echo "000"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$url" 2>/dev/null || echo "000"
  fi
}

ok_code()  { case "$1" in 200|206) return 0 ;; *) return 1 ;; esac; }

extract_uris() {
  awk '
    /^#/ { if (match($0, /URI="[^"]+"/)) { print substr($0, RSTART+5, RLENGTH-6) } next }
    NF   { print $0 }
  '
}

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); green "  PASS $1"; }
fail() { FAIL=$((FAIL+1)); red   "  FAIL $1"; }

MASTER="${1:-}"
if [ -z "$MASTER" ]; then
  red "Usage: $0 \"<signed combined master .m3u8 URL>\""; exit 2
fi
case "$MASTER" in *Signature=*) : ;; *)
  yellow "WARNING: URL has no Signature= — pass the SIGNED master from Mongo."; ;;
esac

# --- Config check ---
bold "== CDN edge config =="
DESC="$(gcloud edge-cache services describe "$SERVICE" --project="$PROJECT" \
  --format="yaml(edgeSslCertificates,routing.pathMatchers[0].routeRules[].routeAction.cdnPolicy.signedRequestMode)" 2>/dev/null)"
if [ -z "$DESC" ]; then
  fail "could not read CDN config (gcloud auth/project/service?)"
else
  echo "$DESC"
  printf '%s\n' "$DESC" | grep -q 'edgeSslCertificates:' && pass "edgeSslCertificates present" || fail "edgeSslCertificates MISSING"
  printf '%s\n' "$DESC" | grep -q 'REQUIRE_SIGNATURES' && pass "at least one route REQUIRE_SIGNATURES" || fail "no REQUIRE_SIGNATURES route"
fi
echo

# --- G1: signed master 200 + cache headers + cache hit on repeat ---
bold "== G1: signed master =="
CODE="$(httpcode "$MASTER")"
HDRS="$(curl -sI --max-time 25 "$MASTER" 2>/dev/null)"
CC="$(printf '%s\n' "$HDRS" | grep -i '^cache-control:' | tr -d '\r')"
ok_code "$CODE" && pass "signed master $CODE" || fail "signed master $CODE (want 200)"
printf '%s\n' "$CC" | grep -qi "max-age=$EXPECT_CC_MAXAGE" && pass "Cache-Control $CC" || fail "Cache-Control '$CC' (want max-age=$EXPECT_CC_MAXAGE)"
printf '%s\n' "$CC" | grep -qi 'no-store' && fail "Cache-Control has no-store" || pass "no no-store"
curl -sI --max-time 25 "$MASTER" >/dev/null 2>&1
HIT="$(curl -sI --max-time 25 "$MASTER" 2>/dev/null | grep -i '^x-cache-status:' | tr -d '\r')"
printf '%s\n' "$HIT" | grep -qi 'hit' && pass "$HIT" || yellow "  (cache not hit yet: '$HIT' — retry after warm)"
echo

# --- G2: stripped master -> 403 ---
bold "== G2: token stripped =="
CODE="$(httpcode "$(strip_params "$MASTER")")"
[ "$CODE" = "403" ] && pass "stripped master 403" || fail "stripped master $CODE (want 403)"
echo

# --- G3: tampered signature -> 403 ---
bold "== G3: signature altered =="
# flip the last char of the Signature value
TAMPER="$(printf '%s' "$MASTER" | sed -E 's/(Signature=[^&]*)(.)($|&)/\1X\3/')"
if [ "$TAMPER" = "$MASTER" ]; then yellow "  (could not alter Signature — check URL)"; else
  CODE="$(httpcode "$TAMPER")"
  [ "$CODE" = "403" ] && pass "tampered master 403" || fail "tampered master $CODE (want 403)"
fi
echo

# --- G4: children + segments with NO token -> 200/206 ---
bold "== G4: children + segments, NO token (must stay open) =="
TMP="$(mktemp -d "${TMPDIR:-/tmp}/combverify.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
curl -s --max-time 25 "$MASTER" > "$TMP/master.m3u8"
[ -s "$TMP/master.m3u8" ] || { fail "could not download signed master body"; }
extract_uris < "$TMP/master.m3u8" | grep -E '\.m3u8' > "$TMP/children.txt" || true
while IFS= read -r uri; do
  [ -n "$uri" ] || continue
  child_abs="$(resolve "$MASTER" "$uri")"
  child_clean="$(strip_params "$child_abs")"
  c="$(httpcode "$child_clean")"
  short="${child_clean##*/}"
  ok_code "$c" && pass "child $c $short (no token)" || fail "child $c $short (403 => matcher too broad!)"
  # sample one segment from this child, no token
  curl -s --max-time 25 "$child_clean" > "$TMP/child.m3u8" 2>/dev/null
  seg="$(extract_uris < "$TMP/child.m3u8" | grep -E '\.m4s|\.ts|\.mp4|\.vtt' | head -1)"
  [ -n "$seg" ] || continue
  seg_clean="$(strip_params "$(resolve "$child_clean" "$seg")")"
  sc="$(httpcode "$seg_clean" range)"
  ok_code "$sc" && pass "segment $sc ${seg_clean##*/} (no token)" || fail "segment $sc ${seg_clean##*/} (403 => matcher too broad!)"
done < "$TMP/children.txt"
echo

bold "== Verdict =="
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  green "All gates green — signed master enforced, children/segments open."
else
  red "$FAIL check(s) failed — do NOT proceed to catalog-wide flip; roll back if a canary."
  exit 1
fi
