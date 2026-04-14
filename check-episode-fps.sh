#!/usr/bin/env bash
# Usage: ./check-episode-fps.sh <episode_id>
# Checks FPS, resolution, and whether the episode FPS is supported.

set -e

EPISODE_ID="${1:-}"
if [ -z "$EPISODE_ID" ]; then
  echo "Usage: $0 <episode_id>"
  exit 1
fi

# Load env vars (MONGO_URI, AWS creds)
if [ -f "$(dirname "$0")/.env.deploy" ]; then
  source "$(dirname "$0")/.env.deploy"
fi

if [ -z "$MONGO_URI" ]; then
  echo "Error: MONGO_URI not set. Run: source .env.deploy"
  exit 1
fi

echo "Looking up episode $EPISODE_ID..."

S3_URL=$(cd "$(dirname "$0")/dashboard" && node -e "
const { MongoClient } = require('mongodb');
const client = new MongoClient(process.env.MONGO_URI);
client.connect().then(() =>
  client.db('master').collection('showcache')
    .findOne({'episodes.id':'$EPISODE_ID'},{projection:{'episodes.\$':1, 'title':1}})
).then(d => {
  if (!d) { console.error('Episode not found'); process.exit(1); }
  process.stderr.write('Show: ' + (d.title||'unknown') + '\n');
  console.log(d?.episodes?.[0]?.s3_url || '');
  client.close();
}).catch(e => { console.error(e.message); process.exit(1); });
" 2>/tmp/ep_show.txt)

cat /tmp/ep_show.txt >&2

if [ -z "$S3_URL" ]; then
  echo "Error: No s3_url found for this episode."
  exit 1
fi

echo "S3 URL: $S3_URL"

# Convert HTTPS S3 URL to s3:// path for presigning
# Handles both:
#   https://s3.ap-south-2.amazonaws.com/bucket/key  (path-style)
#   https://bucket.s3.ap-south-2.amazonaws.com/key  (virtual-hosted)
if echo "$S3_URL" | grep -q "s3\.ap-south-2\.amazonaws\.com/"; then
  if echo "$S3_URL" | grep -q "^https://s3\."; then
    # path-style
    S3_PATH=$(echo "$S3_URL" | sed 's|https://s3\.[^/]*/|s3://|')
  else
    # virtual-hosted
    BUCKET=$(echo "$S3_URL" | sed 's|https://\([^.]*\)\.s3.*|\1|')
    KEY=$(echo "$S3_URL" | sed 's|https://[^/]*/||')
    S3_PATH="s3://$BUCKET/$KEY"
  fi
else
  echo "Warning: Unrecognised S3 URL format. Trying direct ffprobe..."
  S3_PATH=""
fi

if [ -n "$S3_PATH" ]; then
  echo "Generating presigned URL..."
  PRESIGNED=$(aws s3 presign "$S3_PATH" --region ap-south-2 --expires-in 120 2>/dev/null)
else
  PRESIGNED="$S3_URL"
fi

echo ""
echo "=== Video Info ==="
RESULT=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate \
  -of json "$PRESIGNED" 2>/dev/null)

echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
s = d.get('streams', [{}])[0]
w = s.get('width', '?')
h = s.get('height', '?')
fps_raw = s.get('r_frame_rate', '?')

from fractions import Fraction
try:
    fps = float(Fraction(fps_raw))
except:
    fps = 0

print(f'Resolution : {w} x {h}')
print(f'FPS        : {fps_raw} = {fps:.2f}')
print()

if fps > 0:
    print(f'✅ FPS is {fps:.2f} — supported by the worker.')
else:
    print('⚠️  Could not determine FPS.')
"
