import { NextResponse } from 'next/server';
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import {
  getS3, UPLOAD_BUCKET, PART_SIZE, signUploadToken, buildEpisodeKey, sanitizeSlug, contentTypeFor,
} from '@/lib/uploadConfig';
import { getProdShowcase, findEpisode } from '@/lib/uploadMongo';
import { UPLOAD_PROVIDER } from '@/lib/config';
import { AZURE_ACCOUNT, AZURE_CONTAINER } from '@/lib/blobUpload';

export async function POST(request) {
  try {
    const body = await request.json();
    const slug = sanitizeSlug(body.slug);
    const episodeNumber = Number(body.episodeNumber);
    const fileName = String(body.fileName || '');
    const fileSize = Number(body.fileSize || 0);

    if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
    if (!Number.isFinite(episodeNumber)) return NextResponse.json({ error: 'episodeNumber required' }, { status: 400 });
    if (!fileName) return NextResponse.json({ error: 'fileName required' }, { status: 400 });
    if (!Number.isFinite(fileSize) || fileSize <= 0) return NextResponse.json({ error: 'fileSize required' }, { status: 400 });

    const col = await getProdShowcase();
    const show = await col.findOne({ slug }, { projection: { slug: 1, episodes: 1 } });
    if (!show) return NextResponse.json({ error: `show not found for slug=${slug}` }, { status: 404 });

    const { idx, episode } = findEpisode(show, episodeNumber);
    if (idx === -1) {
      return NextResponse.json({ error: `episode_number ${episodeNumber} not found on slug=${slug}` }, { status: 404 });
    }

    const key = buildEpisodeKey({ slug, episodeNumber, fileName });

    // Azure Blob: nothing to create up front; blocks are committed at complete.
    // The provider rides in the signed token so an upload always finishes where it started.
    if (UPLOAD_PROVIDER === 'azure') {
      const uploadToken = signUploadToken({
        provider: 'azure',
        slug,
        episodeNumber,
        account: AZURE_ACCOUNT,
        container: AZURE_CONTAINER,
        key,
        contentType: contentTypeFor(fileName),
        issuedAt: Date.now(),
      });
      return NextResponse.json({
        uploadToken,
        key,
        bucket: AZURE_CONTAINER,
        partSize: PART_SIZE,
        existingS3Url: episode?.s3_url || null,
      });
    }

    const s3 = getS3();
    const out = await s3.send(new CreateMultipartUploadCommand({
      Bucket: UPLOAD_BUCKET,
      Key: key,
      ContentType: contentTypeFor(fileName),
    }));

    const uploadToken = signUploadToken({
      slug,
      episodeNumber,
      bucket: UPLOAD_BUCKET,
      key,
      uploadId: out.UploadId,
      issuedAt: Date.now(),
    });

    return NextResponse.json({
      uploadToken,
      key,
      bucket: UPLOAD_BUCKET,
      partSize: PART_SIZE,
      existingS3Url: episode?.s3_url || null,
    });
  } catch (err) {
    console.error('[POST /api/uploads/init]', err);
    return NextResponse.json({ error: err.message || 'init failed' }, { status: 500 });
  }
}
