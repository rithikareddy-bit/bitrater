import { NextResponse } from 'next/server';
import { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getS3, verifyUploadToken, publicS3Url } from '@/lib/uploadConfig';

export async function POST(request) {
  try {
    const body = await request.json();
    const t = verifyUploadToken(body.uploadToken);
    if (!t) return NextResponse.json({ error: 'invalid uploadToken' }, { status: 401 });

    const parts = Array.isArray(body.parts) ? [...body.parts] : [];
    if (parts.length === 0) return NextResponse.json({ error: 'parts required' }, { status: 400 });
    parts.sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));
    for (const p of parts) {
      if (!Number.isInteger(Number(p.PartNumber)) || !p.ETag) {
        return NextResponse.json({ error: 'each part needs PartNumber and ETag' }, { status: 400 });
      }
    }

    const s3 = getS3();
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: t.bucket,
      Key: t.key,
      UploadId: t.uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: Number(p.PartNumber), ETag: p.ETag })) },
    }));
    const finalUrl = publicS3Url(t.key);

    return NextResponse.json({
      url: finalUrl,
      key: t.key,
      bucket: t.bucket,
      slug: t.slug,
      episodeNumber: t.episodeNumber,
    });
  } catch (err) {
    console.error('[POST /api/uploads/complete]', err);
    return NextResponse.json({ error: err.message || 'complete failed' }, { status: 500 });
  }
}
