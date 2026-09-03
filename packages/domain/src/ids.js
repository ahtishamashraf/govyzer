import { randomBytes, randomInt } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

function encodeTime(now) {
  let time = now;
  let out = '';
  for (let index = TIME_LENGTH; index > 0; index -= 1) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom() {
  const bytes = randomBytes(RANDOM_LENGTH);
  let out = '';
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    out += ENCODING[bytes[index] % 32];
  }
  return out;
}

/** Monotonic-ish, lexicographically sortable 26 character identifier (ULID layout). */
export function newId(now = Date.now()) {
  return encodeTime(now) + encodeRandom();
}

export function isId(value) {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** Human friendly code used for display pairing. Excludes easily confused characters. */
export function newPairingCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}
