import { NextResponse } from 'next/server';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3, verifyUploadToken, PRESIGN_TTL } from '@/lib/uploadConfig';
import { signBlockUrl } from '@/lib/blobUpload';

export async function POST(request) {
  try {
    const { uploadToken, partNumber } = await request.json();
    const t = verifyUploadToken(uploadToken);
    if (!t) return NextResponse.json({ error: 'invalid uploadToken' }, { status: 401 });

    const n = Number(partNumber);
    if (!Number.isInteger(n) || n < 1 || n > 10000) {
      return NextResponse.json({ error: 'partNumber must be 1..10000' }, { status: 400 });
    }

    if (t.provider === 'azure') {
      const { url, blockId } = await signBlockUrl(t.key, n, { account: t.account, container: t.container });
      return NextResponse.json({ url, blockId, partNumber: n, expiresIn: PRESIGN_TTL });
    }

    const cmd = new UploadPartCommand({
      Bucket: t.bucket,
      Key: t.key,
      UploadId: t.uploadId,
      PartNumber: n,
    });
    const url = await getSignedUrl(getS3(), cmd, { expiresIn: PRESIGN_TTL });
    return NextResponse.json({ url, partNumber: n, expiresIn: PRESIGN_TTL });
  } catch (err) {
    console.error('[POST /api/uploads/sign-part]', err);
    return NextResponse.json({ error: err.message || 'sign failed' }, { status: 500 });
  }
}
