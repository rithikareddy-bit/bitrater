import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { execFile } from 'child_process';
import { promisify } from 'util';
import clientPromise from '@/lib/mongodb';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

function parseS3Url(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/^\//, '');

  if (host.startsWith('s3') && host.endsWith('.amazonaws.com')) {
    const parts = path.split('/', 1);
    const bucket = parts[0];
    const key = path.slice(bucket.length + 1);
    const segments = host.split('.');
    const region = segments.length >= 4 ? segments[1] : undefined;
    return { bucket, key, region };
  }

  const bucket = host.split('.s3')[0];
  const key = path;
  const match = host.match(/\.s3\.([^.]+)\./);
  const region = match ? match[1] : undefined;
  return { bucket, key, region };
}

export async function POST(request) {
  try {
    const { episodeId } = await request.json();
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const masterDb = client.db('master');
    const showWithEp = await masterDb.collection('showcache').findOne(
      { 'episodes.id': episodeId },
      { projection: { 'episodes.$': 1 } },
    );
    const s3Url = showWithEp?.episodes?.[0]?.s3_url;
    if (!s3Url) {
      return NextResponse.json({ error: 'No s3_url found for this episode' }, { status: 400 });
    }

    const { bucket, key, region } = parseS3Url(s3Url);
    const s3 = new S3Client({ region: region || process.env.AWS_REGION || 'ap-south-2' });
    const presigned = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 120 });

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'json',
      presigned,
    ], { timeout: 30000 });

    const data = JSON.parse(stdout);
    const stream = (data.streams || [])[0] || {};
    const width = stream.width || null;
    const height = stream.height || null;
    const fpsRaw = stream.r_frame_rate || null;

    let fpsExact = null;
    if (fpsRaw && fpsRaw.includes('/')) {
      const [num, den] = fpsRaw.split('/').map(Number);
      fpsExact = den ? num / den : null;
    } else if (fpsRaw) {
      fpsExact = Number(fpsRaw);
    }

    const supported = fpsExact !== null && fpsExact > 0;

    return NextResponse.json({
      width,
      height,
      fps: fpsExact != null ? parseFloat(fpsExact.toFixed(4)) : null,
      fps_raw: fpsRaw,
      supported,
    });
  } catch (err) {
    console.error('[POST /api/probe-source]', err);
    return NextResponse.json({ error: err.message || 'Failed to probe source video' }, { status: 500 });
  }
}
