import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { findEpisodeInShowcache, findTrailerInShowcase } from '@/lib/showcacheLookup';
import { resolveSourceUrl } from '@/lib/sourceUrl';
import { DB_MASTER } from '@/lib/config';

const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { episodeId } = await request.json();
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const masterDb = client.db(DB_MASTER);
    const trailerMatch = TRAILER_ID_RE.exec(episodeId);
    let s3Url;
    if (trailerMatch) {
      const [, showIdHex, key] = trailerMatch;
      const showDoc = await findTrailerInShowcase(
        masterDb,
        new ObjectId(showIdHex),
        key,
      );
      const trailer = showDoc?.trailers_playback_urls?.[0];
      s3Url = trailer?.s3Url || trailer?.s3_url;
      if (!s3Url) {
        return NextResponse.json({ error: 'No s3Url found for this trailer' }, { status: 400 });
      }
    } else {
      const showWithEp = await findEpisodeInShowcache(masterDb, episodeId);
      s3Url = showWithEp?.episodes?.[0]?.s3_url;
      if (!s3Url) {
        return NextResponse.json({ error: 'No s3_url found for this episode' }, { status: 400 });
      }
    }

    const { url: probeUrl } = await resolveSourceUrl(s3Url, { expiresIn: 120 });

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'json',
      probeUrl,
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
