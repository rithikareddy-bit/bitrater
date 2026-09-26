import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';

const s3Mock = mockClient(S3Client);
beforeEach(() => s3Mock.reset());
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('@/lib/blobUpload'); vi.resetModules(); });

describe('blobUpload', () => {
  it('block ids are equal length and ordered', async () => {
    const { blockIdFor } = await import('@/lib/blobUpload');
    const ids = [1, 9, 10, 9999, 10000].map(blockIdFor);
    expect(new Set(ids.map((x) => x.length)).size).toBe(1);
    expect(Buffer.from(blockIdFor(42), 'base64').toString()).toBe('blk-000042');
  });

  it('public URL encodes each key segment', async () => {
    const { publicBlobUrl } = await import('@/lib/blobUpload');
    expect(publicBlobUrl('uploads/episodes/my-show/ep-001/1-a b.mp4'))
      .toBe('https://chaishotsblobstoredev.blob.core.windows.net/sanity-dev-store/uploads/episodes/my-show/ep-001/1-a%20b.mp4');
  });

  it('SAS is write-only, https-only, scoped to one blob, short-lived', async () => {
    vi.resetModules();
    vi.doMock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
    const real = await vi.importActual('@azure/storage-blob');
    vi.doMock('@azure/storage-blob', () => ({
      ...real,
      BlobServiceClient: class {
        async getUserDelegationKey(startsOn, expiresOn) {
          return { signedObjectId: 'o', signedTenantId: 't', signedStartsOn: startsOn, signedExpiresOn: expiresOn,
            signedService: 'b', signedVersion: '2021-08-06', value: Buffer.from('k'.repeat(32)).toString('base64') };
        }
      },
    }));
    const { signBlockUrl, blockIdFor } = await import('@/lib/blobUpload');
    const { url, blockId } = await signBlockUrl('uploads/episodes/s/ep-001/1-x.mp4', 3);
    const u = new URL(url);
    expect(blockId).toBe(blockIdFor(3));
    expect(u.pathname).toBe('/sanity-dev-store/uploads/episodes/s/ep-001/1-x.mp4');
    expect(u.searchParams.get('comp')).toBe('block');
    expect(u.searchParams.get('blockid')).toBe(blockId);
    expect(u.searchParams.get('sp')).toBe('w');
    expect(u.searchParams.get('spr')).toBe('https');
    expect(u.searchParams.get('sr')).toBe('b');
    const ttl = (new Date(u.searchParams.get('se')) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60 + 5);
    vi.doUnmock('@azure/identity'); vi.doUnmock('@azure/storage-blob');
  });
});

describe('uploads/complete', () => {
  async function post(body) {
    const { POST } = await import('@/app/api/uploads/complete/route');
    const res = await POST(new Request('http://x/api/uploads/complete', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  }

  it('S3 token: same CompleteMultipartUpload as before', async () => {
    vi.stubEnv('UPLOAD_TOKEN_SECRET', 's');
    vi.resetModules();
    const { signUploadToken } = await import('@/lib/uploadConfig');
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const uploadToken = signUploadToken({ slug: 's', episodeNumber: 1, bucket: 'sanity-dev-store', key: 'uploads/episodes/s/ep-001/1-x.mp4', uploadId: 'U' });
    const { status, json } = await post({ uploadToken, parts: [{ PartNumber: 2, ETag: 'b' }, { PartNumber: 1, ETag: 'a' }] });
    expect(status).toBe(200);
    expect(json.url).toBe('https://s3.ap-south-2.amazonaws.com/sanity-dev-store/uploads/episodes/s/ep-001/1-x.mp4');
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)[0].args[0].input).toEqual({
      Bucket: 'sanity-dev-store', Key: 'uploads/episodes/s/ep-001/1-x.mp4', UploadId: 'U',
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'a' }, { PartNumber: 2, ETag: 'b' }] },
    });
  });

  it('Azure token: commits blocks in part order, never touches S3', async () => {
    vi.stubEnv('UPLOAD_TOKEN_SECRET', 's');
    vi.resetModules();
    const commitBlocks = vi.fn(async () => {});
    vi.doMock('@/lib/blobUpload', async () => ({ ...(await vi.importActual('@/lib/blobUpload')), commitBlocks }));
    const { signUploadToken } = await import('@/lib/uploadConfig');
    const uploadToken = signUploadToken({ provider: 'azure', slug: 's', episodeNumber: 1, container: 'sanity-dev-store',
      key: 'uploads/episodes/s/ep-001/1-x.mp4', contentType: 'video/mp4' });
    const { status, json } = await post({ uploadToken, parts: [{ PartNumber: 2, BlockId: 'B' }, { PartNumber: 1, BlockId: 'A' }] });
    expect(status).toBe(200);
    expect(commitBlocks).toHaveBeenCalledWith('uploads/episodes/s/ep-001/1-x.mp4', ['A', 'B'], 'video/mp4',
      { account: undefined, container: 'sanity-dev-store' }); // target from the token (undefined -> env default)
    expect(json.url).toContain('https://chaishotsblobstoredev.blob.core.windows.net/sanity-dev-store/');
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('Azure token without BlockId is rejected', async () => {
    vi.stubEnv('UPLOAD_TOKEN_SECRET', 's');
    vi.resetModules();
    const { signUploadToken } = await import('@/lib/uploadConfig');
    const uploadToken = signUploadToken({ provider: 'azure', key: 'k' });
    const { status, json } = await post({ uploadToken, parts: [{ PartNumber: 1, ETag: 'a' }] });
    expect(status).toBe(400);
    expect(json.error).toContain('BlockId');
  });
});
