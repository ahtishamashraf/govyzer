import jwt from 'jsonwebtoken';
import { loadServerConfig } from '@govyzer/config';
import { sha256, randomToken } from './crypto.js';

const ISSUER = 'govyzer-api';

export function signAccessToken({ userId, organizationId, membershipId, sessionId, isPlatformAdmin = false }) {
  const { env } = loadServerConfig();
  return jwt.sign(
    {
      sub: userId,
      org: organizationId ?? null,
      mem: membershipId ?? null,
      sid: sessionId,
      pa: isPlatformAdmin,
      typ: 'access',
    },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL_SECONDS, issuer: ISSUER, algorithm: 'HS256' }
  );
}

export function verifyAccessToken(token) {
  const { env } = loadServerConfig();
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER, algorithms: ['HS256'] });
}

/** Refresh tokens are opaque; only their hash is stored so a database leak is not a login. */
export function createRefreshToken() {
  const token = randomToken(48);
  return { token, hash: sha256(token) };
}

export function signDisplayToken({ displayId, organizationId, sessionId }) {
  const { env } = loadServerConfig();
  return jwt.sign(
    { sub: displayId, org: organizationId, sid: sessionId, typ: 'display' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: '30d', issuer: ISSUER, algorithm: 'HS256' }
  );
}

export function verifyDisplayToken(token) {
  const payload = jwt.verify(token, loadServerConfig().env.JWT_ACCESS_SECRET, {
    issuer: ISSUER,
    algorithms: ['HS256'],
  });
  if (payload.typ !== 'display') throw new Error('Not a display token');
  return payload;
}
