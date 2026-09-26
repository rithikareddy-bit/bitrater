import { NextResponse } from 'next/server';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getS3, verifyUploadToken } from '@/lib/uploadConfig';

async function handle(request) {
  try {
    const text = await request.text();
    const body = text ? JSON.parse(text) : {};
    const t = verifyUploadToken(body.uploadToken);
    if (!t) return NextResponse.json({ error: 'invalid uploadToken' }, { status: 401 });
    // Azure: uncommitted blocks are garbage-collected by the service after 7 days.
    if (t.provider === 'azure') return NextResponse.json({ ok: true });
    await getS3().send(new AbortMultipartUploadCommand({
      Bucket: t.bucket, Key: t.key, UploadId: t.uploadId,
    }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/uploads/abort]', err);
    return NextResponse.json({ error: err.message || 'abort failed' }, { status: 500 });
  }
}

export const POST = handle;
