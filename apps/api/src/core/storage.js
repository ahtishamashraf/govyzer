import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadServerConfig } from '@govyzer/config';
import { ValidationError } from '@govyzer/domain';

let client = null;

function s3() {
  if (client) return client;
  const { env } = loadServerConfig();
  client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
      : {}),
  });
  return client;
}

const ALLOWED_MIME = new Map([
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/png', ['png']],
  ['image/webp', ['webp']],
  ['image/gif', ['gif']],
  ['video/mp4', ['mp4']],
  ['video/quicktime', ['mov']],
  ['application/pdf', ['pdf']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx']],
  ['text/csv', ['csv']],
]);

/** Magic byte prefixes used to confirm a file really is what its MIME type claims. */
const MAGIC_BYTES = new Map([
  ['image/jpeg', [[0xff, 0xd8, 0xff]]],
  ['image/png', [[0x89, 0x50, 0x4e, 0x47]]],
  ['image/gif', [[0x47, 0x49, 0x46, 0x38]]],
  ['application/pdf', [[0x25, 0x50, 0x44, 0x46]]],
  ['image/webp', [[0x52, 0x49, 0x46, 0x46]]],
]);

export function validateUpload({ fileName, mimeType, sizeBytes }) {
  const { env } = loadServerConfig();
  const extension = String(fileName).split('.').pop()?.toLowerCase() ?? '';
  const allowedExtensions = ALLOWED_MIME.get(mimeType);

  if (!allowedExtensions) {
    throw new ValidationError(`File type ${mimeType} is not allowed`, [{ path: 'mime_type', message: 'Unsupported file type' }]);
  }
  if (!allowedExtensions.includes(extension)) {
    throw new ValidationError(`File extension .${extension} does not match ${mimeType}`, [
      { path: 'file_name', message: 'Extension does not match the declared type' },
    ]);
  }
  if (Number(sizeBytes) > env.S3_MAX_UPLOAD_BYTES) {
    throw new ValidationError(`File exceeds the ${Math.round(env.S3_MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`, [
      { path: 'size_bytes', message: 'File is too large' },
    ]);
  }
  return true;
}

export function verifyMagicBytes(mimeType, buffer) {
  const signatures = MAGIC_BYTES.get(mimeType);
  if (!signatures) return true;
  return signatures.some((signature) => signature.every((byte, index) => buffer[index] === byte));
}

/** Tenant prefixed key; buckets are private and objects are served through signed URLs. */
export function buildStorageKey({ organizationId, entityType, entityId, fileName }) {
  const safeName = String(fileName).replace(/[^\w.-]/g, '_').slice(-120);
  return `tenants/${organizationId}/${entityType}/${entityId}/${Date.now()}-${safeName}`;
}

export async function createUploadUrl({ key, mimeType, sizeBytes }) {
  const { env } = loadServerConfig();
  if (!env.S3_BUCKET) throw new ValidationError('S3 storage is not configured');
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: mimeType,
    ContentLength: sizeBytes ? Number(sizeBytes) : undefined,
  });
  const url = await getSignedUrl(s3(), command, { expiresIn: env.S3_SIGNED_URL_TTL_SECONDS });
  return { url, method: 'PUT', headers: { 'content-type': mimeType }, expires_in: env.S3_SIGNED_URL_TTL_SECONDS };
}

export async function createDownloadUrl(key, { expiresIn = null, fileName = null } = {}) {
  const { env } = loadServerConfig();
  if (!env.S3_BUCKET) return null;
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ...(fileName ? { ResponseContentDisposition: `attachment; filename="${fileName}"` } : {}),
  });
  return getSignedUrl(s3(), command, { expiresIn: expiresIn ?? env.S3_SIGNED_URL_TTL_SECONDS });
}

export async function putObject(key, body, contentType) {
  const { env } = loadServerConfig();
  if (!env.S3_BUCKET) throw new ValidationError('S3 storage is not configured');
  await s3().send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function headObject(key) {
  const { env } = loadServerConfig();
  return s3().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export async function deleteObject(key) {
  const { env } = loadServerConfig();
  await s3().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export function isStorageConfigured() {
  return Boolean(loadServerConfig().env.S3_BUCKET);
}
