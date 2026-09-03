import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { loadServerConfig } from '@govyzer/config';

const ALGORITHM = 'aes-256-gcm';

let keyCache = null;

/** Parses `v1:<base64>,v2:<base64>` into a version -> key buffer map. */
function loadKeys() {
  if (keyCache) return keyCache;
  const { env } = loadServerConfig();
  const entries = env.ENCRYPTION_KEYS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [version, material] = entry.split(':');
      if (!version || !material) throw new Error('ENCRYPTION_KEYS entries must look like v1:<base64 key>');
      const key = Buffer.from(material, 'base64');
      if (key.length !== 32) throw new Error(`Encryption key ${version} must decode to 32 bytes`);
      return [version, key];
    });

  if (entries.length === 0) {
    throw new Error('ENCRYPTION_KEYS is not configured; third-party credentials cannot be stored');
  }
  keyCache = { keys: new Map(entries), active: env.ENCRYPTION_ACTIVE_KEY };
  if (!keyCache.keys.has(keyCache.active)) {
    throw new Error(`ENCRYPTION_ACTIVE_KEY ${keyCache.active} is not present in ENCRYPTION_KEYS`);
  }
  return keyCache;
}

export function resetKeyCache() {
  keyCache = null;
}

export function encryptSecret(plaintext) {
  const { keys, active } = loadKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keys.get(active), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    key_version: active,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret({ key_version: keyVersion, ciphertext, iv, auth_tag: authTag }) {
  const { keys } = loadKeys();
  const key = keys.get(keyVersion);
  if (!key) throw new Error(`Encryption key version ${keyVersion} is not available`);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptJson(value) {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson(record) {
  return JSON.parse(decryptSecret(record));
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}
