// Azure Blob side of the Upload Videos flow (UPLOAD_PROVIDER=azure).
//
// Same browser-direct, resumable shape as S3 multipart: the server mints a
// short-lived user-delegation SAS per block (write-only, one blob), the browser
// PUTs each block, and complete commits the block list. Uses the Container
// App's managed identity (Storage Blob Data Contributor + Delegator on the
// target account). Loaded lazily so the S3 path never imports the Azure SDK.
import { PRESIGN_TTL } from '@/lib/uploadConfig';

export const AZURE_ACCOUNT = process.env.UPLOAD_AZURE_ACCOUNT || 'chaishotsblobstoredev';
export const AZURE_CONTAINER = process.env.UPLOAD_AZURE_CONTAINER || 'sanity-dev-store';

const services = new Map(); // account -> BlobServiceClient
const delegationKeys = new Map(); // account -> { key, expiresOn }

async function sdk() {
  return import('@azure/storage-blob');
}

async function blobService(account) {
  if (!services.has(account)) {
    const { BlobServiceClient } = await sdk();
    const { DefaultAzureCredential } = await import('@azure/identity');
    services.set(account, new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential()));
  }
  return services.get(account);
}

// Reuse a delegation key only while it outlives any SAS signed now (PRESIGN_TTL) by
// 5 min; a SAS stops working when its delegation key expires.
async function userDelegationKey(account) {
  const now = Date.now();
  const cached = delegationKeys.get(account);
  if (!cached || cached.expiresOn - now < (PRESIGN_TTL + 5 * 60) * 1000) {
    const expiresOn = new Date(now + 60 * 60 * 1000);
    const key = await (await blobService(account)).getUserDelegationKey(new Date(now - 5 * 60 * 1000), expiresOn);
    delegationKeys.set(account, { key, expiresOn: expiresOn.getTime() });
  }
  return delegationKeys.get(account).key;
}

// Equal-length ids are required within one blob; 10000-part ceiling like S3.
export function blockIdFor(partNumber) {
  return Buffer.from(`blk-${String(partNumber).padStart(6, '0')}`).toString('base64');
}

// `target` = { account, container } from the signed upload token (defaults: env).
export function publicBlobUrl(key, { account = AZURE_ACCOUNT, container = AZURE_CONTAINER } = {}) {
  return `https://${account}.blob.core.windows.net/${container}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function signBlockUrl(key, partNumber, { account = AZURE_ACCOUNT, container = AZURE_CONTAINER } = {}) {
  const { generateBlobSASQueryParameters, BlobSASPermissions, SASProtocol } = await sdk();
  const blockId = blockIdFor(partNumber);
  const now = Date.now();
  const sas = generateBlobSASQueryParameters({
    containerName: container,
    blobName: key,
    permissions: BlobSASPermissions.parse('w'),
    startsOn: new Date(now - 5 * 60 * 1000),
    expiresOn: new Date(now + PRESIGN_TTL * 1000),
    protocol: SASProtocol.Https,
  }, await userDelegationKey(account), account).toString();
  const url = `${publicBlobUrl(key, { account, container })}?comp=block&blockid=${encodeURIComponent(blockId)}&${sas}`;
  return { url, blockId };
}

export async function commitBlocks(key, blockIds, contentType, { account = AZURE_ACCOUNT, container = AZURE_CONTAINER } = {}) {
  const blob = (await blobService(account)).getContainerClient(container).getBlockBlobClient(key);
  await blob.commitBlockList(blockIds, { blobHTTPHeaders: { blobContentType: contentType } });
}
