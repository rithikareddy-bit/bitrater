// Test-only endpoint: per-episode H264 transcode for the test-jas show.
// Reads source from a pre-uploaded GCS path (no S3→GCS Lambda copy, avoiding
// the 15-min Lambda cap for large files). Output → public test bucket.
// Pure test path — bypasses orchestrator/SFN/Mongo writes.
//
// Upload your source first to:
//   gs://chai-q-test-public/test-jas-sources/<episode_id>.mp4
import { NextResponse } from 'next/server';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { TranscoderServiceClient } from '@google-cloud/video-transcoder';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const GCP_PROJECT = process.env.GCP_PROJECT || 'media-cdn-poc-466009';
const GCP_LOCATION = process.env.GCP_LOCATION || 'asia-south1';
const SOURCE_BUCKET = 'chai-q-test-public';
const SOURCE_PREFIX = 'test-jas-sources';
const OUTPUT_BUCKET = 'chai-q-test-public';

let _cachedClient = null;

async function getTranscoderClient() {
  if (_cachedClient) return _cachedClient;
  const secretArn = process.env.GCP_CREDENTIALS_SECRET_ARN;
  if (!secretArn) throw new Error('GCP_CREDENTIALS_SECRET_ARN not set');
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const credentials = JSON.parse(res.SecretString);
  _cachedClient = new TranscoderServiceClient({ credentials, projectId: GCP_PROJECT });
  return _cachedClient;
}

const PORTRAIT_DIMS = {
  '1080p': { width: 1080, height: 1920 },
  '720p':  { width: 720,  height: 1280 },
  '480p':  { width: 480,  height: 854  },
};
const H264_KBPS = { '1080p': 7500, '720p': 3000, '480p': 1200 };

function buildH264JobConfig(inputUri, outputUri) {
  const gopDuration = { seconds: 2 };
  const ladder = ['1080p', '720p', '480p'].map((tag) => ({
    tag,
    ...PORTRAIT_DIMS[tag],
    kbps: H264_KBPS[tag],
  }));
  const elementaryStreams = [];
  const muxStreams = [];
  const videoStreamKeys = [];
  for (const r of ladder) {
    const esKey = `${r.tag}_h264`;
    const bps = r.kbps * 1000;
    elementaryStreams.push({
      key: esKey,
      videoStream: {
        h264: {
          widthPixels: r.width,
          heightPixels: r.height,
          bitrateBps: bps,
          frameRate: 60,
          gopDuration,
          profile: 'high',
          preset: 'slower',
          tune: 'film',
          enableTwoPass: true,
          vbvSizeBits: bps * 3,
          vbvFullnessBits: Math.floor(bps * 3 * 0.9),
          aqStrength: 1.0,
          bFrameCount: 3,
        },
      },
    });
    const streamKey = `${r.tag}_h264_video`;
    muxStreams.push({
      key: streamKey,
      container: 'fmp4',
      elementaryStreams: [esKey],
      segmentSettings: { segmentDuration: gopDuration },
    });
    videoStreamKeys.push(streamKey);
  }
  elementaryStreams.push({
    key: 'audio_aac',
    audioStream: { codec: 'aac', bitrateBps: 128000, channelCount: 2, sampleRateHertz: 48000 },
  });
  muxStreams.push({
    key: 'h264_audio',
    container: 'fmp4',
    elementaryStreams: ['audio_aac'],
    segmentSettings: { segmentDuration: gopDuration },
  });
  return {
    inputs: [{ key: 'input0', uri: inputUri }],
    elementaryStreams,
    muxStreams,
    manifests: [{
      fileName: 'h264_master.m3u8',
      type: 'HLS',
      muxStreams: [...videoStreamKeys, 'h264_audio'],
    }],
    output: { uri: outputUri },
  };
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { episodeId } = body || {};
    if (!episodeId || typeof episodeId !== 'string') {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const sourceUri = `gs://${SOURCE_BUCKET}/${SOURCE_PREFIX}/${episodeId}.mp4`;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPrefix = `test-jas-h264/${episodeId}/${stamp}/`;
    const outputUri = `gs://${OUTPUT_BUCKET}/${outputPrefix}`;

    const client = await getTranscoderClient();
    const parent = client.locationPath(GCP_PROJECT, GCP_LOCATION);
    const [job] = await client.createJob({
      parent,
      job: { config: buildH264JobConfig(sourceUri, outputUri) },
    });

    const gcsUrl = `https://storage.googleapis.com/${OUTPUT_BUCKET}/${outputPrefix}h264_master.m3u8`;
    return NextResponse.json({
      episodeId,
      jobName: job.name,
      sourceUri,
      outputUri,
      gcsUrl,
      note: `URL loadable after the transcode job finishes (~minutes). If you see an error, ensure ${sourceUri} was uploaded.`,
    });
  } catch (err) {
    console.error('[POST /api/test-jas-h264]', err);
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 });
  }
}
